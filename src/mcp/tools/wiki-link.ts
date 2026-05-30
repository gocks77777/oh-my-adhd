import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findRelatedPages, upsertPageFromCapture } from "../../lib/linker.js";

export function registerWikiLink(server: McpServer): void {
  server.tool(
    "wiki_link",
    "내용에서 관련 위키 페이지를 찾고, 필요하면 새 페이지를 생성한다.",
    {
      content: z.string().max(64_000).describe("분석할 내용"),
      createPage: z.boolean().optional().describe("위키 페이지로 저장할지 여부"),
      title: z.string().max(200).optional().describe("페이지 제목 (createPage가 true일 때 필요)"),
    },
    async ({ content, createPage, title }) => {
      if (createPage && !title) {
        return { content: [{ type: "text", text: "오류: createPage가 true이면 title이 필요합니다" }], isError: true };
      }
      try {
        const related = await findRelatedPages(content);
        if (createPage && title) {
          await upsertPageFromCapture(title, content).catch(() => {});
        }
        const lines: string[] = [];
        if (related.length > 0) {
          lines.push(`관련 페이지: ${related.map((s) => `[[${s}]]`).join(", ")}`);
        } else {
          lines.push("관련 페이지 없음");
        }
        if (createPage && title) {
          lines.push(`페이지 생성됨: [[${title}]]`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
