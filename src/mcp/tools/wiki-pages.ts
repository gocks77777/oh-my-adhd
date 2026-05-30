import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPages } from "../../lib/brain.js";

export function registerWikiPages(server: McpServer): void {
  server.tool(
    "wiki_pages",
    "생성된 위키 페이지 목록을 반환한다.",
    {},
    async () => {
      try {
        const pages = await getPages();
        const list = pages.map((p) => `[[${p.title}]] — ${p.updatedAt.slice(0, 10)}`);
        return {
          content: [
            {
              type: "text",
              text: list.length > 0 ? list.join("\n") : "페이지 없음",
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
