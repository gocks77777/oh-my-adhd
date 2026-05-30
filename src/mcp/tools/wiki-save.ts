import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { savePage } from "../../lib/brain.js";

export function registerWikiSave(server: McpServer): void {
  server.tool(
    "wiki_save",
    "구조화된 마크다운 내용을 위키 페이지로 저장한다.",
    {
      slug: z.string().max(100).regex(/^[a-z0-9가-힣-]+$/).describe("저장할 페이지 슬러그"),
      content: z.string().max(64_000).describe("저장할 마크다운 내용 (# 제목\\n\\n## 섹션...)"),
    },
    async ({ slug, content }) => {
      const normalSlug = slug.toLowerCase();
      if (!normalSlug || normalSlug.includes("/") || normalSlug.includes("\\") || normalSlug.includes("..") || normalSlug.includes("\0") || !/^[a-z0-9가-힣-]+$/.test(normalSlug)) {
        return { content: [{ type: "text", text: `오류: 유효하지 않은 슬러그 "${slug}"` }], isError: true };
      }
      try {
        await savePage(normalSlug, content);
      } catch (e) {
        return { content: [{ type: "text", text: `오류: 저장 실패 — ${(e as Error).message}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `저장됨: [[${normalSlug}]]` }],
      };
    }
  );
}
