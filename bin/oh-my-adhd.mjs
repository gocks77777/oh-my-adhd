#!/usr/bin/env node
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
const BRAIN_DIR = join(homedir(), ".oh-my-adhd");
const cmd = process.argv[2];

function ensureBrainDir() {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
    mkdirSync(join(BRAIN_DIR, "threads"), { recursive: true });
    mkdirSync(join(BRAIN_DIR, "pages"), { recursive: true });
    console.log(`✓ Brain directory created at ${BRAIN_DIR}`);
  }
}

function printHelp() {
  console.log(`
oh-my-adhd — ADHD second brain for Claude Code

Usage:
  npx oh-my-adhd <command>

Commands:
  init        One-line setup: MCP server + hooks + brain directory
  doctor      설치 상태 자가진단 (MCP 등록, 훅, 데이터 무결성)
  mcp         Start the MCP server manually (for Claude Desktop)
  help        Show this help

Quick start:
  npx oh-my-adhd init
  # Restart Claude Code — done.
`);
}

switch (cmd) {
  case "init": {
    ensureBrainDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // ── 1. ~/.claude.json — MCP 서버 등록 ──────────────────────────────
    const claudeJsonPath = join(homedir(), ".claude.json");
    let claudeJson = {};
    if (existsSync(claudeJsonPath)) {
      copyFileSync(claudeJsonPath, `${claudeJsonPath}.bak.${timestamp}`);
      try {
        const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          claudeJson = parsed;
        } else {
          console.error(`오류: ${claudeJsonPath} 형식이 올바르지 않습니다. 백업(${claudeJsonPath}.bak.${timestamp})을 확인하세요.`);
          process.exit(1);
        }
      } catch (e) {
        console.error(`오류: ${claudeJsonPath} JSON 파싱 실패 — ${e}\n백업: ${claudeJsonPath}.bak.${timestamp}`);
        process.exit(1);
      }
    }
    claudeJson.mcpServers = claudeJson.mcpServers || {};
    claudeJson.mcpServers["oh-my-adhd"] = {
      command: "npx",
      args: ["--yes", "oh-my-adhd@latest", "mcp"],
    };
    writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n", "utf8");
    console.log(`✓ MCP server registered in ${claudeJsonPath}`);

    // ── 2. ~/.claude/settings.json — hooks 추가 ────────────────────────
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, "settings.json");
    let settings = {};
    if (existsSync(settingsPath)) {
      copyFileSync(settingsPath, `${settingsPath}.bak.${timestamp}`);
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          settings = parsed;
        } else {
          console.error(`오류: ${settingsPath} 형식이 올바르지 않습니다. 백업을 확인하세요.`);
          process.exit(1);
        }
      } catch (e) {
        console.error(`오류: ${settingsPath} JSON 파싱 실패 — ${e}`);
        process.exit(1);
      }
    }

    settings.hooks = settings.hooks || {};

    // SessionStart: run via npx subcommand so the hook path survives npx cache clears
    // (wiki_recall MCP call is avoided at startup to prevent chicken-and-egg MCP startup errors)
    settings.hooks.SessionStart = settings.hooks.SessionStart || [];

    // Remove legacy hooks: mcp_tool wiki_recall, inline writeFileSync timestamps, and old absolute-path node calls
    settings.hooks.SessionStart = settings.hooks.SessionStart.map((entry) => {
      if (!Array.isArray(entry.hooks)) return entry;
      const filtered = entry.hooks.filter(
        (h) => !(h.type === "mcp_tool" && h.server === "oh-my-adhd" && h.tool === "wiki_recall") &&
               !(h.type === "command" && h.command?.includes("writeFileSync") && h.command?.includes(".session-start")) &&
               !(h.type === "command" && h.command?.includes("session-recall.mjs"))
      );
      return filtered.length === 0 ? null : { ...entry, hooks: filtered };
    }).filter(Boolean);

    const alreadyHasSessionRecall = settings.hooks.SessionStart.some((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some(
        (h) => h.type === "command" && h.command?.includes("oh-my-adhd") && h.command?.includes("session-recall")
      )
    );
    if (!alreadyHasSessionRecall) {
      settings.hooks.SessionStart.push({
        hooks: [{ type: "command", command: "npx --yes oh-my-adhd session-recall", timeout: 15 }],
      });
    }

    // Stop: enforce wiki_dump via blocking hook (outputs {"decision":"block",...} if no dump happened)
    settings.hooks.Stop = settings.hooks.Stop || [];
    const alreadyHasStop = settings.hooks.Stop.some((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some(
        (h) => typeof h.command === "string" && h.command.includes("stop-hook")
      )
    );
    if (!alreadyHasStop) {
      // Remove legacy echo-only Stop hooks and old absolute-path node calls
      settings.hooks.Stop = settings.hooks.Stop.filter((entry) =>
        !Array.isArray(entry.hooks) || !entry.hooks.some(
          (h) => typeof h.command === "string" && (
            (h.command.includes("wiki_dump") && h.command.startsWith("echo")) ||
            h.command.includes("stop-hook.mjs")
          )
        )
      );
      settings.hooks.Stop.push({
        hooks: [{ type: "command", command: "npx --yes oh-my-adhd stop-hook", timeout: 15 }],
      });
    }

    const settingsTmp = `${settingsPath}.tmp.${randomUUID()}`;
    writeFileSync(settingsTmp, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(settingsTmp, settingsPath);
    console.log(`✓ Hooks registered in ${settingsPath}`);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  ✓ Brain    " + BRAIN_DIR);
    console.log("  ✓ MCP      oh-my-adhd 등록됨");
    console.log("  ✓ Hooks    SessionStart + Stop");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // ── 3. Interactive seed — user's own first memory ─────────────────────
    const threadsDir = join(BRAIN_DIR, "threads");
    const manifestPath = join(threadsDir, ".manifest.json");
    const existingManifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : [];

    if (existingManifest.length === 0) {
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = (q) => new Promise((resolve) => rl.question(q, resolve));

      let userTask = "", userBlocker = "", userNextStep = "";

      try {
        if (!process.stdin.isTTY) {
          rl.close();
        } else {
          console.log("지금 작업 중인 게 뭐야? (한 줄, 엔터로 건너뛰기)");
          userTask = await question("> ");
          if (userTask.trim()) {
            console.log("막힌 거 있어? (없으면 엔터)");
            userBlocker = await question("> ");
            console.log("다음 한 발자국은? (없으면 엔터)");
            userNextStep = await question("> ");
          }
          rl.close();
        }
      } catch {
        rl.close();
      }

      const seedId = randomUUID();
      const seedTs = new Date().toISOString();

      if (userTask.trim()) {
        const contentLines = [`요약: ${userTask.trim()}`];
        if (userNextStep.trim()) contentLines.push(`다음할것: ${userNextStep.trim()}`);
        if (userBlocker.trim()) contentLines.push(`막힌것: ${userBlocker.trim()}`);

        const seedContent = [
          `# ${userTask.trim().slice(0, 60)}`,
          ``,
          `_created: ${seedTs}_`,
          ``,
          `---`,
          `**${seedTs}**`,
          ``,
          ...contentLines,
        ].join("\n");

        writeFileSync(join(threadsDir, `${seedId}.md`), seedContent, "utf8");
        writeFileSync(manifestPath, JSON.stringify(
          [{
            id: seedId,
            title: userTask.trim().slice(0, 40),
            updatedAt: seedTs,
            is_open: true,
            last_action: contentLines.join(" "),
            next_action: userNextStep.trim().slice(0, 120),
            blocker: userBlocker.trim().slice(0, 120),
            capture_count: 1,
          }],
          null, 2
        ) + "\n", "utf8");

        console.log(`\n✓ 첫 기억 심었어.\n`);

        // Preview: show exactly what wiki_recall will output next session
        console.log("━━━ 다음번 Claude Code 열면 이게 첫 화면이야 ━━━\n");
        console.log("## 어제 멈춘 곳\n");
        console.log(`> 🔴 **${userTask.trim().slice(0, 50)}** — 방금 전`);
        if (userNextStep.trim()) console.log(`> → 다음: ${userNextStep.trim().slice(0, 80)}`);
        if (userBlocker.trim()) console.log(`> ⛔ 막힌것: ${userBlocker.trim().slice(0, 80)}`);
        console.log(`>`);
        console.log(`> 이어서 갈까? (thread: \`${seedId.slice(0, 8)}...\`)`);
        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("↑ 이게 매일 아침 Claude Code 열 때마다 자동으로 뜬다. 약속.\n");
      } else {
        const seedContent = [
          `# 첫 기억 (예시 — 지워도 됨)`,
          ``,
          `_created: ${seedTs}_`,
          ``,
          `---`,
          `**${seedTs}**`,
          ``,
          `결정: [이번 대화에서 확정된 것]`,
          `막힌것: [이미 시도해서 안 된 것 — 다음 세션 반복 방지]`,
          `다음할것: [지금 멈춘 시점의 다음 액션]`,
          `요약: wiki_dump 형식 예시 — 이 스레드에 덮어써도 됨`,
        ].join("\n");

        writeFileSync(join(threadsDir, `${seedId}.md`), seedContent, "utf8");
        writeFileSync(manifestPath, JSON.stringify(
          [{ id: seedId, title: "첫 기억 (예시)", updatedAt: seedTs, is_open: true, last_action: "다음할것: wiki_dump 형식으로 첫 작업 등록", capture_count: 1 }],
          null, 2
        ) + "\n", "utf8");

        console.log(`✓ 예시 기억 심어뒀어. wiki_dump로 진짜 작업을 덮어써.`);
      }
    } else {
      console.log(`✓ 기존 기억 보존됨 (${existingManifest.length}개 스레드)`);
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  이제 Claude Code 재시작 한 번만 하면 돼.");
    console.log("");
    console.log("  까먹어도 괜찮아. 그게 이 도구의 일이야.");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    break;
  }

  case "doctor": {
  const results = [];

  // 1. Brain directory
  if (existsSync(BRAIN_DIR)) {
    results.push(`✓ Brain dir: ${BRAIN_DIR}`);
    const versionFile = join(BRAIN_DIR, "VERSION");
    const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "unversioned";
    results.push(`  Schema version: ${version}`);
  } else {
    results.push(`✗ Brain dir 없음: ${BRAIN_DIR} — npx oh-my-adhd init 실행`);
  }

  // 2. Manifest
  const manifestPath = join(BRAIN_DIR, "threads", ".manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      results.push(`✓ Manifest: ${Array.isArray(manifest) ? manifest.length : "?"}개 스레드`);
    } catch (e) {
      results.push(`✗ Manifest 손상: ${e.message} — ${manifestPath}.corrupt.* 백업 확인`);
    }
  } else {
    results.push("⚠ Manifest 없음 (첫 wiki_dump 시 자동 생성)");
  }

  // 3. MCP registration
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const cfg = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
      const server = cfg?.mcpServers?.["oh-my-adhd"];
      if (server) {
        results.push(`✓ MCP 등록됨: command="${server.command}" args=${JSON.stringify(server.args)}`);
      } else {
        results.push("✗ MCP 미등록 — npx oh-my-adhd init 실행");
      }
    } catch {
      results.push("⚠ ~/.claude.json 파싱 불가");
    }
  } else {
    results.push("✗ ~/.claude.json 없음 — npx oh-my-adhd init 실행");
  }

  // 4. Hooks
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const hasRecall = (settings?.hooks?.SessionStart ?? []).some((entry) =>
        Array.isArray(entry.hooks) && entry.hooks.some(
          (h) => h.type === "command" && (
            h.command?.includes("session-recall") ||
            h.command?.includes(".session-start")
          )
        )
      );
      const hasStop = (settings?.hooks?.Stop ?? []).some((entry) =>
        Array.isArray(entry.hooks) && entry.hooks.some(
          (h) => typeof h.command === "string" && h.command.includes("stop-hook")
        )
      );
      results.push(hasRecall ? "✓ SessionStart 훅 (session-recall)" : "✗ SessionStart 훅 없음 — npx oh-my-adhd init 실행");
      results.push(hasStop ? "✓ Stop 훅 (블로킹 강제 저장)" : "✗ Stop 훅 없음 — npx oh-my-adhd init 실행");
    } catch {
      results.push("⚠ settings.json 파싱 불가");
    }
  } else {
    results.push("✗ ~/.claude/settings.json 없음 — npx oh-my-adhd init 실행");
  }

  // 5. Trash size
  const trashPath = join(BRAIN_DIR, ".trash");
  if (existsSync(trashPath)) {
    const trashFiles = readdirSync(trashPath);
    results.push(`ℹ Trash: ${trashFiles.length}개 파일 (수동 정리 가능: rm -rf ${trashPath})`);
  }

  // 6. Recent logs
  const logPath = join(BRAIN_DIR, "logs", "brain.log");
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const errors = lines.filter(l => l.includes("[ERROR]") || l.includes("[WARN]")).slice(-5);
    if (errors.length > 0) {
      results.push(`\n⚠ 최근 경고/에러 (최대 5개):`);
      errors.forEach(l => results.push("  " + l));
    } else {
      results.push("✓ 로그: 에러 없음");
    }
  }

  console.log("oh-my-adhd doctor\n");
  results.forEach(r => console.log(r));
  break;
}

  case "session-recall":
  case "stop-hook": {
    // Hook entry points — spawns the corresponding script; stdio inherited so Claude Code
    // receives additionalContext (session-recall) or block decision (stop-hook) from stdout
    const scriptName = cmd === "session-recall" ? "session-recall.mjs" : "stop-hook.mjs";
    const script = join(PROJECT_DIR, "scripts", scriptName);
    const proc = spawn(process.execPath, [script], { stdio: "inherit" });
    proc.on("error", () => process.exit(0));
    proc.on("exit", (code) => process.exit(code ?? 0));
    break;
  }

  case "mcp": {
    const serverDist = join(PROJECT_DIR, "dist/mcp/mcp/server.js");
    const serverSrc = join(PROJECT_DIR, "src/mcp/server.ts");
    const [execCmd, execArgs] = existsSync(serverDist)
      ? [process.execPath, [serverDist]]
      : ["npx", ["tsx", serverSrc]]; // fallback for dev (no build)
    const proc = spawn(execCmd, execArgs, { cwd: PROJECT_DIR, stdio: "inherit" });
    proc.on("error", (e) => { console.error("Failed to start MCP:", e.message); process.exit(1); });
    proc.on("exit", (code) => process.exit(code ?? 0));
    break;
  }

  default: {
    printHelp();
    break;
  }
}
