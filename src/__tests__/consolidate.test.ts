import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

type ConsolidateModule = typeof import("../lib/consolidate.js");
let consolidate: ConsolidateModule;
let tmpDir: string;
let threadsDir: string;

const DAY_MS = 24 * 3600 * 1000;
const STALE_MS = 31 * DAY_MS; // safely > 30-day cutoff

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "oma-consolidate-"));
  threadsDir = join(tmpDir, "threads");
  await mkdir(threadsDir, { recursive: true });
  process.env.OH_MY_ADHD_DIR = tmpDir;
  vi.resetModules();
  consolidate = await import("../lib/consolidate.js");
});

afterEach(async () => {
  delete process.env.OH_MY_ADHD_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

// --- fixture helpers ---------------------------------------------------------

const STATE_FILE = () => join(threadsDir, ".consolidation.json");
const MANIFEST_FILE = () => join(threadsDir, ".manifest.json");

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// Build a thread .md file + manifest entry. Returns the manifest entry.
async function makeThread(id: string, ageMs: number, body = "다음할것: 계속\n요약: 테스트") {
  const file = join(threadsDir, `${id}.md`);
  const content = `# ${id}\n\n_created: x_\n\n---\n**${isoAgo(ageMs)}**\n\n${body}\n`;
  await writeFile(file, content, "utf-8");
  return { id, title: id, updatedAt: isoAgo(ageMs) };
}

async function writeManifest(entries: Array<{ id: string; title: string; updatedAt: string }>) {
  await writeFile(MANIFEST_FILE(), JSON.stringify(entries, null, 2), "utf-8");
}

async function writeState(lastRunMs: number, archivedCount = 0) {
  await writeFile(
    STATE_FILE(),
    JSON.stringify({ lastRun: isoAgo(lastRunMs), archivedCount }, null, 2),
    "utf-8",
  );
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

// runConsolidationIfDue defers actual work to setImmediate. Poll until the
// consolidation state file's lastRun advances past the seeded value, or time out.
async function waitForConsolidation(prevLastRun: string | null, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setImmediate(r));
    if (await fileExists(STATE_FILE())) {
      const { lastRun } = JSON.parse(await readFile(STATE_FILE(), "utf-8"));
      if (lastRun !== prevLastRun) return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// Build N stale threads + manifest. Helper for the 50-thread gate.
async function seedThreads(count: number, ageMs: number) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push(await makeThread(`thread-${i}`, ageMs));
  }
  await writeManifest(entries);
  return entries;
}

// -----------------------------------------------------------------------------

describe("runConsolidationIfDue — 24h gate", () => {
  it("does not run when last consolidation was < 24h ago", async () => {
    const entries = await seedThreads(60, STALE_MS); // 50+ threads, all stale
    await writeState(1 * 3600 * 1000); // lastRun 1h ago
    const before = JSON.parse(await readFile(STATE_FILE(), "utf-8")).lastRun;

    await consolidate.runConsolidationIfDue(entries);
    const advanced = await waitForConsolidation(before, 500);

    expect(advanced).toBe(false);
    // No thread should have been consolidated
    const marked = await readFile(join(threadsDir, "thread-0.md"), "utf-8");
    expect(marked).not.toContain("[consolidated:");
  });
});

describe("runConsolidationIfDue — 50-thread gate", () => {
  it("does not run when fewer than 50 threads exist", async () => {
    const entries = await seedThreads(49, STALE_MS); // 49 threads, all stale + old
    await writeState(48 * 3600 * 1000); // lastRun 48h ago — 24h gate passes

    await consolidate.runConsolidationIfDue(entries);
    const advanced = await waitForConsolidation(
      JSON.parse(await readFile(STATE_FILE(), "utf-8")).lastRun,
      500,
    );

    expect(advanced).toBe(false);
    const marked = await readFile(join(threadsDir, "thread-0.md"), "utf-8");
    expect(marked).not.toContain("[consolidated:");
  });
});

describe("runConsolidationIfDue — runs when gates pass", () => {
  it("consolidates threads older than 30 days when both gates pass", async () => {
    const entries = await seedThreads(55, STALE_MS); // 55 threads, all 31 days old
    await writeState(48 * 3600 * 1000); // lastRun 48h ago

    const before = JSON.parse(await readFile(STATE_FILE(), "utf-8")).lastRun;
    await consolidate.runConsolidationIfDue(entries);
    const advanced = await waitForConsolidation(before);

    expect(advanced).toBe(true);

    // Stale thread got the consolidated marker + a sidecar summary
    const marked = await readFile(join(threadsDir, "thread-0.md"), "utf-8");
    expect(marked).toContain("[consolidated:");
    expect(await fileExists(join(threadsDir, "thread-0.summary.md"))).toBe(true);

    // archivedCount incremented in state
    const state = JSON.parse(await readFile(STATE_FILE(), "utf-8"));
    expect(state.archivedCount).toBeGreaterThan(0);
  });

  it("leaves recent (< 30 day) threads untouched even when it runs", async () => {
    const entries: Array<{ id: string; title: string; updatedAt: string }> = [];
    // 54 stale threads to clear the 50-thread gate
    for (let i = 0; i < 54; i++) entries.push(await makeThread(`stale-${i}`, STALE_MS));
    // 1 fresh thread that must NOT be consolidated
    entries.push(await makeThread("fresh", 1 * DAY_MS));
    await writeManifest(entries);
    await writeState(48 * 3600 * 1000);

    const before = JSON.parse(await readFile(STATE_FILE(), "utf-8")).lastRun;
    await consolidate.runConsolidationIfDue(entries);
    await waitForConsolidation(before);

    const fresh = await readFile(join(threadsDir, "fresh.md"), "utf-8");
    expect(fresh).not.toContain("[consolidated:");
  });
});

describe("runConsolidationIfDue — idempotency", () => {
  it("does not reprocess threads already marked [consolidated:]", async () => {
    const entries: Array<{ id: string; title: string; updatedAt: string }> = [];
    for (let i = 0; i < 54; i++) entries.push(await makeThread(`stale-${i}`, STALE_MS));

    // Pre-mark one thread as already consolidated
    const preMarkedFile = join(threadsDir, "stale-0.md");
    const original = await readFile(preMarkedFile, "utf-8");
    const preMarkedContent = original + `\n\n[consolidated: ${isoAgo(STALE_MS)}]\n`;
    await writeFile(preMarkedFile, preMarkedContent, "utf-8");
    entries.push({ id: "stale-0", title: "stale-0", updatedAt: isoAgo(STALE_MS) });
    // de-dup: stale-0 already in entries from makeThread; rebuild clean list
    const manifest = entries.filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);
    await writeManifest(manifest);
    await writeState(48 * 3600 * 1000);

    const before = JSON.parse(await readFile(STATE_FILE(), "utf-8")).lastRun;
    await consolidate.runConsolidationIfDue(manifest);
    await waitForConsolidation(before);

    // The pre-marked file should keep exactly ONE consolidated marker (not re-appended)
    const after = await readFile(preMarkedFile, "utf-8");
    const markerCount = (after.match(/\[consolidated:/gi) || []).length;
    expect(markerCount).toBe(1);
    // And no sidecar should have been generated for the already-consolidated thread
    expect(await fileExists(join(threadsDir, "stale-0.summary.md"))).toBe(false);
  });
});
