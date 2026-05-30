import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

export const BRAIN_DIR = process.env.OH_MY_ADHD_DIR ?? path.join(os.homedir(), ".oh-my-adhd");
const THREADS_DIR = path.join(BRAIN_DIR, "threads");
const PAGES_DIR = path.join(BRAIN_DIR, "pages");
const MANIFEST_FILE = path.join(THREADS_DIR, ".manifest.json");
const MANIFEST_LOCK_FILE = path.join(THREADS_DIR, ".manifest.lock");
const MANIFEST_LOCK_TTL_MS = 10_000;
const LOG_FILE = path.join(BRAIN_DIR, "logs", "brain.log");
const VERSION_FILE = path.join(BRAIN_DIR, "VERSION");
export const SCHEMA_VERSION = 1;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function appendLog(level: "INFO" | "WARN" | "ERROR", msg: string): Promise<void> {
  try {
    const entry = `${new Date().toISOString()} [${level}] ${msg}\n`;
    // Rotate log at 10MB
    try {
      const stat = await fs.stat(LOG_FILE);
      if (stat.size > 10 * 1024 * 1024) {
        await fs.rename(LOG_FILE, LOG_FILE + ".1").catch(() => {});
      }
    } catch { /* file may not exist yet */ }
    await fs.appendFile(LOG_FILE, entry, "utf-8");
  } catch { /* logging failures must never crash the server */ }
}

export async function ensureBrainDirs() {
  await fs.mkdir(THREADS_DIR, { recursive: true });
  await fs.mkdir(PAGES_DIR, { recursive: true });
  await fs.mkdir(path.join(BRAIN_DIR, "logs"), { recursive: true });
  try {
    await fs.access(VERSION_FILE);
  } catch {
    await fs.writeFile(VERSION_FILE, String(SCHEMA_VERSION), "utf-8");
  }
}

export interface Capture {
  id: string;
  content: string;
  timestamp: string;
  threadId?: string;
}

export interface Thread {
  id: string;
  title: string;
  captures: Capture[];
  updatedAt: string;
  is_open?: boolean;
  last_action?: string;
  capture_count?: number;
  is_done?: boolean;
  next_action?: string;
  blocker?: string;
}

export interface Page {
  slug: string;
  title: string;
  content: string;
  links: string[];
  updatedAt: string;
}

interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: string;
  is_open?: boolean;
  last_action?: string;
  capture_count?: number;
  is_done?: boolean;
  next_action?: string;
  blocker?: string;
}

async function acquireManifestFileLock(): Promise<boolean> {
  const content = JSON.stringify({ pid: process.pid, ts: Date.now() });
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      const fh = await fs.open(MANIFEST_LOCK_FILE, "wx");
      await fh.writeFile(content, "utf-8");
      await fh.close();
      return true;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        await fs.mkdir(path.dirname(MANIFEST_LOCK_FILE), { recursive: true }).catch(() => {});
        continue;
      }
      if (code !== "EEXIST") throw e;
      // Lock exists — check if stale
      try {
        const raw = await fs.readFile(MANIFEST_LOCK_FILE, "utf-8");
        const { ts } = JSON.parse(raw) as { pid: number; ts: number };
        if (Date.now() - ts > MANIFEST_LOCK_TTL_MS) {
          await fs.unlink(MANIFEST_LOCK_FILE).catch(() => {});
          continue; // retry immediately
        }
      } catch {
        // Lock file disappeared or is unreadable — retry
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return false; // timed out
}

async function releaseManifestFileLock(): Promise<void> {
  await fs.unlink(MANIFEST_LOCK_FILE).catch(() => {});
}

// Two-tier lock: in-process promise chain (fast) + cross-process file lock (safe)
let manifestLock: Promise<void> = Promise.resolve();
function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const acquired = await acquireManifestFileLock();
    if (!acquired) {
      await appendLog("WARN", "withManifestLock: cross-process lock timeout, proceeding with in-process lock only");
      // Proceed with in-process serialization only — better than losing the capture
    }
    try {
      return await fn();
    } finally {
      if (acquired) await releaseManifestFileLock();
    }
  };
  const result = manifestLock.then(run, run);
  manifestLock = result.then(() => undefined, () => undefined);
  return result;
}

export function withBrainLock<T>(fn: () => Promise<T>): Promise<T> {
  return withManifestLock(fn);
}

