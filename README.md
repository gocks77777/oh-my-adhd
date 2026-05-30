# oh-my-adhd

[![npm version](https://img.shields.io/npm/v/oh-my-adhd.svg)](https://www.npmjs.com/package/oh-my-adhd)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-adhd.svg)](https://www.npmjs.com/package/oh-my-adhd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Stop re-explaining your project to Claude every morning.**

Claude Code MCP plugin that remembers where you left off — across sessions, across days. Built for ADHD brains, useful for everyone.

> 어제 뭐 했는지 기억 안 나도 괜찮아요.

## Demo

<!-- Record with: asciinema rec demo.cast -->
<!-- Then: svg-term --in demo.cast --out demo.svg -->
<!-- Or: termtosvg demo.svg -->

**What you'll see after install:**

```
[oh-my-adhd] 어제 어디까지 했더라...

## 어제 멈춘 곳

> 🔴 **React 폼 validation 리팩터링** — 15시간 전
> → 다음: useFormState 마이그레이션 + 에러 메시지 i18n
> ⛔ 막힌것: zod refine() 비동기 검증이 submit 중복 발생
>
> 이어서 갈까? (thread: `abc123...`)
```

*Every new Claude Code session opens like this — automatically.*

---

## 왜 만들었냐 / Why

ADHD가 있으면 컨텍스트 스위칭이 치명적이다. Claude와 한 시간 작업하다 탭 닫으면 다음 날 "어디까지 했더라"를 복구하는 데 30분이 날아간다. 그게 싫어서 만들었다.

이건 메모 앱이 아니다. **막힌 곳에서 다시 시작하는 도구**다.

---

## 설치 / Install

**Prerequisites**: Node.js 18+, npm, Claude Code

```bash
npx oh-my-adhd init
```

끝이다. Claude Code 재시작하면 바로 쓸 수 있다.

내부적으로:
- `~/.claude.json`에 MCP 서버 등록
- `~/.claude/settings.json`에 SessionStart / Stop 훅 추가
- `~/.oh-my-adhd/` 브레인 디렉터리 생성

> **재설치 안전**: `init`을 여러 번 실행해도 기존 브레인 데이터(`~/.oh-my-adhd/`)는 건드리지 않는다. 설정 파일은 덮어쓰기 전에 자동 백업된다.

> **설치 확인**: `npx oh-my-adhd doctor` 로 MCP 등록, 훅, 데이터 무결성을 한번에 확인할 수 있다.

> **브레인 디렉터리 변경**: `OH_MY_ADHD_DIR=/path/to/brain npx oh-my-adhd mcp` 로 기본 경로(`~/.oh-my-adhd`)를 덮어쓸 수 있다.

---

## 어떻게 동작하냐 / How it works

### 세션 시작하면 자동으로

```
[oh-my-adhd] Second Brain 복원 중...
→ 어제 oh-my-adhd MCP 전환 작업 중이었어. tools/ 분할 구현까지 완료.
  다음할것: README 재작성 + init 스크립트 테스트
  막힌것: CLAUDE.md 지침만으론 자동 dump 신뢰 불가 (Stop hook으로 해결됨)
```

새 세션을 열면 `wiki_recall`이 자동으로 최근 컨텍스트를 불러온다. "어디까지 했더라"를 Claude가 먼저 꺼내준다.

### 막혔을 때

```
wiki_unstick(energy: "low")
```

지금 에너지 레벨(low/medium/high)에 맞는 다음 액션을 제안한다. 이미 시도해서 실패한 것은 다시 제안하지 않는다.

### 세션 끝나기 전에

Stop 훅이 발동해서 "wiki_dump 호출했나?" 리마인더를 출력한다. Claude가 이를 보고 wiki_dump를 호출해 결정/막힌것/다음할것을 저장한다. (Stop hook은 Claude에게 보내는 알림이지 강제 저장 메커니즘이 아니다 — Claude가 이를 인지하고 wiki_dump를 호출해야 저장된다.)

---

## MCP Tools

### 자동 호출 (Daily use — auto-invoked)

| 툴 | 설명 |
|---|---|
| `wiki_recall` | 세션 시작 시 자동 호출 — 최근 컨텍스트 복원 |
| `wiki_dump` | 컨텍스트 저장. 결정/막힌것/다음할것 구조 |
| `wiki_unstick` | 에너지 레벨별 다음 액션 제안. dead-end 자동 회피 |

### 수동 호출 (Advanced — call when needed)

| 툴 | 설명 |
|---|---|
| `wiki_setup` | 첫 설치 시 초기 컨텍스트 등록 |
| `wiki_query` | 과거 스레드 검색 (BM25) |
| `wiki_pages` | 위키 페이지 목록 조회 |
| `wiki_link` | 페이지 간 링크 생성 |
| `wiki_graph` | 지식 그래프 시각화 |
| `wiki_structure` | 날것 캡처를 구조화 |
| `wiki_save` | 구조화된 위키 페이지 저장 |
| `wiki_delete` | 스레드 또는 페이지 삭제 (.trash 백업) |

---

## Storage Format

wiki_dump는 자유 텍스트가 아니라 구조화된 형식으로 저장된다:

```
결정: [이번 세션에서 확정된 것]
가설: [현재 시도 중인 방향]
막힌것: [이미 시도해서 안 된 것 — 다음 세션에서 반복 금지]
다음할것: [지금 당장 멈춘 시점의 다음 액션. 구체적으로]
블로커: [해결 안 된 장애물]
요약: [한 줄 컨텍스트]
[git: branch@sha | dirty: modified-files]
```

`막힌것` 필드가 핵심이다. 이게 없으면 다음 세션에서 같은 실수를 반복한다.

---

## Auto-consolidation

스레드가 50개 이상이고 마지막 압축으로부터 24시간 이상 지났을 때, `wiki_recall` 호출 시 백그라운드에서 자동으로 실행된다 (별도 호출 불필요):
- 30일 이상 미접근 스레드를 키워드 요약으로 압축
- 삭제 대신 `.trash/`로 백업

---

## Code Anchoring

wiki_dump 시 현재 git 컨텍스트가 자동으로 붙는다:

```
[git: main@a3f2c1b | dirty: src/mcp/server.ts, README.md]
```

나중에 "그때 어떤 파일 고치던 중이었지?" 를 추적할 수 있다.

---

## 문제 해결 / Troubleshooting

**wiki_recall이 아무것도 안 보여줘**
→ `npx oh-my-adhd doctor` 로 설치 상태 확인

**Claude가 컨텍스트를 기억 못해**
→ Claude Code를 완전히 재시작했는지 확인 (창 닫고 다시 열기)
→ `~/.claude/settings.json`에 SessionStart hook이 있는지 확인

**설치 취소하고 싶어**
→ `~/.claude.json`에서 `mcpServers["oh-my-adhd"]` 제거
→ `~/.claude/settings.json`에서 SessionStart/Stop hook 제거
→ `~/.oh-my-adhd/` 디렉터리는 그대로 유지됨 (데이터 보존)

---

## oh-my 시리즈

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)의 생태계 안에서 동작하도록 설계됐다. MCP 서버로 독립 실행도 가능하고, omc 플러그인으로도 쓸 수 있다.

---

## 라이선스

MIT
