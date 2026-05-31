# Contributing to oh-my-adhd

고마워요. 작은 수정이든 큰 기능이든 환영합니다.

## 빠른 시작

```bash
git clone https://github.com/gocks77777/oh-my-adhd.git
cd oh-my-adhd
npm install
npm test
```

테스트가 전부 통과하면 개발 환경이 정상입니다.

## 개발 워크플로

| 명령 | 하는 일 |
|---|---|
| `npm test` | vitest 전체 실행 (한 번) |
| `npm run build` | `tsconfig.mcp.json`으로 `dist/` 빌드 |
| `npx tsc -p tsconfig.mcp.json --noEmit` | 타입만 검사 (빌드 산출물 없음) |
| `npm run mcp` | MCP 서버를 tsx로 로컬 실행 |

### 로컬에서 브레인 디렉터리 격리

기본 브레인 경로(`~/.oh-my-adhd`)를 건드리지 않으려면 환경변수로 덮어쓰세요:

```bash
OH_MY_ADHD_DIR=/tmp/test-brain npm run mcp
```

모든 통합 테스트는 `mkdtemp`로 임시 디렉터리를 만들고 `OH_MY_ADHD_DIR`로 격리합니다.

## PR 보내기 전 체크리스트

- [ ] `npm test` 통과 (새 코드에는 테스트 추가)
- [ ] `npx tsc -p tsconfig.mcp.json --noEmit` 타입 에러 없음
- [ ] 사용자 표시 동작이 바뀌면 `README.md` 갱신
- [ ] 주목할 변경이면 `CHANGELOG.md`의 `## [Unreleased]`에 한 줄 추가

## 코드 스타일

- TypeScript strict 모드. `any`는 정당한 이유가 있을 때만.
- 파일 I/O는 항상 임시 파일 + `rename`으로 원자적 쓰기 (`brain.ts` 패턴 참고).
- 매니페스트를 수정하는 모든 코드는 `withBrainLock`으로 직렬화.
- 사용자에게 보이는 텍스트는 한국어 우선, 코드 주석은 한/영 모두 가능.

## 새 MCP 툴 추가하기

1. `src/mcp/tools/wiki-<name>.ts`에 `registerWiki<Name>(server)` 형태로 작성.
2. `src/mcp/server.ts`에서 등록.
3. `src/__tests__/mcp-integration.test.ts`에 통합 테스트 추가.
4. `README.md`의 MCP Tools 표에 한 줄 추가.

## 버그 신고 / 기능 제안

GitHub Issues를 사용하세요. 버그는 `npx oh-my-adhd doctor` 출력을 함께 붙여주면 진단이 빠릅니다.

## 라이선스

기여한 코드는 프로젝트와 동일한 [MIT 라이선스](LICENSE)로 배포됩니다.