async function readManifest(): Promise<ThreadMeta[]> {
  try {
    const raw = await fs.readFile(MANIFEST_FILE, "utf-8");
    return JSON.parse(raw) as ThreadMeta[];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      process.stderr.write(`[oh-my-adhd] manifest parse error — rebuilding: ${e}\n`);
      try {
        await fs.copyFile(MANIFEST_FILE, `${MANIFEST_FILE}.corrupt.${Date.now()}`);
      } catch { /* ignore backup failure */ }
    }
    return [];
  }
}

async function writeManifest(threads: ThreadMeta[]): Promise<void> {
  const tmp = path.join(THREADS_DIR, `.tmp-manifest-${randomUUID()}`);
  await fs.writeFile(tmp, JSON.stringify(threads, null, 2), "utf-8");
  await fs.rename(tmp, MANIFEST_FILE);
}

export function extractFieldBrain(text: string, field: string): string {
  const lines = text.split("\n");
  const fieldRe = new RegExp(`^\\s*${field}\\s*:`, "i");
  const delimRe = /^\s*(?:결정|가설|막힌것|다음할것|블로커|요약|상태)\s*:/i;
  let capturing = false;
  const parts: string[] = [];
  for (const line of lines) {
    if (!capturing) {
      if (fieldRe.test(line)) {
        capturing = true;
        const val = line.replace(fieldRe, "").trim();
        if (val) parts.push(val);
      }
    } else {
      if (delimRe.test(line) || /^\[git:/i.test(line.trim())) break;
      const trimmed = line.trim();
      if (trimmed) parts.push(trimmed);
      else if (parts.length > 0) break;
    }
  }
  return parts.join(" ").trim();
}

// Strip git suffix appended by wiki_dump before title/dedup operations
export function stripGitSuffix(content: string): string {
  return content.trimEnd().replace(/\n\[git:.*\]$/, "").trimEnd();
}

export const OPEN_SIGNAL = /(?:^|\n)\s*(?:다음할것|블로커|막힌것|가설|next|blocked|todo|wip)\s*:\s*\S/i;
export const DONE_SIGNAL = /(?:^|\n)\s*상태:\s*[^\n]*(완료|해결됨|배포됨|종료|done|shipped|closed)/i;

export function extractTitle(content: string): string {
  const raw = stripGitSuffix(content);
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  // 구조화 dump: 요약 필드를 제목으로 — "결정: ..." 같은 첫 줄보다 의미있음
  const summary = lines.find(l => /^요약\s*:/i.test(l));
  const pick = summary ?? lines[0] ?? "";
  const clean = pick
    .replace(/^#+\s*/, "")
    .replace(/^(?:요약|결정|가설|막힌것|다음할것|블로커)\s*:\s*/i, "");
  return clean.trim().slice(0, 40) || raw.trim().slice(0, 40);
}

export async function saveCapture(
  content: string,
  threadId?: string
): Promise<{ capture: Capture; threadId: string; title: string; skipped: boolean }> {
  await ensureBrainDirs();

  const captureId = randomUUID();
  const timestamp = new Date().toISOString();
  const tid = threadId ?? captureId;
  if (!UUID_RE.test(tid)) {
    throw new Error(`Invalid threadId: ${tid}`);
  }
  const threadFile = path.join(THREADS_DIR, `${tid}.md`);

  const capture: Capture = { id: captureId, content, timestamp, threadId: tid };

  // Thread read→write AND manifest update serialized together
  // 같은 threadId로 동시 dump가 와도 append가 유실되지 않음
  let title = "";
  let skipped = false;

  await withManifestLock(async () => {
    let existingContent = "";
    try {
      existingContent = await fs.readFile(threadFile, "utf-8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }

    title = existingContent
      ? (existingContent.match(/^# (.+)/m)?.[1]?.trim() || extractTitle(content))
      : extractTitle(content);

    if (existingContent) {
      const blocks = existingContent.split(/\n---\n/);
      const lastBlock = blocks[blocks.length - 1] ?? "";
      const lastText = stripGitSuffix(
        lastBlock.trim().replace(/^\*\*[^*\n]+\*\*\s*\n*/, "").trim()
      );
      if (stripGitSuffix(content.trim()) === lastText) {
        skipped = true;
        return;
      }
    }

    const entry = `\n---\n**${timestamp}**\n\n${content}\n`;
    const header = existingContent
      ? existingContent
      : `# ${title}\n\n_created: ${timestamp}_\n`;

    const tmpThread = path.join(THREADS_DIR, `.tmp-${randomUUID()}`);
    await fs.writeFile(tmpThread, header + entry, "utf-8");
    await fs.rename(tmpThread, threadFile);

    const manifest = await readManifest();
    const idx = manifest.findIndex((m) => m.id === tid);

    // Compute signal cache fields from new content
    const stripped = stripGitSuffix(content).trim();
    const is_open = OPEN_SIGNAL.test(stripped) && !DONE_SIGNAL.test(stripped);
    const is_done = DONE_SIGNAL.test(stripped);
    const last_action = stripped.replace(/\n+/g, " ").slice(0, 160);
    const next_action = extractFieldBrain(stripped, "다음할것").slice(0, 120);
    const blocker = extractFieldBrain(stripped, "막힌것").slice(0, 120);
    const existingCount = existingContent
      ? existingContent.split(/\n---\n/).slice(1).filter((p) => p.trim()).length
      : 0;
    const capture_count = existingCount + 1;

    const meta: ThreadMeta = { id: tid, title, updatedAt: timestamp, is_open, last_action, capture_count, is_done, next_action, blocker };
    if (idx >= 0) manifest[idx] = meta;
    else manifest.push(meta);
    await writeManifest(
      manifest.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    );

    // Session-scoped dump marker — keyed by parent PID (= Claude Code instance PID)
    const ppid = process.ppid ?? 0;
    const lastDumpFile = path.join(BRAIN_DIR, ppid ? `.last-dump-${ppid}` : ".last-dump");
    await fs.writeFile(lastDumpFile, String(Date.now()), "utf-8").catch(() => {});
  });

  return { capture, threadId: tid, title, skipped };
}

export async function getThreads(): Promise<Thread[]> {
  await ensureBrainDirs();

  const manifest = await readManifest();

  if (manifest.length > 0) {
    return manifest.map((m) => ({ ...m, captures: [] }));
  }

  // Fallback: directory scan (first run or manifest missing)
  const files = await fs.readdir(THREADS_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md") && !f.startsWith(".") && !f.endsWith(".summary.md"));

  const results = await Promise.allSettled(
    mdFiles.map(async (file) => {
      const filePath = path.join(THREADS_DIR, file);
      const [content, stat] = await Promise.all([
        fs.readFile(filePath, "utf-8"),
        fs.stat(filePath),
      ]);
      const tid = file.replace(".md", "");
      const title = content.match(/^# (.+)/m)?.[1]?.trim() || tid;
      const scanCaptures = content.split(/\n---\n/).slice(1).filter((p) => p.trim());
      const lastCapture = scanCaptures.at(-1) ?? "";
      const fullText = lastCapture.replace(/^(?:_[^_\n]+_|\*\*[^*\n]+\*\*)\s*/m, "").trim();
      const is_open = OPEN_SIGNAL.test(fullText) && !DONE_SIGNAL.test(fullText);
      return {
        id: tid,
        title,
        captures: [] as Capture[],
        updatedAt: stat.mtime.toISOString(),
        is_open,
        last_action: fullText.replace(/\n+/g, " ").slice(0, 160),
        next_action: extractFieldBrain(fullText, "다음할것").slice(0, 120),
        blocker: extractFieldBrain(fullText, "막힌것").slice(0, 120),
        capture_count: scanCaptures.length,
        is_done: DONE_SIGNAL.test(fullText),
      };
    })
  );

  results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .forEach((r, i) => appendLog("WARN", `getThreads: failed to read ${mdFiles[i]}: ${r.reason}`));

  const threads = (results
    .filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Thread>[])
    .map((r) => r.value);

  const sorted = threads.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  // 락 안에서 재확인 — 동시 saveCapture가 이미 manifest를 썼을 경우 merge
  await withManifestLock(async () => {
    const current = await readManifest();
    const currentIds = new Set(current.map(m => m.id));
    const toAdd = sorted
      .filter(t => !currentIds.has(t.id))
      .map(({ id, title, updatedAt, is_open, last_action, next_action, blocker, capture_count, is_done }) =>
        ({ id, title, updatedAt, is_open, last_action, next_action, blocker, capture_count, is_done }));
    if (toAdd.length === 0) return;
    await writeManifest(
      [...current, ...toAdd].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    );
  });

  return sorted;
}

export async function getThread(threadId: string): Promise<string | null> {
  if (!threadId || !UUID_RE.test(threadId)) return null;
  try {
    return await fs.readFile(
      path.join(THREADS_DIR, `${threadId}.md`),
      "utf-8"
    );
  } catch {
    return null;
  }
}

export async function getPages(): Promise<Page[]> {
  await ensureBrainDirs();
  const files = await fs.readdir(PAGES_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md") && !f.startsWith("."));

  const results = await Promise.allSettled(
    mdFiles.map(async (file) => {
      const filePath = path.join(PAGES_DIR, file);
      const [content, stat] = await Promise.all([
        fs.readFile(filePath, "utf-8"),
        fs.stat(filePath),
      ]);
      const slug = file.replace(".md", "");
      const titleMatch = content.match(/^# (.+)/m);
      const title = titleMatch?.[1] ?? slug;
      const linkMatches = [...content.matchAll(/\[\[([^\]]+)\]\]/g)];
      const links = linkMatches.map((m) => m[1]);
      return { slug, title, content, links, updatedAt: stat.mtime.toISOString() };
    })
  );

  results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .forEach((r, i) => appendLog("WARN", `getPages: failed to read ${mdFiles[i]}: ${r.reason}`));

  return results
    .filter((r): r is PromiseFulfilledResult<Page> => r.status === "fulfilled")
    .map((r) => r.value);
}

export async function getPage(slug: string): Promise<Page | null> {
  const s = slug?.toLowerCase() ?? "";
  if (!s || s.includes("/") || s.includes("\\") || s.includes("..") || s.includes("\0") || !/^[a-z0-9가-힣-]+$/.test(s)) return null;
  try {
    const filePath = path.join(PAGES_DIR, `${s}.md`);
    const [content, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
    const titleMatch = content.match(/^# (.+)/m);
    const title = titleMatch?.[1] ?? slug;
    const linkMatches = [...content.matchAll(/\[\[([^\]]+)\]\]/g)];
    const links = linkMatches.map((m) => m[1]);
    return { slug, title, content, links, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

export async function savePage(slug: string, content: string): Promise<void> {
  const s = slug?.toLowerCase() ?? "";
  if (!s || s.includes("/") || s.includes("\\") || s.includes("..") || s.includes("\0") || !/^[a-z0-9가-힣-]+$/.test(s) || !/[a-z0-9가-힣]/.test(s)) {
    throw new Error(`Invalid slug: ${slug}`);
  }
  await ensureBrainDirs();
  const pageFile = path.join(PAGES_DIR, `${s}.md`);
  const tmpPage = path.join(PAGES_DIR, `.tmp-${randomUUID()}`);
  await fs.writeFile(tmpPage, content, "utf-8");
  await fs.rename(tmpPage, pageFile);
}

const TRASH_DIR = path.join(BRAIN_DIR, ".trash");

export async function deleteThread(threadId: string): Promise<void> {
  if (!UUID_RE.test(threadId)) {
    throw new Error(`Invalid threadId format: ${threadId}`);
  }
  await ensureBrainDirs();
  await fs.mkdir(TRASH_DIR, { recursive: true });

  const threadFile = path.join(THREADS_DIR, `${threadId}.md`);

  // Move to trash before deleting (backup)
  const trashFile = path.join(TRASH_DIR, `${threadId}-${Date.now()}.md`);
  try {
    await fs.rename(threadFile, trashFile);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    // File didn't exist — still remove from manifest
  }

  await withManifestLock(async () => {
    const manifest = await readManifest();
    const filtered = manifest.filter((m) => m.id !== threadId);
    if (filtered.length !== manifest.length) {
      await writeManifest(filtered);
    }
  });
}

export async function deletePage(slug: string): Promise<void> {
  const s = slug?.toLowerCase() ?? "";
  if (!s || s.includes("/") || s.includes("\\") || s.includes("..") || s.includes("\0") || !/^[a-z0-9가-힣-]+$/.test(s)) {
    throw new Error(`Invalid slug: ${slug}`);
  }
  await ensureBrainDirs();
  const pageFile = path.join(PAGES_DIR, `${s}.md`);
  try {
    await fs.unlink(pageFile);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    throw new Error(`Page not found: ${slug}`);
  }
}

// Exported for consolidate.ts to update manifest entries after trimming
export async function updateManifestEntry(id: string, fields: Partial<ThreadMeta>): Promise<void> {
  await ensureBrainDirs();
  await withManifestLock(async () => {
    const manifest = await readManifest();
    const idx = manifest.findIndex((m) => m.id === id);
    if (idx >= 0) {
      manifest[idx] = { ...manifest[idx], ...fields };
      await writeManifest(
        manifest.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      );
    }
  });
}
