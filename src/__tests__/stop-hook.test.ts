import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

// ---------------------------------------------------------------------------
// End-to-end regression: wiki_dump → stop-hook session matching
// Catches the v0.2.30 bug where brain.ts wrote .last-dump-${ppid} but
// stop-hook.mjs read .last-dump — they never matched, so stop-hook always
// blocked even after wiki_dump was called.
// ---------------------------------------------------------------------------
describe("stop-hook: end-to-end regression (wiki_dump → stop-hook)", () => {
  let client: Client;

  beforeEach(async () => {
    process.env.OH_MY_ADHD_DIR = brainDir;
    vi.resetModules();
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const { registerWikiDump } = await import("../mcp/tools/wiki-dump.js");
    registerWikiDump(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterEach(async () => {
    await client.close();
    delete process.env.OH_MY_ADHD_DIR;
  });

  it("stop-hook passes after wiki_dump writes .last-dump with the same filename stop-hook reads", async () => {
    // Simulate session start
    await writeFile(join(brainDir, ".session-start"), String(Date.now() - 2000));

    // Call wiki_dump via MCP (this writes .last-dump via brain.ts)
    await client.callTool({
      name: "wiki_dump",
      arguments: { content: "요약: e2e 회귀 테스트\n다음할것: stop-hook 통과 확인" },
    });

    // stop-hook must NOT block — if brain.ts wrote .last-dump-${ppid} instead
    // of .last-dump, this would fail (reproducing the v0.2.30 bug)
    const { stdout, code } = await runStopHook();
    expect(code).toBe(0);
    expect(stdout).not.toContain("block");
  });
});
