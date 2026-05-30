import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureBrainDirs, BRAIN_DIR, SCHEMA_VERSION, UUID_RE, isSensitivePath, withBrainLock, ThreadMeta } from "../../lib/brain.js";
import fs from "fs/promises";
import path from "path";

const SLUG_RE = /^[a-z0-9가-힣][a-z0-9가-힣_-]{0,127}$/;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5MB per thread
const MAX_ITEMS = 10_000; // max threads or pages per import

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

        // Block reads from sensitive dirs — mirrors wiki_export denylist
        if (await isSensitivePath(resolved)) {
          return {
            content: [{ type: "text", text: "오류: 보안상 해당 경로에서는 가져올 수 없습니다." }],
            isError: true,
          };
        }

        // Open once so stat + read refer to the same inode (closes TOCTOU window)
        let raw: string;
        try {
          const handle = await fs.open(resolved, "r");
          try {
            const stat = await handle.stat();
            if (stat.size > 100 * 1024 * 1024) {
              return {
                content: [{ type: "text", text: "오류: 파일이 너무 큽니다 (100MB 초과)." }],
                isError: true,
              };
            }
            raw = await handle.readFile({ encoding: "utf-8" });
          } finally {
            await handle.close();
          }
        } catch {
          return {
            content: [{ type: "text", text: `오류: 파일을 읽을 수 없습니다: ${resolved}` }],
            isError: true,
          };
        }

        let exportData: {
          schemaVersion?: number;
          threads?: unknown[];
          pages?: unknown[];
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
        if (exportData.threads.length > MAX_ITEMS || (exportData.pages?.length ?? 0) > MAX_ITEMS) {
          return {
            content: [{ type: "text", text: `오류: 항목이 너무 많습니다 (최대 ${MAX_ITEMS}개).` }],
            isError: true,
          };
        }

        if (exportData.schemaVersion !== undefined && exportData.schemaVersion !== SCHEMA_VERSION) {
          return {
            content: [{ type: "text", text: `오류: 스키마 버전 불일치 (파일: ${exportData.schemaVersion}, 현재: ${SCHEMA_VERSION})` }],
            isError: true,
          };
        }

        await ensureBrainDirs();
        const threadsDir = path.join(BRAIN_DIR, "threads");
        const pagesDir = path.join(BRAIN_DIR, "pages");
        const manifestFile = path.join(threadsDir, ".manifest.json");

        let importedThreads = 0;
        let skippedThreads = 0;
        let importedPages = 0;
        let skippedPages = 0;

        await withBrainLock(async () => {
          // Load existing manifest inside lock
          let manifest: ThreadMeta[] = [];
          try {
            manifest = JSON.parse(await fs.readFile(manifestFile, "utf-8"));
          } catch { /* start fresh if missing */ }

          const existingIds = new Set(manifest.map(m => m.id));

          for (const rawThread of exportData.threads!) {
            if (typeof rawThread !== "object" || rawThread === null) continue;
            const thread = rawThread as Record<string, unknown>;

            const id = typeof thread.id === "string" ? thread.id : "";
            const title = typeof thread.title === "string" ? thread.title : "";
            if (!UUID_RE.test(id) || !title) { skippedThreads++; continue; }
            if (!overwrite && existingIds.has(id)) { skippedThreads++; continue; }

            // Write thread content file if present
            if (typeof thread.content === "string") {
              const contentBytes = Buffer.byteLength(thread.content, "utf-8");
              if (contentBytes > MAX_CONTENT_BYTES) {
                skippedThreads++;
                continue;
              }
              const threadFile = path.join(threadsDir, `${id}.md`);
              const tmp = threadFile + ".tmp";
              await fs.writeFile(tmp, thread.content, "utf-8");
              await fs.rename(tmp, threadFile);
            }

            // Project only allowed ThreadMeta fields — no arbitrary spread
            const meta: ThreadMeta = {
              id,
              title,
              updatedAt: typeof thread.updatedAt === "string" && Number.isFinite(Date.parse(thread.updatedAt))
                ? new Date(thread.updatedAt).toISOString()
                : new Date().toISOString(),
            };
            if (typeof thread.is_open === "boolean") meta.is_open = thread.is_open;
            if (typeof thread.is_done === "boolean") meta.is_done = thread.is_done;
            if (typeof thread.last_action === "string") meta.last_action = thread.last_action;
            if (typeof thread.next_action === "string") meta.next_action = thread.next_action;
            if (typeof thread.blocker === "string") meta.blocker = thread.blocker;
            if (typeof thread.capture_count === "number") meta.capture_count = thread.capture_count;

            const idx = manifest.findIndex(m => m.id === id);
            if (idx >= 0) manifest[idx] = meta;
            else manifest.push(meta);
            existingIds.add(id); // prevent duplicate IDs within same import
            importedThreads++;
          }

          // Sort by updatedAt desc — matches saveCapture/updateManifestEntry behavior
          manifest.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          const tmp = manifestFile + ".tmp";
          await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
          await fs.rename(tmp, manifestFile);

          // Import pages inside lock for consistency with concurrent dump+import
          if (exportData.pages && Array.isArray(exportData.pages)) {
            for (const rawPage of exportData.pages) {
              if (typeof rawPage !== "object" || rawPage === null) continue;
              const page = rawPage as Record<string, unknown>;

              const slug = typeof page.slug === "string" ? page.slug : "";
              const content = typeof page.content === "string" ? page.content : "";
              if (!SLUG_RE.test(slug) || !content) { skippedPages++; continue; }
              if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) { skippedPages++; continue; }

              const pageFile = path.join(pagesDir, `${slug}.md`);
              const pageTmp = pageFile + ".tmp";
              await fs.writeFile(pageTmp, content, "utf-8");
              await fs.rename(pageTmp, pageFile);
              importedPages++;
            }
          }
        });

        return {
          content: [{
            type: "text",
            text: [
              "가져오기 완료 ✓",
              `스레드: ${importedThreads}개 가져옴${skippedThreads > 0 ? ` (${skippedThreads}개 건너뜀)` : ""}`,
              `페이지: ${importedPages}개 가져옴${skippedPages > 0 ? ` (${skippedPages}개 건너뜀)` : ""}`,
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
