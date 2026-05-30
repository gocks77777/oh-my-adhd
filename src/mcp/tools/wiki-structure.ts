import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPage } from "../../lib/brain.js";

export function registerWikiStructure(server: McpServer): void {
  server.tool(
    "wiki_structure",
    "슬러그로 페이지의 날것 캡처 내용을 가져온다. Claude가 이 내용을 보고 ## 섹션으로 구조화한 뒤 wiki_save로 저장해야 한다.",
    {
      slug: z.string().max(100).regex(/^[a-z0-9가-힣-]+$/).describe("구조화할 페이지 슬러그"),
    },
    async ({ slug }) => {
      const page = await getPage(slug.toLowerCase());
      if (!page) {
        return { content: [{ type: "text", text: `페이지 없음: ${slug}` }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: [
              `=== 페이지: [[${page.title}]] (slug: ${page.slug}) ===`,
              "",
              "아래 날것 내용을 ## 섹션으로 구조화해서 wiki_save 툴로 저장하세요.",
              "형식: # 제목\\n\\n## 섹션1\\n내용\\n\\n## 섹션2\\n내용",
              "",
              "=== 원본 내용 ===",
              page.content,
            ].join("\n"),
          },
        ],
      };
    }
  );
}
