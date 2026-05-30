import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getThreads, getThread, OPEN_SIGNAL, DONE_SIGNAL, extractFieldBrain } from "../../lib/brain.js";
import { runConsolidationIfDue } from "../../lib/consolidate.js";
import { git } from "../utils.js";

export function registerWikiRecall(server: McpServer): void {
  server.tool(
    "wiki_recall",
    "새 대화가 시작되면 반드시 첫 번째로 호출. 미완료 스레드를 우선 표면화해 '어제 X 작업 중이었는데 이어서 할까요?' 형태로 컨텍스트를 복원한다. 마크다운 텍스트 반환.",
    {
      limit: z.number().int().min(1).max(20).optional().default(5).describe("반환할 스레드 수"),
    },
    async ({ limit }) => {
      try {
        const threads = await getThreads();
        runConsolidationIfDue(threads).catch(() => {}); // fire-and-forget, unhandled rejection 방지
        const candidates = threads.slice(0, Math.max(limit * 10, 50));

        // Use manifest-cached signal fields where available; fall back to file reads only for uncached
        const uncachedIdx = candidates
          .map((t, i) => (t.is_open === undefined ? i : -1))
          .filter((i) => i >= 0);

        const fileContents = new Map<string, string>();
        if (uncachedIdx.length > 0) {
          const reads = await Promise.all(uncachedIdx.map((i) => getThread(candidates[i].id)));
          uncachedIdx.forEach((candIdx, readIdx) => {
            const c = reads[readIdx];
            if (c) fileContents.set(candidates[candIdx].id, c);
          });
        }

        type RecallEntry = {
          threadId: string;
          title: string;
          status: "active" | "stale" | "done";
          gap_hours: number | null;
          capture_count: number;
          last_action: string;
          is_open: boolean;
          next_action: string;
          blocker: string;
        };

        const enriched: RecallEntry[] = candidates
          .map((t) => {
            let is_open: boolean;
            let last_action: string;
            let capture_count: number;
            let next_action: string;
            let blocker: string;

            if (t.is_open !== undefined && t.last_action !== undefined && t.capture_count !== undefined) {
              // Fast path: use manifest cache
              is_open = t.is_open;
              last_action = t.last_action;
              capture_count = t.capture_count;
              // Use stored next_action/blocker from manifest if available
              next_action = t.next_action ?? "";
              blocker = t.blocker ?? "";
              const is_done = t.is_done !== undefined ? t.is_done : (DONE_SIGNAL.test(last_action) && !is_open);
              const gapHours = isNaN(new Date(t.updatedAt).getTime())
                ? null
                : Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 3600000);
              return {
                threadId: t.id,
                title: t.title,
                status: (is_done ? "done" : (gapHours === null || gapHours > 48) ? "stale" : "active") as RecallEntry["status"],
                gap_hours: gapHours,
                capture_count,
                last_action,
                is_open,
                next_action,
                blocker,
              };
            }

            // Slow path: file read fallback (legacy manifest entries)
            const content = fileContents.get(t.id);
            if (!content) return null;

            const titleMatch = content.match(/^#\s+(.+)$/m);
            const title = (titleMatch?.[1] ?? t.id).trim();

            const captures = content.split(/\n---\n/).slice(1).filter((p) => p.trim());
            const lastCapture = captures.at(-1) ?? "";
            const fullText = lastCapture.replace(/^(?:_[^_\n]+_|\*\*[^*\n]+\*\*)\s*/m, "").trim();
            is_open = OPEN_SIGNAL.test(fullText);
            const isDone = DONE_SIGNAL.test(fullText) && !is_open;
            last_action = fullText.replace(/\n+/g, " ").slice(0, 160);
            next_action = extractFieldBrain(fullText, "다음할것").slice(0, 120);
            blocker = extractFieldBrain(fullText, "막힌것").slice(0, 120);
            capture_count = captures.length;

            const gapHours = isNaN(new Date(t.updatedAt).getTime())
              ? null
              : Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 3600000);

            return {
              threadId: t.id,
              title,
              status: (isDone ? "done" : (gapHours === null || gapHours > 48) ? "stale" : "active") as RecallEntry["status"],
              gap_hours: gapHours,
              capture_count,
              last_action,
              is_open,
              next_action,
              blocker,
            };
          })
          .filter((x): x is RecallEntry => x !== null)
          .filter((x) => x.capture_count > 0);

        // 순차 게이트: 중복 없이 정렬 (Set으로 추적)
        const seen = new Set<string>();
        const addUniq = (entries: RecallEntry[]) =>
          entries.filter((t) => { if (seen.has(t.threadId)) return false; seen.add(t.threadId); return true; });

        // open이 stale보다 중요 — 잊고 있던 미완료 태스크가 최우선
        const sorted = [
          ...addUniq(enriched.filter((t) => t.is_open && t.status === "active")),
          ...addUniq(enriched.filter((t) => t.is_open && t.status === "stale")),
          ...addUniq(enriched.filter((t) => !t.is_open && t.status === "active")),
          ...addUniq(enriched.filter((t) => !t.is_open && t.status === "stale")),
          ...addUniq(enriched.filter((t) => t.status === "done")),
        ].slice(0, limit);

        // 콜드 스타트: 스레드 없으면 git 히스토리에서 컨텍스트 시드
        if (sorted.length === 0) {
          try {
            const [log, status, branch] = await Promise.all([
              git("log", "--oneline", "-8", "--format=%h %s (%ar)"),
              git("status", "--short"),
              git("branch", "--show-current"),
            ]);

            const gitContext = [
              branch ? `브랜치: ${branch}` : "",
              log ? `최근 커밋:\n${log}` : "",
              status ? `미완성 파일:\n${status}` : "",
            ].filter(Boolean).join("\n\n");

            if (gitContext) {
              return {
                content: [{
                  type: "text",
                  text: `## Second Brain 복원\n저장된 스레드 없음. Git 히스토리에서 컨텍스트를 가져왔어.\n\n${gitContext}\n\n---\nwiki_setup으로 지금 작업을 등록하거나, wiki_dump로 바로 던져봐.`,
                }],
              };
            }
          } catch {
            // git 없는 환경
          }
        }

        if (sorted.length === 0) {
          const hint = threads.length === 0
            ? "저장된 스레드 없음. wiki_setup이나 wiki_dump로 첫 생각을 던져봐."
            : "최근 활동 없음. 모든 스레드가 완료되었거나 오래됨.";
          return { content: [{ type: "text", text: hint }] };
        }

        const statusIcon = (t: RecallEntry) =>
          t.status === "done" ? "✅" : t.is_open ? "🔴" : t.status === "active" ? "🟡" : "⬜";
        const gapLabel = (h: number | null) =>
          h === null ? "" : h < 1 ? "방금 전" : h < 18 ? `${h}시간 전` : h < 36 ? "어제" : `${Math.floor(h / 24)}일 전`;

        const lines: string[] = [];

        // Lead entry — the most important thread, formatted as a direct question
        const top = sorted[0];
        const others = sorted.slice(1);

        // Lead section header
        if (top.is_open) {
          lines.push("## 어제 멈춘 곳\n");
        } else {
          lines.push("## Second Brain 복원\n");
        }

        // Top thread — blockquote style for visual prominence
        const topGap = gapLabel(top.gap_hours);
        lines.push(`> ${statusIcon(top)} **${top.title}**${topGap ? ` — ${topGap}` : ""}`);

        // Show 다음할것 if available, otherwise last_action
        const topNext = top.next_action || (top.last_action ? top.last_action.replace(/^(?:결정|가설|막힌것|다음할것|블로커|요약)\s*:\s*/i, "").slice(0, 100) : "");
        if (topNext) lines.push(`> → 다음: ${topNext}`);

        // Show 막힌것 prominently if present
        if (top.blocker) lines.push(`> ⛔ 막힌것: ${top.blocker}`);

        // Call to action
        if (top.is_open) {
          lines.push(`>`);
          lines.push(`> 이어서 갈까? (thread: \`${top.threadId}\`)`);
        } else {
          lines.push(`>`);
          lines.push(`> thread: \`${top.threadId}\``);
        }

        // Stale-open threads the user has forgotten — flag them separately
        const forgottenThreads = others.filter(t => t.is_open && t.status === "stale");
        const activeOthers = others.filter(t => !(t.is_open && t.status === "stale"));

        if (forgottenThreads.length > 0) {
          lines.push("\n---");
          lines.push("## 📌 잊고 있던 거 (열려있는데 오랫동안 못 봄)");
          for (const t of forgottenThreads) {
            const gap = gapLabel(t.gap_hours);
            const preview = t.next_action || t.last_action?.replace(/^(?:결정|가설|막힌것|다음할것|블로커|요약)\s*:\s*/i, "").slice(0, 80) || "";
            const blockerHint = t.blocker ? ` ⛔ ${t.blocker.slice(0, 60)}` : "";
            lines.push(`🔴 **${t.title}**${gap ? ` (${gap})` : ""}${blockerHint}`);
            if (preview) lines.push(`   → ${preview}`);
            lines.push(`   thread: \`${t.threadId}\``);
          }
        }

        if (activeOthers.length > 0) {
          lines.push("\n---");
          lines.push("다른 작업:");
          for (const t of activeOthers) {
            const gap = gapLabel(t.gap_hours);
            const preview = t.next_action || t.last_action?.replace(/^(?:결정|가설|막힌것|다음할것|블로커|요약)\s*:\s*/i, "").slice(0, 80) || "";
            const blockerHint = t.blocker ? ` ⛔` : "";
            lines.push(`${statusIcon(t)} **${t.title}**${gap ? ` (${gap})` : ""}${blockerHint}${preview ? ` → ${preview}` : ""}`);
            lines.push(`   thread: \`${t.threadId}\``);
          }
        }

        lines.push("\n---");
        if (top.is_open) {
          lines.push(`이어서 가려면: "ㅇㅇ" 또는 \`wiki_dump({ threadId: "${top.threadId}", content: "..." })\``);
        } else {
          lines.push("이어붙이기: `wiki_dump({ threadId: \"...\", content: \"...\" })`");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
