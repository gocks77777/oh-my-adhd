#!/usr/bin/env node
// oh-my-adhd Stop hook — blocks session end if no wiki_dump happened this session
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Escape hatch: OMC_FORCE_EXIT=1 bypasses the block
if (process.env.OMC_FORCE_EXIT === "1") process.exit(0);

const BRAIN_DIR = process.env.OH_MY_ADHD_DIR ?? join(homedir(), ".oh-my-adhd");
const MANIFEST = join(BRAIN_DIR, "threads", ".manifest.json");

// Use parent PID (= Claude Code instance) as session discriminator
const ppid = process.ppid;
// If ppid is unavailable, skip protection rather than risk a shared-file collision
if (!ppid) process.exit(0);
const SESSION_START_FILE = join(BRAIN_DIR, `.session-start-${ppid}`);
const LAST_DUMP_FILE = join(BRAIN_DIR, `.last-dump-${ppid}`);

try {
  const sessionStartMs = parseInt(readFileSync(SESSION_START_FILE, "utf-8").trim(), 10);
  if (isNaN(sessionStartMs)) process.exit(0); // no marker — don't block

  // Allow stop if wiki_dump was called this session
  try {
    const lastDumpMs = parseInt(readFileSync(LAST_DUMP_FILE, "utf-8").trim(), 10);
    if (!isNaN(lastDumpMs) && lastDumpMs > sessionStartMs) process.exit(0);
  } catch { /* no dump file = no dump this session */ }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  } catch {
    process.exit(0); // no manifest — nothing to protect
  }

  // Block only if there are open threads worth saving
  const openThreads = manifest.filter(t => t.is_open);
  if (openThreads.length > 0) {
    const top = openThreads[0];
    const sanitize = (s, max) => String(s ?? "")
      .replace(/[^ -~가-힣㄰-㆏ᄀ-ᇿ]/g, " ")
      .replace(/[`$<>]/g, "")
      .replace(/\bignore (all|previous)\b/gi, "[redacted]")
      .slice(0, max);
    const title = sanitize(top.title ?? "진행중인 작업", 40);
    const nextHint = top.next_action ? `\n→ 다음할것: ${sanitize(top.next_action, 60)}` : "";
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `저장 없이 끝내려고? "${title}" 스레드가 열려있어.${nextHint}\nwiki_dump로 결정/막힌것/다음할것 저장하고 끝내자.\n(강제 종료: OMC_FORCE_EXIT=1 환경변수 설정 후 재시도)`,
    }));
  }
} catch {
  // Graceful degradation — never block due to script error
}
