import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

type BrainModule = typeof import("../lib/brain.js");
let brain: BrainModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "oma-plc-"));
  process.env.OH_MY_ADHD_DIR = tmpDir;
  vi.resetModules();
  brain = await import("../lib/brain.js");
});

afterEach(async () => {
  delete process.env.OH_MY_ADHD_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

// A thread file is a markdown header + one or more capture blocks separated by \n---\n.
function threadFile(...captures: string[]): string {
  const header = "# 테스트 스레드\n\n_created: 2026-01-01T00:00:00.000Z_\n";
  return header + captures
    .map((c) => `\n---\n**2026-01-01T00:00:00.000Z**\n\n${c}\n`)
    .join("");
}

describe("parseLastCapture", () => {
  it("returns empty signals for a header-only file (no captures)", () => {
    const sig = brain.parseLastCapture("# 빈 스레드\n\n_created: x_\n");
    expect(sig.capture_count).toBe(0);
    expect(sig.is_open).toBe(false);
    expect(sig.is_done).toBe(false);
    expect(sig.next_action).toBe("");
    expect(sig.blocker).toBe("");
  });

  it("parses signals from the LAST capture only", () => {
    const file = threadFile(
      "다음할것: 옛날 액션\n요약: 첫 캡처",
      "다음할것: 최신 액션\n막힌것: 최신 블로커\n요약: 마지막 캡처",
    );
    const sig = brain.parseLastCapture(file);
    expect(sig.capture_count).toBe(2);
    expect(sig.next_action).toBe("최신 액션");
    expect(sig.blocker).toBe("최신 블로커");
  });

  it("marks is_open when 다음할것 present and not done", () => {
    const sig = brain.parseLastCapture(threadFile("다음할것: 배포\n요약: 진행중"));
    expect(sig.is_open).toBe(true);
    expect(sig.is_done).toBe(false);
  });

  it("marks is_done and clears is_open when 상태: 완료", () => {
    const sig = brain.parseLastCapture(threadFile("다음할것: 무언가\n상태: 완료됨"));
    expect(sig.is_done).toBe(true);
    expect(sig.is_open).toBe(false);
  });

  it("treats a 결정-only capture as not open", () => {
    const sig = brain.parseLastCapture(threadFile("결정: 끝난 결정"));
    expect(sig.is_open).toBe(false);
    expect(sig.is_done).toBe(false);
  });

  it("strips the bold timestamp header from last_action", () => {
    const sig = brain.parseLastCapture(threadFile("요약: 헤더 제거 확인"));
    expect(sig.last_action).not.toContain("**");
    expect(sig.last_action).toContain("헤더 제거 확인");
  });

  it("caps next_action and blocker at 120 chars", () => {
    const long = "가".repeat(200);
    const sig = brain.parseLastCapture(threadFile(`다음할것: ${long}\n막힌것: ${long}`));
    expect(sig.next_action.length).toBe(120);
    expect(sig.blocker.length).toBe(120);
  });

  it("agrees with the manifest cache written by saveCapture", async () => {
    const { threadId } = await brain.saveCapture("다음할것: 일치 확인\n막힌것: 동기화\n요약: 캐시 비교");
    const file = await brain.getThread(threadId);
    expect(file).not.toBeNull();
    const sig = brain.parseLastCapture(file!);
    expect(sig.is_open).toBe(true);
    expect(sig.next_action).toBe("일치 확인");
    expect(sig.blocker).toBe("동기화");
  });
});
