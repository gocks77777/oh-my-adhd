import { describe, it, expect } from "vitest";
import { OPEN_SIGNAL, DONE_SIGNAL } from "../lib/brain.js";

// ---------------------------------------------------------------------------
// OPEN_SIGNAL
// ---------------------------------------------------------------------------
describe("OPEN_SIGNAL", () => {
  it("matches 다음할것: field", () => {
    expect(OPEN_SIGNAL.test("다음할것: npm publish")).toBe(true);
  });

  it("matches 막힌것: field", () => {
    expect(OPEN_SIGNAL.test("막힌것: 인증 문제")).toBe(true);
  });

  it("matches 블로커: field", () => {
    expect(OPEN_SIGNAL.test("블로커: PR 승인 대기")).toBe(true);
  });

  it("matches 가설: field", () => {
    expect(OPEN_SIGNAL.test("가설: 캐시 문제일 수 있음")).toBe(true);
  });

  it("matches todo: field (english, case-insensitive)", () => {
    expect(OPEN_SIGNAL.test("TODO: write tests")).toBe(true);
  });

  it("matches wip: field", () => {
    expect(OPEN_SIGNAL.test("wip: refactoring auth")).toBe(true);
  });

  it("matches when field appears after newline", () => {
    expect(OPEN_SIGNAL.test("결정: 완료\n다음할것: 배포 확인")).toBe(true);
  });

  it("does not match when no open-signal field is present", () => {
    expect(OPEN_SIGNAL.test("결정: 배포 완료\n요약: 모든 작업 완료")).toBe(false);
  });

  it("does not match 다음할것: with empty value", () => {
    expect(OPEN_SIGNAL.test("다음할것:")).toBe(false);
  });

  it("does not match 다음할것: with only whitespace", () => {
    expect(OPEN_SIGNAL.test("다음할것:   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DONE_SIGNAL
// ---------------------------------------------------------------------------
describe("DONE_SIGNAL", () => {
  it("matches 상태: 완료", () => {
    expect(DONE_SIGNAL.test("상태: 완료")).toBe(true);
  });

  it("matches 상태: 해결됨", () => {
    expect(DONE_SIGNAL.test("상태: 해결됨")).toBe(true);
  });

  it("matches 상태: 배포됨", () => {
    expect(DONE_SIGNAL.test("상태: 배포됨")).toBe(true);
  });

  it("matches 상태: done (english)", () => {
    expect(DONE_SIGNAL.test("상태: done")).toBe(true);
  });

  it("matches 상태: shipped", () => {
    expect(DONE_SIGNAL.test("상태: shipped")).toBe(true);
  });

  it("does NOT match 결정: 완료 — 결정 field is not 상태", () => {
    // This was a previous bug: 결정: 완료 should NOT trigger DONE
    expect(DONE_SIGNAL.test("결정: 완료")).toBe(false);
  });

  it("does NOT match 결정: 자동완료 기능 추가 — 완료 inside a value should not match", () => {
    expect(DONE_SIGNAL.test("결정: 자동완료 기능 추가")).toBe(false);
  });

  it("does NOT match when 상태 field has non-done value", () => {
    expect(DONE_SIGNAL.test("상태: 진행중")).toBe(false);
  });

  it("matches 상태: 완료 appearing after other fields", () => {
    expect(DONE_SIGNAL.test("결정: 무언가\n상태: 완료")).toBe(true);
  });
});
