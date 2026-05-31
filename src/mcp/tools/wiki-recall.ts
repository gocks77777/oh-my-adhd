import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getThreads, getThread, DONE_SIGNAL, parseLastCapture, updateManifestEntry, type Thread } from "../../lib/brain.js";
import { runConsolidationIfDue } from "../../lib/consolidate.js";
import { git } from "../utils.js";

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

const GHOST_THRESHOLD_H = 336; // 2 weeks

function gapHoursFor(updatedAt: string): number | null {
  return isNaN(new Date(updatedAt).getTime())
    ? null
    : Math.max(0, Math.round((Date.now() - new Date(updatedAt).getTime()) / 3600000));
}

// 신호 추출: 매니페스트 캐시(fast path) 또는 파일 내용(slow path)에서 RecallEntry 생성.
// slow path일 때는 매니페스트를 백필한다.
function enrich(t: Thread, content: string | undefined): RecallEntry | null {
  if (t.is_open != null && t.last_action != null && t.capture_count != null) {
    // Fast path: use manifest cache
    const is_open = t.is_open;
    const last_action = t.last_action;
    const capture_count = t.capture_count;
    const next_action = t.next_action ?? "";
    const blocker = t.blocker ?? "";
    const is_done = t.is_done !== undefined ? t.is_done : DONE_SIGNAL.test(last_action);
    const gapHours = gapHoursFor(t.updatedAt);
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
  if (!content) return null;

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = (titleMatch?.[1] ?? t.id).trim();

  const sig = parseLastCapture(content);
  const is_open = sig.is_open;
  const isDone = sig.is_done;
  const last_action = sig.last_action;
  const next_action = sig.next_action;
  const blocker = sig.blocker;
  const capture_count = sig.capture_count;

  const gapHours = gapHoursFor(t.updatedAt);

  // Back-fill manifest cache so stop hook sees correct is_open next time
  updateManifestEntry(t.id, {
    is_open,
    is_done: isDone,
    capture_count,
    last_action: last_action.slice(0, 160),
    next_action: next_action || undefined,
    blocker: blocker || undefined,
    title,
  }).catch(() => {});

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
}

// 정렬 로직: open active > open stale > closed active > closed stale > done.
// 잊고 있던 미완료 태스크가 최우선. 중복은 Set으로 제거.
function prioritize(entries: RecallEntry[], limit: number): RecallEntry[] {
  const seen = new Set<string>();
  const addUniq = (es: RecallEntry[]) =>
    es.filter((t) => { if (seen.has(t.threadId)) return false; seen.add(t.threadId); return true; });

  return [
    ...addUniq(entries.filter((t) => t.is_open && t.status === "active")),
    ...addUniq(entries.filter((t) => t.is_open && t.status === "stale")),
    ...addUniq(entries.filter((t) => !t.is_open && t.status === "active")),
    ...addUniq(entries.filter((t) => !t.is_open && t.status === "stale")),
    ...addUniq(entries.filter((t) => t.status === "done")),
  ].slice(0, limit);
}

// 렌더링: 정렬된 스레드를 마크다운으로 출력. fast/slow path 구분 없이 동일 입력.
function formatRecall(sorted: RecallEntry[]): string {
  const statusIcon = (t: RecallEntry) =>
    t.status === "done" ? "✅" : t.is_open ? "🔴" : t.status === "active" ? "🟡" : "⬜";
  const gapLabel = (h: number | null) =>
    h === null ? "" : h < 1 ? "방금 전" : h < 18 ? `${h}시간 전` : h < 36 ? "어제" : `${Math.floor(h / 24)}일 전`;

  const lines: string[] = [];

  // Lead entry — the most important thread, formatted as a direct question
  const top = sorted[0];
  const others = sorted.slice(1);

  // Stale-open threads: split by depth of abandonment
  const topIsGhost = top.is_open && top.status === "stale" && (top.gap_hours ?? 0) >= GHOST_THRESHOLD_H;

  // Lead section header
  if (topIsGhost) {
    lines.push("## 💀 아직도 할 거야?\n");
    const weeks = top.gap_hours !== null ? Math.floor(top.gap_hours / 168) : null;
    lines.push(`_${weeks ? `${weeks}주` : "오랫동안"} 못 봤어. 계속할 건지, 정리할 건지 결정해줘._\n`);
  } else if (top.is_open) {
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
  lines.push(`>`);
  if (topIsGhost) {
    lines.push(`> → 이어서? \`wiki_dump({ threadId: "${top.threadId}", content: "계속" })\``);
    lines.push(`> → 정리? \`wiki_dump({ threadId: "${top.threadId}", content: "결정: 이 프로젝트 종료" })\``);
  } else if (top.is_open) {
    lines.push(`> 이어서 갈까? (thread: \`${top.threadId}\`)`);
  } else {
    lines.push(`> thread: \`${top.threadId}\``);
  }

  // Stale-open threads: split by depth of abandonment
  const ghostThreads = others.filter(t => t.is_open && t.status === "stale" && (t.gap_hours ?? 0) >= GHOST_THRESHOLD_H);
  const forgottenThreads = others.filter(t => t.is_open && t.status === "stale" && (t.gap_hours ?? 0) < GHOST_THRESHOLD_H);
  const activeOthers = others.filter(t => !(t.is_open && t.status === "stale"));

  // Ghost projects: 2+ weeks untouched — direct question
  if (ghostThreads.length > 0) {
    lines.push("\n---");
    lines.push("## 💀 아직도 할 거야?");
    lines.push(`_${Math.floor(GHOST_THRESHOLD_H / 168)}주 이상 못 봤어. 계속할 건지, 정리할 건지 결정해줘._`);
    for (const t of ghostThreads) {
      const weeks = t.gap_hours !== null ? Math.floor(t.gap_hours / 168) : null;
      const gapStr = weeks !== null ? `${weeks}주 전` : "";
      const preview = t.next_action || t.last_action?.replace(/^(?:결정|가설|막힌것|다음할것|블로커|요약)\s*:\s*/i, "").slice(0, 80) || "";
      lines.push(`💀 **${t.title}**${gapStr ? ` (${gapStr})` : ""}`);
      if (preview) lines.push(`   마지막: ${preview}`);
      lines.push(`   → 이어서? \`wiki_dump({ threadId: "${t.threadId}", content: "계속" })\``);
      lines.push(`   → 정리? \`wiki_dump({ threadId: "${t.threadId}", content: "결정: 이 프로젝트 종료" })\``);
    }
  }

  if (forgottenThreads.length > 0) {
    lines.push("\n---");
    lines.push("## 📌 잊고 있던 거");
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

  return lines.join("\n");
}

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
          .map((t, i) => (t.is_open == null ? i : -1))
          .filter((i) => i >= 0);

        const fileContents = new Map<string, string>();
        if (uncachedIdx.length > 0) {
          const reads = await Promise.all(uncachedIdx.map((i) => getThread(candidates[i].id)));
          uncachedIdx.forEach((candIdx, readIdx) => {
            const c = reads[readIdx];
            if (c) fileContents.set(candidates[candIdx].id, c);
          });
        }

        const enriched: RecallEntry[] = candidates
          .map((t) => enrich(t, fileContents.get(t.id)))
          .filter((x): x is RecallEntry => x !== null)
          .filter((x) => x.capture_count > 0);

        const sorted = prioritize(enriched, limit);

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

        return { content: [{ type: "text", text: formatRecall(sorted) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
