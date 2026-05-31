import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { BRAIN_DIR, updateManifestEntry, getThreads, withBrainLock, extractFieldBrain, parseLastCapture } from "./brain.js";

const THREADS_DIR = path.join(BRAIN_DIR, "threads");
const CONSOLIDATION_STATE = path.join(THREADS_DIR, ".consolidation.json");
const LOCK_FILE = path.join(THREADS_DIR, ".consolidation.lock");
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 min — stale lock threshold

async function acquireFileLock(): Promise<boolean> {
  try {
    await fs.writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
    // Stale lock check
    try {
      const stat = await fs.stat(LOCK_FILE);
      if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
        await fs.unlink(LOCK_FILE);
        await fs.writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
}

async function releaseFileLock(): Promise<void> {
  try {
    const content = await fs.readFile(LOCK_FILE, "utf-8");
    if (content.trim() === String(process.pid)) {
      await fs.unlink(LOCK_FILE);
    }
  } catch { /* ignore — lock already gone or unreadable */ }
}

// Korean/English stopwords that add no meaning to keyword extraction
const STOPWORDS = new Set([
  "이", "의", "가", "을", "를", "은", "는", "에", "도", "로", "과", "와",
  "이다", "있다", "없다", "하다", "된다", "한다", "그", "그리고", "그래서",
  "the", "a", "an", "is", "are", "was", "were", "and", "or", "to", "of",
  "in", "on", "at", "for", "with", "it", "this", "that",
]);

interface ConsolidationState {
  lastRun: string;
  archivedCount: number;
}

async function readState(): Promise<ConsolidationState> {
  try {
    return JSON.parse(await fs.readFile(CONSOLIDATION_STATE, "utf-8"));
  } catch {
    return { lastRun: new Date(0).toISOString(), archivedCount: 0 };
  }
}

function extractKeywords(text: string): Set<string> {
  // Strip markdown header, timestamps, git context, separators before tokenizing
  const cleaned = text
    .replace(/^#[^\n]*/gm, "")               // headings
    .replace(/_[^_\n]+_/g, "")               // _italic_
    .replace(/\*\*[^*\n]+\*\*/g, "")         // **bold** (timestamps)
    .replace(/\[git:[^\]]*\]/g, "")          // git context
    .replace(/^---+$/gm, "")                  // separators
    .replace(/\[consolidated:[^\]]*\]/g, "") // already-compressed marker
    .replace(/\d{4}-\d{2}-\d{2}T[^\s]*/g, "") // ISO timestamps
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "") // UUIDs
    .toLowerCase();

  const freq = new Map<string, number>();
  cleaned
    .replace(/[^\w가-힣\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .forEach(w => freq.set(w, (freq.get(w) ?? 0) + 1));

  // Top-20 by frequency
  return new Set(
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([w]) => w)
  );
}

const STALE_DAYS = 30;

async function consolidateThread(threadId: string, threadFile: string): Promise<boolean> {
  return withBrainLock(async () => {
    let content: string;
    try {
      content = await fs.readFile(threadFile, "utf-8");
    } catch {
      return false;
    }

    // Already consolidated — check for the marker at end of file
    if (/\[consolidated:/i.test(content)) {
      return false;
    }

    // Extract key structured fields from the last capture for sidecar
    const sig = parseLastCapture(content);
    const fullText = sig.fullText;

    const fields = ["결정", "가설", "막힌것", "다음할것", "블로커", "요약"];
    const extracted = fields
      .map(f => {
        const val = extractFieldBrain(fullText, f).slice(0, 200);
        return val ? `${f}: ${val}` : "";
      })
      .filter(Boolean);

    const ts = new Date().toISOString();
    const marker = `\n\n[consolidated: ${ts}]\n`;

    const tmpFile = path.join(path.dirname(threadFile), `.tmp-${randomUUID()}`);
    await fs.writeFile(tmpFile, content + marker, "utf-8");
    await fs.rename(tmpFile, threadFile);

    const sidecarFile = threadFile.replace(/\.md$/, ".summary.md");
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? threadId;
    const sidecarContent = [
      `# Summary: ${title}`,
      `_consolidated: ${ts}_`,
      `_captures: ${sig.capture_count}_`,
      ``,
      extracted.length > 0 ? extracted.join("\n") : "(구조화된 필드 없음)",
      ``,
      `→ 원문: ${path.basename(threadFile)}`,
    ].join("\n");

    const tmpSidecar = path.join(path.dirname(sidecarFile), `.tmp-${randomUUID()}`);
    await fs.writeFile(tmpSidecar, sidecarContent, "utf-8");
    await fs.rename(tmpSidecar, sidecarFile);

    return true;
  });
}

// Stage A: non-destructively consolidate threads not accessed in 30+ days
// 매번 최신 manifest를 읽어서 직전 wiki_dump가 updatedAt을 갱신했는지 재확인
async function ageBasedTrim(): Promise<number> {
  const threads = await getThreads();
  const cutoff = Date.now() - STALE_DAYS * 24 * 3600 * 1000;
  const stale = threads.filter(t => new Date(t.updatedAt).getTime() < cutoff);
  let trimmed = 0;

  await Promise.allSettled(stale.map(async (t) => {
    const threadFile = path.join(THREADS_DIR, `${t.id}.md`);
    const consolidated = await consolidateThread(t.id, threadFile);
    if (consolidated) {
      // Update manifest: mark as consolidated, preserve updatedAt
      const originalMs = new Date(t.updatedAt).getTime();
      await updateManifestEntry(t.id, {
        updatedAt: new Date(Math.min(originalMs, cutoff - 1)).toISOString(),
      });
      trimmed++;
    }
  }));

  return trimmed;
}

// 동시 consolidation 방지 — parallel wiki_recall 호출이 두 번 트리거하는 것 방지
// flag은 첫 await 이전에 set — TOCTOU 방지
let _consolidating = false;

export async function runConsolidationIfDue(threads: Array<{id: string, updatedAt: string}>): Promise<void> {
  if (_consolidating) return;
  _consolidating = true;
  let state: ConsolidationState;
  try {
    state = await readState();
    const hoursSince = (Date.now() - new Date(state.lastRun).getTime()) / 3600000;
    if (hoursSince < 24 || threads.length < 50) { _consolidating = false; return; }
  } catch { _consolidating = false; return; }
  setImmediate(async () => {
    const locked = await acquireFileLock();
    if (!locked) { _consolidating = false; return; }
    try {
      const trimmed = await ageBasedTrim();
      const tmp = path.join(THREADS_DIR, `.tmp-consolidation-${randomUUID()}`);
      await fs.writeFile(tmp, JSON.stringify({
        lastRun: new Date().toISOString(),
        archivedCount: state.archivedCount + trimmed,
      }, null, 2));
      await fs.rename(tmp, CONSOLIDATION_STATE);
    } catch (e) {
      process.stderr.write(`[oh-my-adhd consolidation error] ${e}\n`);
    } finally {
      await releaseFileLock();
      _consolidating = false;
    }
  });
}
