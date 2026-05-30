#!/usr/bin/env node
// oh-my-adhd Stop hook — blocks session end if no wiki_dump happened this session
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BRAIN_DIR = process.env.OH_MY_ADHD_DIR ?? join(homedir(), ".oh-my-adhd");
const MANIFEST = join(BRAIN_DIR, "threads", ".manifest.json");
const SESSION_START_FILE = join(BRAIN_DIR, ".session-start");

try {
  const sessionStartMs = parseInt(readFileSync(SESSION_START_FILE, "utf-8").trim(), 10);
  if (isNaN(sessionStartMs)) process.exit(0); // no marker — don't block

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  } catch {
    process.exit(0); // no manifest — nothing to protect
  }

  // Allow stop if any dump happened after session start
  const latestDump = manifest.reduce((max, t) => {
    const ts = new Date(t.updatedAt).getTime();
    return ts > max ? ts : max;
  }, 0);
  if (latestDump > sessionStartMs) process.exit(0);

  // Block only if there are open threads worth saving
  const openThreads = manifest.filter(t => t.is_open);
  if (openThreads.length > 0) {
    const top = openThreads[0];
    const title = (top.title ?? "진행중인 작업").slice(0, 40);
    const nextHint = top.next_action ? `\n→ 다음할것: ${top.next_action.slice(0, 60)}` : "";
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `저장 없이 끝내려고? "${title}" 스레드가 열려있어.${nextHint}\nwiki_dump로 결정/막힌것/다음할것 저장하고 끝내자.`,
    }));
  }
} catch {
  // Graceful degradation — never block due to script error
}
