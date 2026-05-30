import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getThreads, getThread, getPages, isSensitivePath, SCHEMA_VERSION } from "../../lib/brain.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

export function registerWikiExport(server: McpServer): void {
  server.tool(
    "wiki_export",
    "모든 스레드와 페이지를 JSON 파일로 내보낸다. 백업/이전 용도. 파일 경로를 반환하며 언제든 재실행 가능.",
    {
      outputPath: z.string().optional().describe("내보낼 파일 경로 (기본값: ~/oh-my-adhd-export-YYYY-MM-DD.json)"),
    },
    async ({ outputPath }) => {
      try {
        const [threads, pages] = await Promise.all([getThreads(), getPages()]);

        const threadContents = await Promise.all(
          threads.map(async (t) => ({
            ...t,
            content: await getThread(t.id),
          }))
        );

        const exportData = {
          exportedAt: new Date().toISOString(),
          schemaVersion: SCHEMA_VERSION,
          stats: { threads: threads.length, pages: pages.length },
          threads: threadContents,
          pages,
        };

        const date = new Date().toISOString().slice(0, 10);
        const defaultPath = path.join(os.homedir(), `oh-my-adhd-export-${date}.json`);
        const resolved = outputPath ? path.resolve(outputPath) : defaultPath;

        // Require .json extension — prevents LLM-controlled path from clobbering non-JSON config files
        if (!resolved.endsWith(".json")) {
          return {
            content: [{ type: "text", text: "오류: outputPath는 .json 확장자로 끝나야 합니다." }],
            isError: true,
          };
        }
        // Block writes into known sensitive dirs
        if (await isSensitivePath(resolved)) {
          return {
            content: [{ type: "text", text: "오류: 보안상 해당 경로에는 내보낼 수 없습니다." }],
            isError: true,
          };
        }
        const filePath = resolved;

        const tmp = filePath + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(exportData, null, 2), "utf-8");
        await fs.rename(tmp, filePath);

        const sizeKB = Math.round((await fs.stat(filePath)).size / 1024);

        return {
          content: [{
            type: "text",
            text: [
              "내보내기 완료 ✓",
              `경로: ${filePath}`,
              `스레드: ${threads.length}개 | 페이지: ${pages.length}개 | ${sizeKB}KB`,
              "",
              "복원하려면: wiki_import({ inputPath: \"<이 경로>\" }) 호출",
            ].join("\n"),
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }],
          isError: true,
        };
      }
    }
  );
}
