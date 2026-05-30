#!/usr/bin/env bash
# oh-my-adhd demo script
# Record with: asciinema rec demo.cast -c "bash scripts/demo.sh"
set -e

echo "# oh-my-adhd demo"
echo ""
sleep 1

echo "$ npx oh-my-adhd init"
sleep 0.5
echo "  ✓ Brain    ~/.oh-my-adhd"
echo "  ✓ MCP      oh-my-adhd 등록됨"
echo "  ✓ Hooks    SessionStart + Stop"
echo ""
echo "지금 작업 중인 게 뭐야? (한 줄, 엔터로 건너뛰기)"
echo "> React 폼 validation 리팩터링"
sleep 0.5
echo ""
echo "✓ 첫 기억 심었어."
echo "  Claude Code 재시작하면, Claude가 먼저"
echo "  \"React 폼 validation 리팩터링\" 기억하고 이어서 갈지 물어볼 거야."
echo ""
echo "  까먹어도 괜찮아. 그게 이 도구의 일이야."
sleep 2

echo ""
echo "# --- 다음 세션 (Claude Code 재시작 후) ---"
sleep 1
echo ""
echo "[oh-my-adhd] 어제 어디까지 했더라..."
sleep 1
echo ""
echo "## 어제 멈춘 곳"
echo ""
echo "> 🔴 React 폼 validation 리팩터링 — 15시간 전"
echo "> → 다음: useFormState 마이그레이션 + 에러 메시지 i18n"
echo "> ⛔ 막힌것: zod refine() 비동기 검증이 submit 중복 발생"
echo ">"
echo "> 이어서 갈까? (thread: abc123...)"
sleep 2
echo ""
echo "# 이게 매 세션 자동으로 일어나."
