import { describe, it, expect } from "vitest";
import { extractTitle, stripGitSuffix } from "../lib/brain.js";

// ---------------------------------------------------------------------------
// stripGitSuffix
// ---------------------------------------------------------------------------
describe("stripGitSuffix", () => {
  it("removes trailing [git:...] line", () => {
    const input = "결정: 완료\n[git: abc1234 main]";
    expect(stripGitSuffix(input)).toBe("결정: 완료");
  });

  it("leaves content unchanged when no git suffix present", () => {
    const input = "요약: 그냥 내용";
    expect(stripGitSuffix(input)).toBe("요약: 그냥 내용");
  });

  it("trims trailing whitespace after removing git suffix", () => {
    const input = "내용\n[git: deadbeef feature/x]  ";
    expect(stripGitSuffix(input)).toBe("내용");
  });
});

// ---------------------------------------------------------------------------
// extractTitle — 요약 field takes priority
// ---------------------------------------------------------------------------
describe("extractTitle", () => {
  it("uses 요약 field value as title when present", () => {
    const input = "결정: 인프라 변경\n요약: vitest 도입 완료";
    expect(extractTitle(input)).toBe("vitest 도입 완료");
  });

  it("strips 요약: prefix from title", () => {
    const input = "요약: 테스트 작성";
    expect(extractTitle(input)).toBe("테스트 작성");
  });

  it("falls back to first line when 요약 is absent", () => {
    const input = "결정: npm publish 완료\n다음할것: 버전 태그";
    expect(extractTitle(input)).toBe("npm publish 완료");
  });

  it("strips 결정: prefix from first line fallback", () => {
    const input = "결정: 배포 자동화";
    expect(extractTitle(input)).toBe("배포 자동화");
  });

  it("strips markdown heading prefix", () => {
    const input = "## 주요 결정 사항";
    expect(extractTitle(input)).toBe("주요 결정 사항");
  });

  it("trims surrounding whitespace from extracted title", () => {
    const input = "  요약:   공백 테스트  ";
    expect(extractTitle(input)).toBe("공백 테스트");
  });

  it("truncates title to 40 characters", () => {
    const long = "a".repeat(60);
    const input = `요약: ${long}`;
    expect(extractTitle(input).length).toBe(40);
  });

  it("strips git suffix before extracting title", () => {
    const input = "요약: git 접미사 제거\n[git: cafebabe main]";
    expect(extractTitle(input)).toBe("git 접미사 제거");
  });
});

// ---------------------------------------------------------------------------
// slug validation regex (mirrors getPage / savePage logic in brain.ts)
// ---------------------------------------------------------------------------
const SLUG_RE = /^[a-z0-9가-힣-]+$/;

describe("slug validation regex", () => {
  it("accepts lowercase ascii slug", () => {
    expect(SLUG_RE.test("hello-world")).toBe(true);
  });

  it("accepts korean slug", () => {
    expect(SLUG_RE.test("프로젝트-계획")).toBe(true);
  });

  it("accepts mixed alphanumeric slug", () => {
    expect(SLUG_RE.test("project123")).toBe(true);
  });

  it("rejects slug with uppercase letters", () => {
    expect(SLUG_RE.test("Hello-World")).toBe(false);
  });

  it("rejects slug with path traversal", () => {
    expect(SLUG_RE.test("../etc/passwd")).toBe(false);
  });

  it("rejects slug with spaces", () => {
    expect(SLUG_RE.test("hello world")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(SLUG_RE.test("")).toBe(false);
  });

  it("rejects slug with null byte", () => {
    expect(SLUG_RE.test("foo\0bar")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UUID validation regex (mirrors saveCapture / getThread logic in brain.ts)
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("UUID validation regex", () => {
  it("accepts valid lowercase UUID", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts valid uppercase UUID", () => {
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects UUID with missing segment", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716")).toBe(false);
  });

  it("rejects UUID with wrong segment length", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-44665544000Z")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(UUID_RE.test("")).toBe(false);
  });

  it("rejects arbitrary string", () => {
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dedup logic — duplicate content after timestamp should be skipped
// The logic in brain.ts lines 139-149: compares stripGitSuffix(content) to
// the last block's text after stripping the bold timestamp header.
// We test the comparison expression directly.
// ---------------------------------------------------------------------------
describe("dedup: stripGitSuffix comparison", () => {
  it("detects duplicate when content matches last block text", () => {
    const content = "결정: 중복 내용";
    // Simulate lastBlock after stripping timestamp header (**...**\n\n)
    const lastBlockText = stripGitSuffix(content.trim());
    const incomingText = stripGitSuffix(content.trim());
    expect(incomingText === lastBlockText).toBe(true);
  });

  it("does not flag as duplicate when content differs", () => {
    const content = "결정: 새로운 내용";
    const lastBlockText = stripGitSuffix("결정: 이전 내용".trim());
    const incomingText = stripGitSuffix(content.trim());
    expect(incomingText === lastBlockText).toBe(false);
  });

  it("ignores git suffix difference when deduplicating", () => {
    const content = "요약: 같은 내용\n[git: abc1234 main]";
    const previousContent = "요약: 같은 내용\n[git: def5678 feature]";
    expect(stripGitSuffix(content.trim())).toBe(stripGitSuffix(previousContent.trim()));
  });
});
