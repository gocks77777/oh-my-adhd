import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteThread, deletePage } from "../../lib/brain.js";

export function registerWikiDelete(server: McpServer): void {
  server.tool(
    "wiki_delete",
    "스레드 또는 위키 페이지를 삭제한다. 실수로 저장한 민감한 내용 제거용.",
    {
      target: z.enum(["thread", "page"]),
      id: z.string().max(200).describe("스레드 ID (UUID) 또는 페이지 슬러그"),
    },
    async ({ target, id }) => {
      try {
        if (target === "thread") {
          await deleteThread(id);
          return { content: [{ type: "text", text: `스레드 삭제됨: ${id}` }] };
        } else {
          await deletePage(id);
          return { content: [{ type: "text", text: `페이지 삭제됨: ${id}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
