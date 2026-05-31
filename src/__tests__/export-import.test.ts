import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let tmpDir: string;
let client: Client;

async function setup() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const { registerWikiDump } = await import("../mcp/tools/wiki-dump.js");
  const { registerWikiExport } = await import("../mcp/tools/wiki-export.js");
  const { registerWikiImport } = await import("../mcp/tools/wiki-import.js");
  registerWikiDump(server);
  registerWikiExport(server);
  registerWikiImport(server);

  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "oh-my-adhd-ei-"));
  process.env.OH_MY_ADHD_DIR = tmpDir;
  vi.resetModules();
  await setup();
});

afterEach(async () => {
  await client.close();
  delete process.env.OH_MY_ADHD_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

function textOf(r: { content: unknown }): string {
  return (r.content as { type: string; text: string }[])[0].text;
}

async function dump(content: string, threadId?: string) {
  const args: Record<string, string> = { content };
  if (threadId) args.threadId = threadId;
  const r = await client.callTool({ name: "wiki_dump", arguments: args });
  return textOf(r);
}

async function exportTo(outPath: string) {
  const r = await client.callTool({ name: "wiki_export", arguments: { outputPath: outPath } });
  return textOf(r);
}

async function importFrom(inPath: string, overwrite?: boolean) {
  const args: Record<string, unknown> = { inputPath: inPath };
  if (overwrite !== undefined) args.overwrite = overwrite;
  const r = await client.callTool({ name: "wiki_import", arguments: args });
  return textOf(r);
}

// ---------------------------------------------------------------------------
// export — empty brain
// ---------------------------------------------------------------------------
describe("export — empty brain", () => {
  it("returns empty threads/pages arrays when nothing has been saved", async () => {
    const outPath = join(tmpDir, "empty-export.json");
    const text = await exportTo(outPath);
    expect(text).toContain("내보내기 완료");

    const raw = JSON.parse(await readFile(outPath, "utf-8"));
    expect(raw.threads).toEqual([]);
    expect(raw.pages).toEqual([]);
    expect(raw.schemaVersion).toBe(1);
    expect(raw.exportedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// export — populated brain structure
// ---------------------------------------------------------------------------
describe("export — populated brain", () => {
  it("returns correct {threads, pages, exportedAt, schemaVersion} structure", async () => {
    await dump("요약: 구조 검증용 스레드\n다음할것: 확인");
    const outPath = join(tmpDir, "struct-export.json");
    await exportTo(outPath);

    const raw = JSON.parse(await readFile(outPath, "utf-8"));
    expect(Array.isArray(raw.threads)).toBe(true);
    expect(Array.isArray(raw.pages)).toBe(true);
    expect(typeof raw.exportedAt).toBe("string");
    expect(raw.schemaVersion).toBe(1);

    expect(raw.threads.length).toBe(1);
    const thread = raw.threads[0];
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.title).toBeTruthy();
    expect(thread.content).toContain("구조 검증용 스레드");
  });
});

// ---------------------------------------------------------------------------
// import → export round-trip
// ---------------------------------------------------------------------------
describe("import → export round-trip", () => {
  it("re-importing exported data restores the same thread", async () => {
    const dumpText = await dump("요약: 라운드트립 검증\n다음할것: 재확인");
    const tid = dumpText.match(/thread: ([a-f0-9-]{36})/)?.[1]!;
    expect(tid).toBeTruthy();

    const outPath = join(tmpDir, "rt.json");
    await exportTo(outPath);
    const before = JSON.parse(await readFile(outPath, "utf-8"));

    // Wipe threads, then re-import from the export
    await rm(join(tmpDir, "threads"), { recursive: true, force: true });

    const importText = await importFrom(outPath);
    expect(importText).toContain("가져오기 완료");
    expect(importText).toContain("1개 가져옴");

    // Export again and compare the restored thread to the original
    const outPath2 = join(tmpDir, "rt2.json");
    await exportTo(outPath2);
    const after = JSON.parse(await readFile(outPath2, "utf-8"));

    expect(after.threads.length).toBe(1);
    expect(after.threads[0].id).toBe(tid);
    expect(after.threads[0].title).toBe(before.threads[0].title);
    expect(after.threads[0].content).toBe(before.threads[0].content);
  });
});

// ---------------------------------------------------------------------------
// import — schema version mismatch
// ---------------------------------------------------------------------------
describe("import — schema version mismatch", () => {
  it("returns an error when schemaVersion does not match", async () => {
    const wrongVer = join(tmpDir, "wrong-version.json");
    await writeFile(wrongVer, JSON.stringify({
      schemaVersion: 999,
      threads: [],
      pages: [],
    }), "utf-8");

    const text = await importFrom(wrongVer);
    expect(text).toContain("스키마 버전 불일치");
    expect(text).not.toContain("가져오기 완료");
  });
});

// ---------------------------------------------------------------------------
// import — security boundary: sensitive path rejected
// ---------------------------------------------------------------------------
describe("import — security boundary", () => {
  it("rejects an inputPath inside a sensitive directory", async () => {
    const sensitiveIn = join(homedir(), ".ssh", "thread-export.json");
    const text = await importFrom(sensitiveIn);
    expect(text).toContain("보안상 해당 경로에서는 가져올 수 없습니다");
    expect(text).not.toContain("가져오기 완료");
  });
});

// ---------------------------------------------------------------------------
// import — overwrite=false skips existing threads
// ---------------------------------------------------------------------------
describe("import — overwrite=false", () => {
  it("skips threads that already exist when overwrite is false", async () => {
    const dumpText = await dump("요약: 덮어쓰기 테스트");
    const tid = dumpText.match(/thread: ([a-f0-9-]{36})/)?.[1]!;
    expect(tid).toBeTruthy();

    const outPath = join(tmpDir, "overwrite-test.json");
    await exportTo(outPath);

    // Re-import without overwrite — existing thread should be skipped
    const text = await importFrom(outPath, false);
    expect(text).toContain("가져오기 완료");
    expect(text).toContain("건너뜀");

    // Brain should still have exactly 1 thread (no duplicate)
    const outPath2 = join(tmpDir, "overwrite-verify.json");
    await exportTo(outPath2);
    const after = JSON.parse(await readFile(outPath2, "utf-8"));
    expect(after.threads.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// import — MAX_ITEMS exceeded
// ---------------------------------------------------------------------------
describe("import — MAX_ITEMS exceeded", () => {
  it("returns an error when thread count exceeds the limit", async () => {
    const oversized = join(tmpDir, "too-many.json");
    await writeFile(oversized, JSON.stringify({
      schemaVersion: 1,
      threads: Array.from({ length: 10_001 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        title: `thread-${i}`,
        content: "x",
      })),
      pages: [],
    }), "utf-8");

    const text = await importFrom(oversized);
    expect(text).toContain("항목이 너무 많습니다");
    expect(text).not.toContain("가져오기 완료");
  });
});

// ---------------------------------------------------------------------------
// import — page round-trip
// ---------------------------------------------------------------------------
describe("import — page round-trip", () => {
  it("restores pages from an export file", async () => {
    const exportData = {
      schemaVersion: 1,
      threads: [],
      pages: [{ slug: "test-page", content: "# Test\n내용입니다" }],
    };
    const inPath = join(tmpDir, "page-import.json");
    await writeFile(inPath, JSON.stringify(exportData), "utf-8");

    const text = await importFrom(inPath);
    expect(text).toContain("가져오기 완료");
    expect(text).toContain("페이지: 1개 가져옴");

    // Export should now include the page
    const outPath = join(tmpDir, "page-export.json");
    await exportTo(outPath);
    const after = JSON.parse(await readFile(outPath, "utf-8"));
    expect(after.pages.length).toBe(1);
    expect(after.pages[0].slug).toBe("test-page");
  });
});
