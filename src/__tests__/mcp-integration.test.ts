import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let tmpDir: string;
let client: Client;

async function setup() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const { registerWikiDump } = await import("../mcp/tools/wiki-dump.js");
  const { registerWikiRecall } = await import("../mcp/tools/wiki-recall.js");
  const { registerWikiExport } = await import("../mcp/tools/wiki-export.js");
  const { registerWikiImport } = await import("../mcp/tools/wiki-import.js");
  registerWikiDump(server);
  registerWikiRecall(server);
  registerWikiExport(server);
  registerWikiImport(server);

  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "oh-my-adhd-mcp-"));
  process.env.OH_MY_ADHD_DIR = tmpDir;
  vi.resetModules();
  await setup();
});

afterEach(async () => {
  await client.close();
  delete process.env.OH_MY_ADHD_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function dump(content: string, threadId?: string) {
  const args: Record<string, string> = { content };
  if (threadId) args.threadId = threadId;
  const r = await client.callTool({ name: "wiki_dump", arguments: args });
  return (r.content as { type: string; text: string }[])[0].text;
}

async function recall() {
  const r = await client.callTool({ name: "wiki_recall", arguments: {} });
  return (r.content as { type: string; text: string }[])[0].text;
}

// ---------------------------------------------------------------------------
// wiki_dump — response shaping
// ---------------------------------------------------------------------------
describe("wiki_dump response", () => {
  it("returns 저장됨 ✓ on first save", async () => {
    const text = await dump("요약: 첫 번째 덤프");
    expect(text).toContain("저장됨 ✓");
  });

  it("extracts 다음할것 into response", async () => {
    const text = await dump("다음할것: npm publish\n요약: 배포 준비");
    expect(text).toContain("npm publish");
  });

  it("extracts 막힌것 into response", async () => {
    const text = await dump("막힌것: 인증 토큰 만료\n요약: 배포 막힘");
    expect(text).toContain("인증 토큰 만료");
  });

  it("includes threadId in response", async () => {
    const text = await dump("요약: 테스트");
    expect(text).toMatch(/thread:/);
  });

  it("shows streak emoji on second save today", async () => {
    await dump("요약: 첫 번째");
    // Second dump to a different thread triggers streak (today's count ≥ 2)
    const text = await dump("요약: 두 번째 주제");
    expect(text).toContain("🔥");
  });

  it("returns 중복 캡처 message on duplicate content", async () => {
    const content = "요약: 중복 테스트";
    const r1 = await dump(content);
    const tid = r1.match(/thread: ([a-f0-9-]{36})/)?.[1];
    expect(tid).toBeTruthy();
    const r2 = await dump(content, tid!);
    expect(r2).toContain("중복 캡처");
  });
});

// ---------------------------------------------------------------------------
// wiki_dump → wiki_recall round-trip
// ---------------------------------------------------------------------------
describe("dump → recall round-trip", () => {
  it("recalled thread title appears in recall output", async () => {
    await dump("요약: 로그인 버그 수정\n다음할것: PR 올리기");
    const text = await recall();
    expect(text).toContain("로그인 버그 수정");
  });

  it("recalled 다음할것 appears in output", async () => {
    await dump("요약: 리팩터링\n다음할것: 테스트 추가");
    const text = await recall();
    expect(text).toContain("테스트 추가");
  });

  it("open thread shows 🔴 icon", async () => {
    await dump("다음할것: 코드 리뷰\n요약: 진행중");
    const text = await recall();
    expect(text).toContain("🔴");
  });

  it("thread closed with 상태: 완료 does NOT appear as 🔴", async () => {
    const r = await dump("다음할것: 마무리\n요약: 거의 완료");
    const tid = r.match(/thread: ([a-f0-9-]{36})/)?.[1];
    await dump("상태: 완료\n요약: 완료됨", tid!);
    const text = await recall();
    // should be ✅ or ⬜, not 🔴
    expect(text).not.toMatch(/🔴.*완료됨/);
  });

  it("recalled blocker shows ⛔", async () => {
    await dump("막힌것: API 키 없음\n요약: 배포 막힘");
    const text = await recall();
    expect(text).toContain("⛔");
  });
});

// ---------------------------------------------------------------------------
// wiki_export
// ---------------------------------------------------------------------------
describe("wiki_export", () => {
  it("creates JSON export file", async () => {
    await dump("요약: 익스포트 테스트");
    const outPath = join(tmpDir, "export-test.json");
    const r = await client.callTool({ name: "wiki_export", arguments: { outputPath: outPath } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("내보내기 완료");
    expect(text).toContain(outPath);
  });

  it("exported JSON contains thread content", async () => {
    await dump("요약: 익스포트 내용 확인");
    const outPath = join(tmpDir, "export-content.json");
    await client.callTool({ name: "wiki_export", arguments: { outputPath: outPath } });
    const { readFile } = await import("fs/promises");
    const raw = JSON.parse(await readFile(outPath, "utf-8"));
    expect(raw.threads.length).toBe(1);
    expect(raw.threads[0].content).toContain("익스포트 내용 확인");
  });

  it("exported JSON has schemaVersion field", async () => {
    await dump("요약: 스키마 버전 확인");
    const outPath = join(tmpDir, "export-schema.json");
    await client.callTool({ name: "wiki_export", arguments: { outputPath: outPath } });
    const { readFile } = await import("fs/promises");
    const raw = JSON.parse(await readFile(outPath, "utf-8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.exportedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// wiki_import
// ---------------------------------------------------------------------------
describe("wiki_import", () => {
  async function exportTo(outPath: string) {
    await client.callTool({ name: "wiki_export", arguments: { outputPath: outPath } });
  }

  it("round-trip: export then import restores thread", async () => {
    await dump("요약: 임포트 라운드트립 테스트\n다음할것: 확인");
    const outPath = join(tmpDir, "rt-export.json");
    await exportTo(outPath);

    // Wipe brain dir and reimport
    const { rm, mkdir } = await import("fs/promises");
    const threadsDir = join(tmpDir, "threads");
    await rm(threadsDir, { recursive: true, force: true });
    await mkdir(threadsDir, { recursive: true });

    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: outPath } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("가져오기 완료");
    expect(text).toContain("1개 가져옴");
  });

  it("rejects path traversal in thread.id", async () => {
    const { writeFile } = await import("fs/promises");
    const evil = join(tmpDir, "evil.json");
    await writeFile(evil, JSON.stringify({
      schemaVersion: 1,
      threads: [{ id: "../../evil-file", title: "악의적인 스레드", content: "pwned" }],
      pages: [],
    }), "utf-8");

    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: evil } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    // Invalid UUID should be skipped, not cause an error
    expect(text).toContain("0개 가져옴");
  });

  it("rejects non-UUID thread.id", async () => {
    const { writeFile } = await import("fs/promises");
    const bad = join(tmpDir, "bad-uuid.json");
    await writeFile(bad, JSON.stringify({
      schemaVersion: 1,
      threads: [{ id: "not-a-uuid", title: "잘못된 ID", content: "내용" }],
      pages: [],
    }), "utf-8");

    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: bad } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("0개 가져옴");
  });

  it("rejects malformed JSON", async () => {
    const { writeFile } = await import("fs/promises");
    const bad = join(tmpDir, "malformed.json");
    await writeFile(bad, "not valid json", "utf-8");
    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: bad } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("오류");
  });

  it("rejects schema version mismatch", async () => {
    const { writeFile } = await import("fs/promises");
    const wrongVer = join(tmpDir, "wrong-version.json");
    await writeFile(wrongVer, JSON.stringify({
      schemaVersion: 999,
      threads: [],
      pages: [],
    }), "utf-8");

    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: wrongVer } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("스키마 버전 불일치");
  });

  it("skips thread with oversized content (>5MB)", async () => {
    const { writeFile, readFile } = await import("fs/promises");
    const bigId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    const oversized = join(tmpDir, "oversize.json");
    await writeFile(oversized, JSON.stringify({
      schemaVersion: 1,
      threads: [{ id: bigId, title: "큰 스레드", content: "x".repeat(5 * 1024 * 1024 + 1) }],
      pages: [],
    }), "utf-8");

    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: oversized } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("0개 가져옴");
    expect(text).toContain("건너뜀");

    // manifest must not contain the oversized thread id
    const manifestRaw = await readFile(join(tmpDir, "threads", ".manifest.json"), "utf-8").catch(() => "[]");
    const manifest = JSON.parse(manifestRaw) as { id: string }[];
    expect(manifest.find(m => m.id === bigId)).toBeUndefined();

    // content file must not exist
    const { access } = await import("fs/promises");
    await expect(access(join(tmpDir, "threads", `${bigId}.md`))).rejects.toThrow();
  });

  it("skips page with oversized content (>5MB)", async () => {
    const { writeFile, access } = await import("fs/promises");
    const oversized = join(tmpDir, "oversize-page.json");
    await writeFile(oversized, JSON.stringify({
      schemaVersion: 1,
      threads: [],
      pages: [{ slug: "big-page", content: "x".repeat(5 * 1024 * 1024 + 1) }],
    }), "utf-8");

    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: oversized } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("0개 가져옴");
    expect(text).toContain("건너뜀");

    await expect(access(join(tmpDir, "pages", "big-page.md"))).rejects.toThrow();
  });

  it("skips duplicate thread when overwrite=false", async () => {
    const r1 = await dump("요약: 원본 스레드");
    const tid = r1.match(/thread: ([a-f0-9-]{36})/)?.[1];
    expect(tid).toBeTruthy();

    const outPath = join(tmpDir, "dup-export.json");
    await exportTo(outPath);

    const r = await client.callTool({
      name: "wiki_import",
      arguments: { inputPath: outPath, overwrite: false },
    });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("건너뜀");
  });
});

// ---------------------------------------------------------------------------
// security: sanitize regression + denylist
// ---------------------------------------------------------------------------
describe("security", () => {
  it("wiki_recall preserves emoji and Korean in thread title", async () => {
    await dump("요약: 🔴 이모지 제목 테스트\n다음할것: 확인");
    const text = await recall();
    expect(text).toContain("🔴");
    expect(text).toContain("이모지");
  });

  it("wiki_export rejects outputPath in sensitive dir", async () => {
    const { homedir } = await import("os");
    const sensitiveOut = join(homedir(), ".ssh", "test-export.json");
    const r = await client.callTool({ name: "wiki_export", arguments: { outputPath: sensitiveOut } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("오류");
    expect(text).not.toContain("내보내기 완료");
  });

  it("wiki_import rejects inputPath in sensitive dir", async () => {
    const { homedir } = await import("os");
    const sensitiveIn = join(homedir(), ".ssh", "test-import.json");
    const r = await client.callTool({ name: "wiki_import", arguments: { inputPath: sensitiveIn } });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("오류");
  });
});
