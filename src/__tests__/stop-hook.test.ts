import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const STOP_HOOK = resolve(__dirname, "../../scripts/stop-hook.mjs");

let brainDir: string;

async function runStopHook() {
  try {
    const { stdout, stderr } = await execFileP("node", [STOP_HOOK], {
      env: { ...process.env, OH_MY_ADHD_DIR: brainDir },
      timeout: 5_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

beforeEach(async () => {
  brainDir = await mkdtemp(join(tmpdir(), "oma-stop-hook-"));
  await mkdir(join(brainDir, "threads"), { recursive: true });
});

afterEach(async () => {
  await rm(brainDir, { recursive: true, force: true });
});

describe("stop-hook: session matching", () => {
  it("does not block when .session-start is missing", async () => {
    const { stdout, code } = await runStopHook();
    expect(code).toBe(0);
    expect(stdout).not.toContain("block");
  });

  it("does not block when there are no open threads", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    await writeFile(
      join(brainDir, "threads", ".manifest.json"),
      JSON.stringify([{ id: "t1", title: "done", is_open: false, updatedAt: new Date().toISOString(), capture_count: 1 }])
    );
    const { stdout, code } = await runStopHook();
    expect(code).toBe(0);
    expect(stdout).not.toContain("block");
  });

  it("blocks when .session-start exists, open thread present, no .last-dump", async () => {
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 1000));
    await writeFile(
      join(brainDir, "threads", ".manifest.json"),
      JSON.stringify([{ id: "t1", title: "open task", is_open: true, updatedAt: new Date().toISOString(), capture_count: 1 }])
    );
    const { stdout } = await runStopHook();
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("open task");
  });

  it("does not block when .last-dump is newer than .session-start", async () => {
    const start = Date.now() - 2000;
    await writeFile(join(brainDir, ".session-start"), String(start));
    await writeFile(join(brainDir, ".last-dump"), String(Date.now()));
    await writeFile(
      join(brainDir, "threads", ".manifest.json"),
      JSON.stringify([{ id: "t1", title: "open task", is_open: true, updatedAt: new Date().toISOString(), capture_count: 1 }])
    );
    const { stdout, code } = await runStopHook();
    expect(code).toBe(0);
    expect(stdout).not.toContain("block");
  });

  it("blocks when .last-dump is older than .session-start", async () => {
    const oldDump = Date.now() - 5000;
    const sessionStart = Date.now() - 1000;
    await writeFile(join(brainDir, ".last-dump"), String(oldDump));
    await writeFile(join(brainDir, ".session-start"), String(sessionStart));
    await writeFile(
      join(brainDir, "threads", ".manifest.json"),
      JSON.stringify([{ id: "t1", title: "open task", is_open: true, updatedAt: new Date().toISOString(), capture_count: 1 }])
    );
    const { stdout } = await runStopHook();
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe("block");
  });
});
