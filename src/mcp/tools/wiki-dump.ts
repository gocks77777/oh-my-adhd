import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { saveCapture, getThread, getThreads, BRAIN_DIR } from "../../lib/brain.js";
import { findRelatedPages, upsertPageFromCapture } from "../../lib/linker.js";
import { captureGitContext } from "../utils.js";

export function registerWikiDump(server: McpServer): void {
  server.tool(
    "wiki_dump",
    "생각이나 메모를 세컨드 브레인에 저장한다. 같은 주제면 반드시 threadId를 재사용해서 이어 붙인다. 새 주제일 때만 threadId 없이 호출. 저장 후 반환된 threadId를 기억해 다음 캡처에 활용.\n\ncontent 형식 (구조화 권장):\n결정: [이번 대화에서 확정된 것]\n가설: [현재 시도 중인 방향]\n막힌것: [이미 시도해서 안 된 것 — 다음 세션 반복 방지]\n다음할것: [멈춘 시점의 다음 액션. 구체적으로]\n블로커: [해결 안 된 장애물]\n요약: [한 줄 컨텍스트]",
    {
      content: z.string().max(64_000).describe("저장할 내용"),
      threadId: z.string().uuid().optional().describe("이어 붙일 스레드 ID (없으면 새 스레드)"),
    },
    async ({ content, threadId }) => {
      try {
        if (!content.trim()) {
          return { content: [{ type: "text", text: "오류: 내용이 비어 있습니다. 저장할 내용을 입력해 주세요." }], isError: true };
        }
        const gitCtx = await captureGitContext();
        const related = await findRelatedPages(content); // upsert 이전에 — self-link 방지
        const result = await saveCapture(content + gitCtx, threadId);
        if (result.skipped) {
          return {
            content: [{ type: "text", text: `저장됨 ✓\n(중복 캡처 — 이미 저장된 내용)\nthread: ${result.threadId}` }],
          };
        }
        const fullContent = await getThread(result.threadId);
        if (fullContent) await upsertPageFromCapture(result.title, fullContent).catch(() => {});
        const sizeKB = Math.round((fullContent?.length ?? 0) / 1024);
        const sizeWarn = sizeKB > 500 ? `\n⚠️ 스레드 크기 ${sizeKB}KB — 새 주제는 새 스레드(threadId 없이)로 분리하는 걸 권장` : "";

        const respLines = ["저장됨 ✓"];
        const nextMatch = content.match(/(?:^|\n)\s*다음할것\s*:\s*(.+)/im);
        const blockerMatch = content.match(/(?:^|\n)\s*막힌것\s*:\s*(.+)/im);
        if (nextMatch?.[1]?.trim()) respLines.push(`→ 다음 액션: ${nextMatch[1].trim().slice(0, 100)}`);
        if (blockerMatch?.[1]?.trim()) respLines.push(`⛔ 막힌것 기록: ${blockerMatch[1].trim().slice(0, 100)}`);
        respLines.push(`thread: ${result.threadId} (캡처 #${result.capture.id.slice(0, 8)})`);
        if (related.length > 0) respLines.push(`연결된 페이지: ${related.join(", ")}`);
        if (sizeWarn) respLines.push(sizeWarn.trim());

        // Detect if content uses the structured schema
        const FIELD_PATTERN = /(?:^|\n)\s*(?:결정|가설|막힌것|다음할것|블로커|요약)\s*:/i;
        const isStructured = FIELD_PATTERN.test(content);

        // Check if new content looks like a repeat of a known dead-end; also used for nag suppression
        let allThreads: Awaited<ReturnType<typeof getThreads>> = [];
        if (!result.skipped) {
          try {
            allThreads = await getThreads();
            const contentLower = content.toLowerCase().replace(/\s+/g, " ");
            for (const t of allThreads) {
              if (!t.is_open || t.id === result.threadId || !t.blocker) continue;
              const blockerWords = t.blocker.toLowerCase().replace(/\s+/g, " ").split(/\s+/).filter(w => w.length > 2);
              if (blockerWords.length === 0) continue;
              const matchCount = blockerWords.filter(w => contentLower.includes(w)).length;
              if (matchCount >= 3 || matchCount / blockerWords.length > 0.5) {
                respLines.unshift("");
                respLines.unshift(`   같은 길 다시 가는 거 맞아? 막혔으면 \`wiki_unstick\` 해볼래?`);
                respLines.unshift(`   → "${t.blocker.slice(0, 80)}" (${(t.title ?? "").slice(0, 20)}, thread \`${t.id.slice(0, 8)}...\`)`);
                respLines.unshift(`⚠️ 이거 전에 막혔던 거랑 비슷해:`);
                break;
              }
            }
          } catch { /* dead-end check is best-effort, never crash */ }
        }

        // Dopamine streak: show today's save count when ≥2
        if (!result.skipped && allThreads.length > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const todayCount = allThreads.filter(t => t.updatedAt?.startsWith(today)).length;
          if (todayCount >= 2) respLines[0] = `저장됨 ✓ (오늘 ${todayCount}번째 🔥)`;
        }

        // Only nag once — user can dismiss permanently by touching .nag-dismissed
        let nagDismissed = false;
        try { await fs.access(path.join(BRAIN_DIR, ".nag-dismissed")); nagDismissed = true; } catch {}
        if (!isStructured && !result.skipped && !nagDismissed) {
          respLines.push("");
          respLines.push("💡 다음번엔 이 형식으로 쓰면 다음 세션에서 더 잘 복원돼:");
          respLines.push("```");
          respLines.push("다음할것: [지금 멈춘 시점의 다음 액션]");
          respLines.push("막힌것: [이미 시도해서 안 된 것]");
          respLines.push("요약: [한 줄 컨텍스트]");
          respLines.push("```");
        }

        return {
          content: [{ type: "text", text: respLines.join("\n") }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
