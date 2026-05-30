import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureBrainDirs, BRAIN_DIR, SCHEMA_VERSION } from "../../lib/brain.js";
import fs from "fs/promises";
import path from "path";

export function registerWikiImport(server: McpServer): void {
  server.tool(
    "wiki_import",
    "wiki_export로 내보낸 JSON 백업 파일을 가져온다. 기존 데이터와 병합(merge)하며 중복 thread ID는 덮어쓴다.",
    {
      inputPath: z.string().describe("가져올 .json 파일 경로 (wiki_export로 생성된 파일)"),
      overwrite: z.boolean().optional().describe("true이면 같은 ID의 스레드를 덮어씀 (기본값: true)"),
    },
    async ({ inputPath, overwrite = true }) => {
      try {
        const resolved = path.resolve(inputPath);
        if (!resolved.endsWith(".json")) {
          return {
            content: [{ type: "text", text: "오류: inputPath는 .json 확장자로 끝나야 합니다." }],
            isError: true,
          };
        }

        let raw: string;
        try {
          raw = await fs.readFile(resolved, "utf-8");
        } catch {
          return {
            content: [{ type: "text", text: `오류: 파일을 읽을 수 없습니다: ${resolved}` }],
            isError: true,
          };
        }

        let exportData: {
          schemaVersion?: number;
          threads?: Array<{ id: string; title: string; content?: string; [k: string]: unknown }>;
          pages?: Array<{ slug: string; title: string; content: string; [k: string]: unknown }>;
        };
        try {
          exportData = JSON.parse(raw);
        } catch {
          return {
            content: [{ type: "text", text: "오류: JSON 파싱 실패. wiki_export로 생성된 파일인지 확인하세요." }],
            isError: true,
          };
        }

        if (!exportData.threads || !Array.isArray(exportData.threads)) {
          return {
            content: [{ type: "text", text: "오류: 유효하지 않은 내보내기 파일 형식입니다." }],
            isError: true,
          };
        }

        if (exportData.schemaVersion && exportData.schemaVersion !== SCHEMA_VERSION) {
          return {
            content: [{ type: "text", text: `오류: 스키마 버전 불일치 (파일: ${exportData.schemaVersion}, 현재: ${SCHEMA_VERSION})` }],
            isError: true,
          };
        }

        await ensureBrainDirs();
        const threadsDir = path.join(BRAIN_DIR, "threads");
        const pagesDir = path.join(BRAIN_DIR, "pages");
        const manifestFile = path.join(threadsDir, ".manifest.json");

        // Load existing manifest
        let manifest: unknown[] = [];
        try {
          manifest = JSON.parse(await fs.readFile(manifestFile, "utf-8"));
        } catch { /* start fresh if missing */ }

        const existingIds = new Set((manifest as Array<{ id: string }>).map(m => m.id));
        let importedThreads = 0;
        let skippedThreads = 0;

        for (const thread of exportData.threads) {
          if (!thread.id || !thread.title) continue;
          if (!overwrite && existingIds.has(thread.id)) { skippedThreads++; continue; }

          // Write thread file
          if (thread.content) {
            const threadFile = path.join(threadsDir, `${thread.id}.md`);
            const tmp = threadFile + ".tmp";
            await fs.writeFile(tmp, thread.content, "utf-8");
            await fs.rename(tmp, threadFile);
          }

          // Update manifest entry
          const { content: _c, ...meta } = thread;
          const idx = (manifest as Array<{ id: string }>).findIndex(m => m.id === thread.id);
          if (idx >= 0) (manifest as unknown[])[idx] = meta;
          else manifest.push(meta);
          importedThreads++;
        }

        // Write updated manifest atomically
        const tmp = manifestFile + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
        await fs.rename(tmp, manifestFile);

        // Import pages if present
        let importedPages = 0;
        if (exportData.pages && Array.isArray(exportData.pages)) {
          for (const page of exportData.pages) {
            if (!page.slug || !page.content) continue;
            const pageFile = path.join(pagesDir, `${page.slug}.md`);
            const tmp2 = pageFile + ".tmp";
            await fs.writeFile(tmp2, page.content, "utf-8");
            await fs.rename(tmp2, pageFile);
            importedPages++;
          }
        }

        return {
          content: [{
            type: "text",
            text: [
              "가져오기 완료 ✓",
              `스레드: ${importedThreads}개 가져옴${skippedThreads > 0 ? ` (${skippedThreads}개 건너뜀)` : ""}`,
              `페이지: ${importedPages}개 가져옴`,
              `원본 파일: ${resolved}`,
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
