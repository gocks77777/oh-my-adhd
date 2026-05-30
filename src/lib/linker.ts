import { getPages, savePage, getThreads, getThread } from "./brain.js";
import { buildSearchIndex, searchPages } from "./search.js";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 기존 페이지와 키워드 매칭으로 자동 링크 생성
export async function autoLinkContent(content: string): Promise<string> {
  const pages = await getPages();
  // 긴 제목 먼저 매칭 — "Next" 페이지가 "Next.js 라우팅" 내부를 오염시키는 것 방지
  const sortedPages = [...pages].sort((a, b) => b.title.length - a.title.length);

  // Protect fenced code blocks and inline code from link injection
  const placeholders: string[] = [];
  let linked = content.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    const ph = `\x00C${placeholders.length}\x00`;
    placeholders.push(m);
    return ph;
  });

  for (const page of sortedPages) {
    const title = page.title;
    // Case-insensitive check to prevent double-wrapping [[[[title]]]]
    if (linked.toLowerCase().includes(`[[${title.toLowerCase()}]]`)) continue;
    const boundary = "(?<![\\p{L}\\p{N}])";
    const regex = new RegExp(
      `${boundary}${escapeRegex(title)}(?![\\p{L}\\p{N}])`,
      "giu"
    );
    linked = linked.replace(regex, `[[${title}]]`);
  }

  // Restore protected code segments
  return linked.replace(/\x00C(\d+)\x00/g, (_, i) => placeholders[parseInt(i, 10)]);
}

// BM25 기반 관련 페이지 탐색 — 첫 의미있는 줄만 쿼리로 사용 (full content는 노이즈)
export async function findRelatedPages(content: string): Promise<string[]> {
  const pages = await getPages();
  if (pages.length === 0) return [];
  const queryHint = content
    .split("\n")
    .find(l => l.trim().length > 3 && !l.startsWith("[") && !l.startsWith("#") && !l.startsWith("_"))
    ?.slice(0, 120) ?? content.slice(0, 120);
  return searchPages(pages, queryHint, 5);
}

// 캡처에서 위키 페이지 자동 생성/업데이트
export async function upsertPageFromCapture(
  title: string,
  content: string
): Promise<void> {
  const slug = title
    .toLowerCase()
    .replace(/[^가-힣a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!slug) return; // title이 전부 특수문자면 slug가 비어 있음 — 저장 불가

  const capturesOnly = content.includes("\n---\n")
    ? content.slice(content.indexOf("\n---\n"))
    : content;

  const linkedContent = await autoLinkContent(capturesOnly);
  const pageContent = `# ${title}\n\n_updated: ${new Date().toISOString()}_\n${linkedContent}\n`;
  await savePage(slug, pageContent);
}

// BM25 기반 그래프 엣지 생성
export async function buildGraphData(): Promise<{
  nodes: Array<{ id: string; label: string; type: "thread" | "page" }>;
  edges: Array<{ source: string; target: string }>;
}> {
  const MAX_NODES = 200;
  const [threads, pages] = await Promise.all([getThreads(), getPages()]);
  const nodes: Array<{ id: string; label: string; type: "thread" | "page" }> = [];
  const edges: Array<{ source: string; target: string }> = [];
  const edgeSet = new Set<string>();

  const addEdge = (source: string, target: string) => {
    const key = `${source}→${target}`;
    if (!edgeSet.has(key) && source !== target) {
      edgeSet.add(key);
      edges.push({ source, target });
    }
  };

  const index = buildSearchIndex(pages);
  const pageSlugSet = new Set(pages.map((p) => p.slug));

  const threadContents = await Promise.all(
    threads.slice(0, MAX_NODES).map((t) => getThread(t.id))
  );

  for (let i = 0; i < Math.min(threads.length, MAX_NODES); i++) {
    const t = threads[i];
    const content = threadContents[i];
    nodes.push({ id: `thread-${t.id}`, label: t.title, type: "thread" });
    if (!content) continue;
    // Use only meaningful body content, not frontmatter/timestamps
    const body = content.split(/\n---\n/).slice(1).join(" ").slice(0, 300);
    const related = index.search(body).slice(0, 3);
    for (const r of related) {
      if (pageSlugSet.has(r.slug as string)) {
        addEdge(`thread-${t.id}`, `page-${r.slug}`);
      }
    }
  }

  for (const p of pages.slice(0, MAX_NODES)) {
    nodes.push({ id: `page-${p.slug}`, label: p.title, type: "page" });
    for (const link of p.links) {
      const targetSlug = pages.find(
        (pg) => pg.title.toLowerCase() === link.toLowerCase()
      )?.slug;
      if (targetSlug) addEdge(`page-${p.slug}`, `page-${targetSlug}`);
    }
  }

  return { nodes, edges };
}
