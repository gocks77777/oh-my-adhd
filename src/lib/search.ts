import MiniSearch from "minisearch";
import type { Page } from "./brain.js";

interface SearchDoc {
  id: string;
  slug: string;
  title: string;
  aliases: string;
  content: string;
}

// Korean-aware tokenizer: whitespace split + Korean bigrams for partial matching
function tokenize(text: string): string[] {
  const normalized = text.normalize("NFC").toLowerCase();
  const words = normalized
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const tokens: string[] = [];
  for (const word of words) {
    tokens.push(word);
    // Korean bigrams: "운동했다" → ["운동", "동했", "했다"] — partial stem matching
    if (/[가-힣]/.test(word) && word.length >= 2) {
      for (let i = 0; i < word.length - 1; i++) {
        tokens.push(word.slice(i, i + 2));
      }
    }
  }
  // Do NOT dedup — preserving duplicates keeps TF signal intact for BM25
  return tokens;
}

// Parse `_aliases: ADHD, 주의력결핍_` from page content
export function extractAliases(content: string): string {
  const match = content.match(/_aliases:\s*([^_\n]+)_/i);
  return match ? match[1] : "";
}

// Cache keyed by slug:updatedAt:aliasHash — invalidates on alias edits
function cacheKey(pages: Page[]): string {
  return pages
    .map((p) => `${p.slug}:${p.updatedAt}:${extractAliases(p.content).length}`)
    .join("|");
}

let _indexCache: { key: string; index: MiniSearch<SearchDoc> } | null = null;

export function buildSearchIndex(pages: Page[]): MiniSearch<SearchDoc> {
  const key = cacheKey(pages);
  if (_indexCache && _indexCache.key === key) return _indexCache.index;

  const index = new MiniSearch<SearchDoc>({
    fields: ["title", "aliases", "content"],
    storeFields: ["slug", "title"],
    tokenize,
    searchOptions: {
      boost: { title: 3, aliases: 2, content: 1 },
      // Only prefix-match tokens of 3+ chars — prevents bigram over-matching
      prefix: (term) => term.length >= 3,
      // Fuzzy only on longer tokens — 2-char bigrams need exact match
      fuzzy: (term) => (term.length > 4 ? 0.15 : 0),
    },
  });

  index.addAll(
    pages.map((p) => ({
      id: p.slug,
      slug: p.slug,
      title: p.title,
      aliases: extractAliases(p.content),
      content: p.content,
    }))
  );

  _indexCache = { key, index };
  return index;
}

export function searchInDocs(
  docs: Array<{ id: string; title: string; content: string }>,
  query: string
): Array<{ id: string; score: number }> {
  if (!query.trim() || docs.length === 0) return [];

  const ms = new MiniSearch({
    fields: ["title", "content"],
    storeFields: ["id"],
    tokenize: (text) => {
      const words = text.split(/\s+/).filter(Boolean);
      const bigrams: string[] = [];
      for (const w of words) {
        if (/[가-힣]/.test(w)) {
          for (let i = 0; i < w.length - 1; i++) bigrams.push(w.slice(i, i + 2));
        } else {
          bigrams.push(w.toLowerCase());
        }
      }
      return bigrams.length > 0 ? bigrams : words;
    },
  });

  ms.addAll(docs);
  try {
    return ms.search(query, { prefix: true, fuzzy: 0.15 }).map(r => ({ id: r.id as string, score: r.score }));
  } catch {
    return [];
  }
}

export function searchPages(pages: Page[], query: string, limit = 5): string[] {
  if (!query.trim() || pages.length === 0) return [];
  const index = buildSearchIndex(pages);
  try {
    return index.search(query).slice(0, limit).map((r) => r.slug as string);
  } catch {
    return [];
  }
}
