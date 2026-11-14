import { describe, expect, it } from "vitest";

import { PANEL_PADDING_X, PANEL_WIDTH } from "../../src/client/panel-metrics";

/**
 * 「每步」表格的列宽必须给滚动条留余量。
 *
 * ## 为什么这条要单测（2026-11-14 真发现的 bug）
 *
 * 六列原来正好合计 416px = 弹层内容宽 —— 假设没有滚动条。但面板在矮窗口里会
 * 自己滚（`overflowY: auto`），Windows 滚动条占 15~17px，于是网格溢出、
 * 而外层 `overflowX: hidden`，**最后一列（速度）被直接裁掉**且无法横滚。
 *
 * 这里把 396px 这个数钉住：以后谁再加宽某列，先看到这条会红。
 */
describe("每步表格：列宽给滚动条留余量", () => {
  /** 与 `tps-chart.ts` 的 `STEP_GRID` 保持一致。 */
  const COLUMNS = [40, 74, 74, 54, 58, 76] as const;
  const GAP = 4;

  const gridWidth = COLUMNS.reduce((total, width) => total + width, 0) + (COLUMNS.length - 1) * GAP;
  const contentWidth = PANEL_WIDTH - 2 * PANEL_PADDING_X;

  it("合计 396px（六列 376 + 5 个 4px 间隙）", () => {
    expect(gridWidth).toBe(396);
  });

  it("**留出至少 17px 给滚动条**（Windows 经典滚动条宽度）", () => {
    expect(contentWidth - gridWidth).toBeGreaterThanOrEqual(17);
    expect(contentWidth).toBe(416);
  });

  it("六列齐全（步 / 读取 / 输入 / 输出 / 命中 / 速度）", () => {
    expect(COLUMNS).toHaveLength(6);
    // 数字列要放得下最长的内容（11px 字号约 6.6px/字符）。
    expect(COLUMNS[1]).toBeGreaterThanOrEqual(59); // 1,234,567
    expect(COLUMNS[5]).toBeGreaterThanOrEqual(66); // 1234 tok/s
  });
});
