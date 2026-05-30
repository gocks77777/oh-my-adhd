import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Module-level constants in brain.ts capture BRAIN_DIR at import time, so we
// must set OH_MY_ADHD_DIR and reset modules before each test for isolation.
type BrainModule = typeof import("../lib/brain.js");
let brain: BrainModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "oh-my-adhd-test-"));
  process.env.OH_MY_ADHD_DIR = tmpDir;
  vi.resetModules();
  brain = await import("../lib/brain.js");
});

afterEach(async () => {
  delete process.env.OH_MY_ADHD_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function readManifest(): Promise<any[]> {
  const raw = await readFile(join(tmpDir, "threads", ".manifest.json"), "utf-8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// saveCapture — basic write + manifest cache fields
// ---------------------------------------------------------------------------
describe("saveCapture: basic write + manifest cache fields", () => {
  it("writes thread file and manifest on first capture", async () => {
    const { threadId } = await brain.saveCapture("요약: 첫 캡처\n결정: 완료");
    const threadFile = await readFile(join(tmpDir, "threads", `${threadId}.md`), "utf-8");
    expect(threadFile).toContain("# 첫 캡처");
    expect(threadFile).toContain("결정: 완료");
    const manifest = await readManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].id).toBe(threadId);
  });

  it("sets is_open=true when content has 다음할것 field", async () => {
    await brain.saveCapture("요약: 작업중\n다음할것: 테스트 추가");
    const manifest = await readManifest();
    expect(manifest[0].is_open).toBe(true);
  });

  it("sets is_open=false when content has only 결정 field", async () => {
    await brain.saveCapture("결정: 완료된 결정");
    const manifest = await readManifest();
    expect(manifest[0].is_open).toBe(false);
  });

  it("sets is_done=false when is_open=true even if 상태: 완료 present", async () => {
    await brain.saveCapture("다음할것: 후속 작업\n상태: 완료");
    const manifest = await readManifest();
    expect(manifest[0].is_open).toBe(true);
    expect(manifest[0].is_done).toBe(false);
  });

  it("sets is_done=true when content has 상태: 완료 and no open signals", async () => {
    await brain.saveCapture("결정: 배포\n상태: 완료");
    const manifest = await readManifest();
    expect(manifest[0].is_done).toBe(true);
    expect(manifest[0].is_open).toBe(false);
  });

  it("truncates last_action to 160 chars with newlines collapsed", async () => {
    const longContent = "결정: " + "가".repeat(200) + "\n다음할것: 줄바꿈\n블로커: 줄2";
    await brain.saveCapture(longContent);
    const manifest = await readManifest();
    expect(manifest[0].last_action.length).toBeLessThanOrEqual(160);
    expect(manifest[0].last_action).not.toContain("\n");
  });

  it("capture_count=1 on first write, increments to 2 on second write", async () => {
    const { threadId } = await brain.saveCapture("결정: 첫 번째");
    let manifest = await readManifest();
    expect(manifest[0].capture_count).toBe(1);

    await brain.saveCapture("결정: 두 번째", threadId);
    manifest = await readManifest();
    expect(manifest[0].capture_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// saveCapture — dedup end-to-end
// ---------------------------------------------------------------------------
describe("saveCapture: dedup end-to-end", () => {
  it("skipped=true when same content written twice to same thread", async () => {
    const content = "결정: 중복 테스트";
    const first = await brain.saveCapture(content);
    expect(first.skipped).toBe(false);
    const second = await brain.saveCapture(content, first.threadId);
    expect(second.skipped).toBe(true);
  });

  it("skipped=false when content differs", async () => {
    const first = await brain.saveCapture("결정: 내용 A");
    const second = await brain.saveCapture("결정: 내용 B", first.threadId);
    expect(second.skipped).toBe(false);
  });

  it("skipped=true even when git suffix differs", async () => {
    const first = await brain.saveCapture("요약: 같은 핵심\n[git: abc1234 main]");
    const second = await brain.saveCapture(
      "요약: 같은 핵심\n[git: def5678 feature]",
      first.threadId
    );
    expect(second.skipped).toBe(true);
  });

  it("does NOT skip when 결정 field content differs", async () => {
    const first = await brain.saveCapture("결정: 결정 A 내용");
    const second = await brain.saveCapture("결정: 결정 B 내용", first.threadId);
    expect(second.skipped).toBe(false);
    const manifest = await readManifest();
    expect(manifest[0].capture_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getThreads — fallback (no manifest)
// ---------------------------------------------------------------------------
describe("getThreads: fallback when manifest absent", () => {
  it("scans directory when manifest absent, returns correct threads with signal fields", async () => {
    await brain.ensureBrainDirs();
    const fakeId = "550e8400-e29b-41d4-a716-446655440000";
    const threadFile = join(tmpDir, "threads", `${fakeId}.md`);
    const body = `# 디렉토리 스캔 테스트\n\n_created: 2026-01-01T00:00:00Z_\n\n---\n**2026-01-01T00:00:00Z**\n\n요약: 스캔 결과\n다음할것: 무언가\n`;
    await writeFile(threadFile, body, "utf-8");

    const threads = await brain.getThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(fakeId);
    expect(threads[0].title).toBe("디렉토리 스캔 테스트");
    expect(threads[0].is_open).toBe(true);
    expect(threads[0].capture_count).toBe(1);
  });

  it("creates manifest after directory scan", async () => {
    await brain.ensureBrainDirs();
    const fakeId = "11111111-2222-3333-4444-555555555555";
    await writeFile(
      join(tmpDir, "threads", `${fakeId}.md`),
      `# After scan\n\n---\n**ts**\n\n결정: 완료\n`,
      "utf-8"
    );
    await brain.getThreads();
    const manifest = await readManifest();
    expect(manifest.find((m) => m.id === fakeId)).toBeTruthy();
  });

  it("returns empty array when threads dir has no .md files", async () => {
    await brain.ensureBrainDirs();
    const threads = await brain.getThreads();
    expect(threads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("saveCapture: edge cases", () => {
  it("rejects invalid threadId format", async () => {
    await expect(brain.saveCapture("결정: x", "not-a-uuid")).rejects.toThrow(/Invalid threadId/);
  });

  it("preserves original title on second capture (title from file header, not new content)", async () => {
    const first = await brain.saveCapture("요약: 원래 제목");
    expect(first.title).toBe("원래 제목");
    const second = await brain.saveCapture("요약: 바뀐 제목", first.threadId);
    expect(second.title).toBe("원래 제목");
    const manifest = await readManifest();
    expect(manifest[0].title).toBe("원래 제목");
  });
});

// ---------------------------------------------------------------------------
// Concurrency: 10 parallel saveCapture to same threadId
// ---------------------------------------------------------------------------
describe("saveCapture: concurrency", () => {
  it("all 10 parallel captures land without loss", async () => {
    const { threadId } = await brain.saveCapture("요약: 첫 캡처");
    const N = 10;
    await Promise.all(
      Array.from({ length: N - 1 }, (_, i) =>
        brain.saveCapture(`결정: 병렬 캡처 ${i + 2}`, threadId)
      )
    );
    const manifest = await readManifest();
    const entry = manifest.find((m: any) => m.id === threadId);
    expect(entry?.capture_count).toBe(N);
  });

  it("corrupt manifest is backed up and returns empty array", async () => {
    await brain.ensureBrainDirs();
    const manifestPath = join(tmpDir, "threads", ".manifest.json");
    await writeFile(manifestPath, "{ broken json ::::", "utf-8");
    const threads = await brain.getThreads();
    expect(Array.isArray(threads)).toBe(true);
    const files = await readdir(join(tmpDir, "threads"));
    const backups = files.filter(f => f.startsWith(".manifest.json.corrupt."));
    expect(backups.length).toBeGreaterThan(0);
  });
});
