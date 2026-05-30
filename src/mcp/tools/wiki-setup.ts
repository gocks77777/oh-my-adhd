import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { saveCapture, getThread } from "../../lib/brain.js";
import { upsertPageFromCapture } from "../../lib/linker.js";

export function registerWikiSetup(server: McpServer): void {
  server.tool(
    "wiki_setup",
    "선택적 뇌 스냅샷. 지금 작업 중인 것들을 입력하면 첫 스레드를 생성해 wiki_recall이 즉시 의미있는 내용을 반환한다. 설치 직후 또는 컨텍스트를 새로 심고 싶을 때 호출.",
    {
      tasks: z.array(z.string().max(500)).min(1).max(5).describe("지금 하고 있는 것들 (1-5개)"),
    },
    async ({ tasks }) => {
      try {
        const content = `현재 작업 스냅샷:\n${tasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
        const result = await saveCapture(content);
        const fullContent = await getThread(result.threadId);
        if (fullContent) await upsertPageFromCapture(result.title, fullContent).catch(() => {});
        return {
          content: [{
            type: "text",
            text: `뇌 스냅샷 저장됨 ✓\nthread: ${result.threadId}\n\n이제 wiki_recall을 호출하면 이 컨텍스트가 복원돼.`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
