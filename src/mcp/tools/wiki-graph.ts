import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildGraphData } from "../../lib/linker.js";

export function registerWikiGraph(server: McpServer): void {
  server.tool(
    "wiki_graph",
    "세컨드 브레인의 노드/엣지 그래프 데이터를 반환한다.",
    {},
    async () => {
      try {
        const data = await buildGraphData();
        return {
          content: [
            {
              type: "text",
              text: `nodes: ${data.nodes.length}, edges: ${data.edges.length}\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
