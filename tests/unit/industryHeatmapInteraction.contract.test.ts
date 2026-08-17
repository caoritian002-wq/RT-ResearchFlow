import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("FR-267 行业云图浮层与窗口采集契约", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/components/IndustryHeatmap/IndustryHeatmap.tsx"),
    "utf8",
  );

  it("工具栏下拉完全渲染在窗口 DOM 内且不回退原生选择器", () => {
    expect(source).toContain("function HeatmapToolbarSelect")
    expect(source).toContain('role="combobox"')
    expect(source).toContain('role="listbox"')
    expect(source).toContain('role="option"')
    expect(source).toContain('testId="industry-heatmap-draw-rule"')
    expect(source).toContain('testId="industry-heatmap-provider"')
    expect(source).not.toContain("<select")
    expect(source).not.toContain("<option")
  });

  it("鼠标在图表和侧栏之间切换时主动关闭另一类浮层", () => {
    expect(source).toContain('dispatchAction({ type: "hideTip" })')
    expect(source).toContain("onMouseLeave={hideTreemapTooltip}")
    expect(source).toContain("onMouseEnter={hideTreemapTooltip}")
    expect(source).toContain("onMouseEnter={dismissLeaderboardTooltip}")
    expect(source).toContain('data-testid="industry-heatmap-ranking-tooltip"')
  });

  it("动量主标题保持滚动窗口语义并把回放来源降为独立状态", () => {
    expect(source).toContain('const momentumTitle = `${momentumN}min 动量`')
    expect(source).toContain('data-testid="industry-heatmap-momentum-state"')
    expect(source).toContain('"盘中滚动"')
    expect(source).toContain('"午盘前回放"')
    expect(source).toContain('"今日收盘前回放"')
    expect(source).toContain('"上个交易日收盘前回放"')
    expect(source).toContain('"上次盘中回放"')
  });
});
