import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getThreads, getThread, OPEN_SIGNAL, extractFieldBrain } from "../../lib/brain.js";

export function registerWikiUnstick(server: McpServer): void {
  server.tool(
    "wiki_unstick",
    "막혀서 무력감 느낄 때 호출. 막힌 컨텍스트와 dead-end 목록을 수집해서 반환한다. **이 툴을 호출한 후 Claude는 반드시** 반환된 컨텍스트를 보고 에너지 레벨에 맞는 구체적인 스텝 하나를 한 줄로 직접 제안해야 한다. 제안은 행동 동사로 시작하고, ⛔ 목록에 있는 것은 절대 포함하지 않는다.",
    {
      task: z.string().max(2_000).optional().describe("막힌 태스크 직접 설명 (없으면 최근 미완료 스레드 자동 감지)"),
      energy: z.enum(["low", "medium", "high"]).optional().default("medium").describe("현재 집중력/에너지 수준 (low=2분짜리, medium=5분짜리, high=15분짜리)"),
    },
    async ({ task, energy }) => {
      try {
        let targetTitle = "";
        let targetContext = task ?? "";
        const deadEnds: string[] = [];
        let nextStep = "";
        const blockers: string[] = [];
        const crossThreadBlockers: string[] = [];

        if (!targetContext) {
          const threads = await getThreads();
          const candidates = threads.slice(0, 5);
          const contents = await Promise.all(candidates.map((t) => getThread(t.id)));

          // open thread 우선 선택, 없으면 첫 번째 — 한 스레드에서만 필드 수집
          let chosenIdx = candidates.findIndex((_, i) => {
            const c = contents[i];
            if (!c) return false;
            const lastCapture = c.split(/\n---\n/).slice(1).at(-1) ?? "";
            return OPEN_SIGNAL.test(lastCapture);
          });
          if (chosenIdx < 0) chosenIdx = 0;

          const content = contents[chosenIdx];
          const chosenThread = candidates[chosenIdx];
          if (content) {
            const titleMatch = content.match(/^#\s+(.+)$/m);
            targetTitle = (titleMatch?.[1] ?? chosenThread.id).trim();

            const captures = content.split(/\n---\n/).slice(1).filter((p) => p.trim());
            const recentCaptures = captures.slice(-3);
            for (const cap of recentCaptures) {
              const de = extractFieldBrain(cap, "막힌것");
              if (de && !deadEnds.includes(de)) deadEnds.push(de);
              const ns = extractFieldBrain(cap, "다음할것");
              if (ns) nextStep = ns;
              const bl = extractFieldBrain(cap, "블로커");
              if (bl && !blockers.includes(bl)) blockers.push(bl);
            }

            targetContext = recentCaptures
              .map((c) => c.replace(/^(?:_[^_\n]+_|\*\*[^*\n]+\*\*)\s*/m, "").replace(/\n+/g, " ").trim())
              .filter(Boolean)
              .join("\n");
          }

          // Collect dead-ends from all open threads (not just the chosen one)
          const allOpenThreads = threads.filter(t => t.is_open && t.id !== chosenThread.id);

          const otContents = await Promise.all(allOpenThreads.slice(0, 10).map(ot => getThread(ot.id)));
          allOpenThreads.slice(0, 10).forEach((ot, i) => {
            const otContent = otContents[i];
            if (!otContent) return;
            const otCaptures = otContent.split(/\n---\n/).slice(1).filter(p => p.trim());
            const otLast = otCaptures.at(-1) ?? "";
            const otText = otLast.replace(/^(?:_[^_\n]+_|\*\*[^*\n]+\*\*)\s*/m, "").trim();
            const otBlocker = extractFieldBrain(otText, "막힌것");
            const otBlockerKey = otBlocker.toLowerCase().replace(/\s+/g, " ").slice(0, 60);
            if (otBlocker && !deadEnds.some(d => d.toLowerCase().replace(/\s+/g, " ").includes(otBlockerKey))) {
              crossThreadBlockers.push(`[${ot.title?.slice(0, 20) ?? "다른 스레드"}] ${otBlocker}`);
            }
          });
        }

        if (!task && !targetTitle && !targetContext) {
          return { content: [{ type: "text", text:
            "막힌 대상을 찾지 못했어. 둘 중 하나로 다시 호출해줘:\n" +
            "1. `task` 인자에 막힌 상황 한 줄로 직접 적기\n" +
            "2. 먼저 `wiki_dump`로 지금 머릿속 상태를 던진 뒤 다시 `wiki_unstick` 호출\n" +
            "(저장된 스레드가 없거나 모두 완료 상태)"
          }] };
        }

        const taskSize = energy === "low" ? "2분" : energy === "high" ? "15분" : "5분";
        const taskDetail = energy === "low"
          ? "뇌를 거의 쓰지 않아도 되는 것 (파일 열기, 탭 찾기, 줄 읽기 수준)"
          : energy === "high"
          ? "집중이 필요하지만 명확한 완결이 있는 것"
          : "결정 없이 바로 시작할 수 있는 것";

        const lines = [
          targetTitle ? `## 현재 작업: ${targetTitle}` : "## 현재 작업",
          `> 에너지 레벨: ${energy} → ${taskSize}짜리 스텝`,
          "",
          "### 컨텍스트",
          targetContext || task || "(컨텍스트 없음)",
        ];

        if (nextStep) {
          lines.push("", `### 마지막으로 계획한 다음 스텝`, nextStep);
        }

        if (deadEnds.length > 0 || crossThreadBlockers.length > 0) {
          lines.push("", "### ⛔ 이미 시도해서 안 된 것 (제안하지 말 것)");
          deadEnds.forEach((d) => lines.push(`- ${d}`));
          if (crossThreadBlockers.length > 0) {
            lines.push("", "⛔ 다른 스레드에서도 막혔던 것:");
            crossThreadBlockers.forEach((b) => lines.push(`  - ${b}`));
          }
        }

        if (blockers.length > 0) {
          lines.push("", "### 블로커");
          blockers.forEach((b) => lines.push(`- ${b}`));
        }

        lines.push(
          "",
          "---",
          `_제안 기준: ${taskSize}짜리 / ${taskDetail}_`
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${(e as Error).message ?? String(e)}` }], isError: true };
      }
    }
  );
}
