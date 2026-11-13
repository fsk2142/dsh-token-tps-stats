import { describe, expect, it } from "vitest";

import {
  BUTTON_HEIGHT,
  BUTTON_MARGIN_TOP,
  CHART_SVG_HEIGHT,
  COLUMN_GAP,
  panelMinHeight,
  PANEL_REFERENCE_STEPS,
  STEP_ROW_HEIGHT,
  stepsBodyHeight,
  SUBTITLE_HEIGHT,
  timeBodyHeight,
  TITLE_HEIGHT,
} from "../../src/client/panel-metrics";

describe("版面：两个页签一样高（用户 2026-11-13 的要求）", () => {
  it("**时间页 == 5 步的步数页**（这就是「方框长宽高一致」）", () => {
    expect(timeBodyHeight()).toBe(stepsBodyHeight(PANEL_REFERENCE_STEPS));
  });

  it("基准档就是用户说的 5 步", () => {
    expect(PANEL_REFERENCE_STEPS).toBe(5);
  });

  it("步数页随行数线性增长（10 / 20 步会更高，那是行数决定的）", () => {
    expect(stepsBodyHeight(10) - stepsBodyHeight(5)).toBe(5 * STEP_ROW_HEIGHT);
    expect(stepsBodyHeight(20) - stepsBodyHeight(10)).toBe(10 * STEP_ROW_HEIGHT);
  });

  it("0 行（空态）比 5 行矮 —— 所以才要 `panelMinHeight` 兜住", () => {
    expect(stepsBodyHeight(0)).toBeLessThan(stepsBodyHeight(5));
  });

  it("`panelMinHeight` ≥ 5 步那一页的总高（含内边距与头部）", () => {
    expect(panelMinHeight()).toBeGreaterThan(stepsBodyHeight(PANEL_REFERENCE_STEPS));
  });

  it("负数行数当 0 处理，不会得到更矮的面板", () => {
    expect(stepsBodyHeight(-3)).toBe(stepsBodyHeight(0));
  });

  it("折线图高度是**算出来的**：改它就会破坏对齐（这条挡住随手改常量）", () => {
    expect(timeBodyHeight(CHART_SVG_HEIGHT)).toBe(stepsBodyHeight(5));
    expect(timeBodyHeight(CHART_SVG_HEIGHT + 1)).not.toBe(stepsBodyHeight(5));
  });

  it("常量本身是自洽的（改了任何一个都会咬住）", () => {
    // 时间页：标题 + gap + 副标题 + gap + 图 + gap + (按钮上边距 + 按钮)。
    expect(timeBodyHeight(100)).toBe(
      TITLE_HEIGHT + COLUMN_GAP + SUBTITLE_HEIGHT + COLUMN_GAP + 100 + COLUMN_GAP + BUTTON_MARGIN_TOP + BUTTON_HEIGHT,
    );
  });

  it("步数页的加数同样自洽（行高是「16px 行 + 上下各 2px 内边距」）", () => {
    expect(stepsBodyHeight(5) - stepsBodyHeight(4)).toBe(STEP_ROW_HEIGHT);
    expect(STEP_ROW_HEIGHT).toBe(20);
  });
});
