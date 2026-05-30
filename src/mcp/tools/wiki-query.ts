import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getThreads, getPages, getThread } from "../../lib/brain.js";
import { searchPages, searchInDocs } from "../../lib/search.js";

export function registerWikiQuery(server: McpServer): void {
  server.tool(
    "wiki_query",
    "세컨드 브레인에서 키워드로 검색한다. '전에 이 문제 겪어본 적 있나?', '비슷한 결정 했던 게 기억나는데' 같은 상황에서 호출. 과거의 나를 찾는 도구.",
    {
      query: z.string().max(1_000).trim().describe("검색할 키워드"),
    },
    async ({ query }) => {
      try {
        if (!query.trim()) {
          return { content: [{ type: "text", text: "검색어를 입력하세요. 예: wiki_query({ query: \"React\" })" }], isError: true };
        }
        const [allThreads, pages] = await Promise.all([getThreads(), getPages()]);
        const lq = query.toLowerCase();
        const results: string[] = [];

        // BM25 page search
        const slugs = searchPages(pages, query, 5);
        for (const slug of slugs) {
          const p = pages.find((x) => x.slug === slug);
          if (!p) continue;
          const snippet =
            p.content.split("\n").find((line) => line.toLowerCase().includes(lq))?.slice(0, 200) ??
            p.content.slice(0, 200);
          results.push(`[PAGE] [[${p.title}]]\n${snippet}`);
        }

        // Thread search: BM25 on manifest title + last_action (fast, no file I/O per thread)
        const threadDocs = allThreads.slice(0, 200).map(t => ({
          id: t.id,
          title: t.title,
          content: [t.last_action, t.next_action, t.blocker].filter(Boolean).join(" "),
        }));
        const threadScores = searchInDocs(threadDocs, query);
        const threadResults = threadScores
          .slice(0, 10)
          .map(r => allThreads.find(t => t.id === r.id))
          .filter((t): t is typeof allThreads[0] => t !== undefined);

        for (const t of threadResults.slice(0, 5)) {
          const content = await getThread(t.id);
          const titleMatch = content?.match(/^#\s+(.+)$/m);
          const title = titleMatch?.[1] ?? t.id;
          const blocks = content?.split(/\n---\n/) ?? [];
          const matched = blocks.find((b) => b.toLowerCase().includes(lq));
          const snippet =
            matched
              ?.trim()
              .replace(/^(?:_[^_\n]+_|\*\*[^*\n]+\*\*)\s*/m, "")
              .slice(0, 200) ??
            (t.last_action?.slice(0, 200) ?? "");
          results.push(`[THREAD] ${title} (id: ${t.id})\n${snippet}`);
        }

        if (allThreads.length > 200) {
          results.push(`\n(최근 200개 스레드만 검색됨 — 전체 ${allThreads.length}개 중 ${allThreads.length - 200}개 미검색)`);
        }

        return {
          content: [
            {
              type: "text",
              text: results.length > 0
                ? results.join("\n\n---\n\n")
                : `"${query}"에 해당하는 내용 없음${allThreads.length > 200 ? ` (최근 200개 스레드만 검색됨)` : ""}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
