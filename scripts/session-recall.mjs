#!/usr/bin/env node
// SessionStart hook — writes session marker + injects recall context as additionalContext
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BRAIN_DIR = process.env.OH_MY_ADHD_DIR ?? join(homedir(), ".oh-my-adhd");
const MANIFEST = join(BRAIN_DIR, "threads", ".manifest.json");

// Generate unique session ID and write per-session start marker
try {
  mkdirSync(BRAIN_DIR, { recursive: true });
  const sid = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  writeFileSync(join(BRAIN_DIR, `.session-start-${sid}`), String(Date.now()));
  writeFileSync(join(BRAIN_DIR, ".session-current"), sid);
} catch { /* non-fatal */ }

// Build recall context from manifest
try {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  if (!Array.isArray(manifest) || manifest.length === 0) process.exit(0);

  const now = Date.now();
  const gapLabel = (updatedAt) => {
    const h = Math.max(0, Math.round((now - new Date(updatedAt).getTime()) / 3600000));
    if (h < 1) return "방금 전";
    if (h < 18) return `${h}시간 전`;
    if (h < 36) return "어제";
    return `${Math.floor(h / 24)}일 전`;
  };

  const openThreads = manifest.filter(t => t.is_open).slice(0, 4);
  if (openThreads.length === 0) process.exit(0);

  const sanitize = (s, max) => String(s ?? "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/[`$<>]/g, "")
    .replace(/\bignore (all|previous)\b/gi, "[redacted]")
    .slice(0, max);

  const lines = ["[Second Brain 복원]", ""];
  const top = openThreads[0];
  lines.push(`🔴 **${sanitize(top.title, 40)}** (${gapLabel(top.updatedAt)})`);
  if (top.next_action) lines.push(`→ 다음: ${sanitize(top.next_action, 100)}`);
  if (top.blocker) lines.push(`⛔ 막힌것: ${sanitize(top.blocker, 80)}`);

  if (openThreads.length > 1) {
    lines.push("");
    for (const t of openThreads.slice(1)) {
      const hint = t.next_action ? ` → ${sanitize(t.next_action, 60)}` : "";
      lines.push(`• ${sanitize(t.title, 30)} (${gapLabel(t.updatedAt)})${hint}`);
    }
  }

  lines.push("");
  lines.push(`이어서 갈까? thread: \`${top.id}\``);

  // Cap additionalContext to prevent context bloat
  const MAX_CHARS = 3500;
  const context = lines.join("\n");
  const capped = context.length > MAX_CHARS
    ? context.slice(0, MAX_CHARS) + "\n...[더 보려면 wiki_query 사용]"
    : context;

  process.stdout.write(JSON.stringify({ additionalContext: capped }));
} catch {
  process.exit(0);
}
