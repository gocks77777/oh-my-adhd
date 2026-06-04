import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawn } from "child_process";

const SESSION_RECALL = resolve(__dirname, "../../scripts/session-recall.mjs");

let brainDir: string;
let transcriptDir: string;

// Run the SessionStart hook, optionally feeding hook-input JSON via stdin.
function runSessionRecall(stdinPayload?: object): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [SESSION_RECALL], {
      env: { ...process.env, OH_MY_ADHD_DIR: brainDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolvePromise({ stdout, code: code ?? 0 }));
    if (stdinPayload !== undefined) {
      child.stdin.write(JSON.stringify(stdinPayload));
    }
    child.stdin.end();
  });
}

function makeTranscript(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function assistantToolUse(content: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "wiki_dump", input: { content } }] },
  };
}

function assistantText(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

beforeEach(async () => {
  brainDir = await mkdtemp(join(tmpdir(), "oma-recall-"));
  transcriptDir = await mkdtemp(join(tmpdir(), "oma-transcript-"));
  await mkdir(join(brainDir, "threads"), { recursive: true });
});

afterEach(async () => {
  await rm(brainDir, { recursive: true, force: true });
  await rm(transcriptDir, { recursive: true, force: true });
});

describe("session-recall: graceful path unchanged", () => {
  it("does not auto-recover when there is no transcript_path on stdin", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    const { stdout } = await runSessionRecall({});
    expect(stdout).not.toContain("자동 복원된 내용");
  });

  it("does not auto-recover when .last-dump is newer than .session-start (graceful exit)", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 2000));
    await writeFile(join(brainDir, ".last-dump"), String(Date.now()));
    const prev = join(transcriptDir, "prev.jsonl");
    await writeFile(prev, makeTranscript([assistantToolUse("요약: 그레이스풀")]));
    const { stdout } = await runSessionRecall({
      transcript_path: join(transcriptDir, "current.jsonl"),
    });
    expect(stdout).not.toContain("자동 복원된 내용");
  });
});

describe("session-recall: ungraceful exit recovery", () => {
  it("recovers wiki_dump tool_use content from previous transcript", async () => {
    // ungraceful: session-start exists, no .last-dump after it
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    const prev = join(transcriptDir, "prev.jsonl");
    await writeFile(
      prev,
      makeTranscript([
        assistantText("작업 시작"),
        assistantToolUse("결정: A로 간다\n막힌것: 빌드 실패\n다음할것: tsconfig 수정\n요약: 자동복원 구현"),
      ])
    );
    const { stdout } = await runSessionRecall({
      transcript_path: join(transcriptDir, "current.jsonl"),
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain("자동 복원된 내용");
    expect(parsed.additionalContext).toContain("tsconfig 수정");
    expect(parsed.additionalContext).toContain("빌드 실패");
    expect(parsed.additionalContext).toContain("자동복원 구현");
  });

  it("falls back to structured fields in the last assistant text when no wiki_dump exists", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    const prev = join(transcriptDir, "prev.jsonl");
    await writeFile(
      prev,
      makeTranscript([
        assistantText("결정: 텍스트에서 추출\n다음할것: 텍스트 폴백 검증\n요약: 폴백 경로"),
      ])
    );
    const { stdout } = await runSessionRecall({
      transcript_path: join(transcriptDir, "current.jsonl"),
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain("자동 복원된 내용");
    expect(parsed.additionalContext).toContain("텍스트 폴백 검증");
    expect(parsed.additionalContext).toContain("폴백 경로");
  });

  it("uses the most-recent transcript and excludes the current session file", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    const older = join(transcriptDir, "older.jsonl");
    const newer = join(transcriptDir, "newer.jsonl");
    const current = join(transcriptDir, "current.jsonl");
    await writeFile(older, makeTranscript([assistantToolUse("요약: 오래된거")]));
    // ensure mtime ordering
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(newer, makeTranscript([assistantToolUse("요약: 최신거")]));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(current, makeTranscript([assistantToolUse("요약: 현재세션이라제외")]));
    const { stdout } = await runSessionRecall({ transcript_path: current });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain("최신거");
    expect(parsed.additionalContext).not.toContain("현재세션이라제외");
    expect(parsed.additionalContext).not.toContain("오래된거");
  });

  it("places auto-recovered block before manifest recall context", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    await writeFile(
      join(brainDir, "threads", ".manifest.json"),
      JSON.stringify([
        { id: "t1", title: "열린작업", is_open: true, updatedAt: new Date().toISOString(), capture_count: 1 },
      ])
    );
    const prev = join(transcriptDir, "prev.jsonl");
    await writeFile(prev, makeTranscript([assistantToolUse("요약: 복원먼저")]));
    const { stdout } = await runSessionRecall({
      transcript_path: join(transcriptDir, "current.jsonl"),
    });
    const ctx = JSON.parse(stdout).additionalContext as string;
    expect(ctx).toContain("자동 복원된 내용");
    expect(ctx).toContain("열린작업");
    expect(ctx.indexOf("자동 복원된 내용")).toBeLessThan(ctx.indexOf("열린작업"));
  });

  it("writes .auto-recovered.json after recovery", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    const prev = join(transcriptDir, "prev.jsonl");
    await writeFile(prev, makeTranscript([assistantToolUse("요약: 파일저장확인")]));
    await runSessionRecall({ transcript_path: join(transcriptDir, "current.jsonl") });
    const { readFile } = await import("fs/promises");
    const saved = JSON.parse(await readFile(join(brainDir, ".auto-recovered.json"), "utf-8"));
    expect(saved.fields.summary).toBe("파일저장확인");
    expect(saved.source).toBe("wiki_dump");
  });
});
