import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const BIN = resolve(__dirname, "../../bin/oh-my-adhd.mjs");

let home: string;

// Run the CLI with an isolated $HOME so it never touches the real ~/.oh-my-adhd
// or ~/.claude. stdin is inherited from the (non-TTY) test runner, so init's
// interactive seed prompt is skipped and the example seed path is taken.
async function runCli(args: string[], opts: { input?: string } = {}) {
  try {
    const { stdout, stderr } = await execFileP("node", [BIN, ...args], {
      env: { ...process.env, HOME: home, OH_MY_ADHD_DIR: join(home, ".oh-my-adhd") },
      timeout: 20_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oma-cli-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("CLI: init", () => {
  it("creates brain dir, registers MCP server, and adds hooks", async () => {
    const { stdout, code } = await runCli(["init"]);
    expect(code).toBe(0);
    expect(stdout).toContain("MCP server registered");
    expect(stdout).toContain("Hooks registered");

    const claudeJson = JSON.parse(await readFile(join(home, ".claude.json"), "utf-8"));
    expect(claudeJson.mcpServers["oh-my-adhd"]).toBeDefined();
    expect(claudeJson.mcpServers["oh-my-adhd"].command).toBe("npx");

    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
    const startHooks = JSON.stringify(settings.hooks.SessionStart);
    expect(startHooks).toContain("session-recall");
    const stopHooks = JSON.stringify(settings.hooks.Stop);
    expect(stopHooks).toContain("stop-hook");
  });

  it("is idempotent — running twice does not duplicate hooks", async () => {
    await runCli(["init"]);
    await runCli(["init"]);
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
    const recallCount = settings.hooks.SessionStart
      .flatMap((e: any) => e.hooks ?? [])
      .filter((h: any) => h.command?.includes("session-recall")).length;
    expect(recallCount).toBe(1);
    const stopCount = settings.hooks.Stop
      .flatMap((e: any) => e.hooks ?? [])
      .filter((h: any) => h.command?.includes("stop-hook")).length;
    expect(stopCount).toBe(1);
  });

  it("backs up an existing settings.json before writing", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: {} }), "utf-8");
    await runCli(["init"]);
    const { readdir } = await import("fs/promises");
    const files = await readdir(join(home, ".claude"));
    expect(files.some((f) => f.startsWith("settings.json.bak."))).toBe(true);
  });

  it("removes legacy mcp_tool wiki_recall SessionStart hook", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "mcp_tool", server: "oh-my-adhd", tool: "wiki_recall" }] }] },
    }), "utf-8");
    await runCli(["init"]);
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
    const serialized = JSON.stringify(settings.hooks.SessionStart);
    expect(serialized).not.toContain("mcp_tool");
    expect(serialized).toContain("session-recall");
  });

  it("exits non-zero on a corrupt .claude.json", async () => {
    await writeFile(join(home, ".claude.json"), "{ not valid json", "utf-8");
    const { code, stderr } = await runCli(["init"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("JSON");
  });
});

describe("CLI: doctor", () => {
  it("reports missing setup before init", async () => {
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("oh-my-adhd doctor");
    expect(stdout).toMatch(/MCP 미등록|\.claude\.json 없음/);
  });

  it("reports healthy setup after init", async () => {
    await runCli(["init"]);
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("✓ Brain dir");
    expect(stdout).toContain("✓ MCP 등록됨");
    expect(stdout).toContain("✓ SessionStart 훅");
    expect(stdout).toContain("✓ Stop 훅");
  });

  it("flags a corrupt manifest", async () => {
    await runCli(["init"]);
    await writeFile(join(home, ".oh-my-adhd", "threads", ".manifest.json"), "{bad", "utf-8");
    const { stdout } = await runCli(["doctor"]);
    expect(stdout).toContain("Manifest 손상");
  });
});

describe("CLI: help / unknown", () => {
  it("prints usage for help", async () => {
    const { stdout } = await runCli(["help"]);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("init");
    expect(stdout).toContain("doctor");
  });

  it("prints usage for an unknown command", async () => {
    const { stdout } = await runCli(["wat"]);
    expect(stdout).toContain("Usage:");
  });
});
