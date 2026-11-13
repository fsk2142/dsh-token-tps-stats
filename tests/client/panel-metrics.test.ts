import { describe, expect, it } from "vitest";

import {
  BUTTON_HEIGHT,
  BUTTON_MARGIN_TOP,
  COLUMN_GAP,
  panelContentHeight,
  panelMinHeight,
  PANEL_REFERENCE_STEPS,
  STEP_HEADER_HEIGHT,
  STEP_ROW_HEIGHT,
  stepsBodyHeight,
  SUBTITLE_HEIGHT,
  timeBodyHeight,
  TITLE_HEIGHT,
} from "../../src/client/panel-metrics";

describe("版面：两个页签一样高（用户 2026-11-13 的要求）", () => {
  it("**两页取较高那个，所以一样高**（这就是「方框长宽高一致」）", () => {
    // 5 步那一档：时间页 190，步数页 168 → 统一撑到 190。
    expect(panelContentHeight(5)).toBe(timeBodyHeight());
    expect(panelContentHeight(5)).toBeGreaterThan(stepsBodyHeight(5));
  });

  it("基准档就是用户说的 5 步", () => {
    expect(PANEL_REFERENCE_STEPS).toBe(5);
  });

  it("步数页随行数线性增长（10 / 20 步会更高，那是行数决定的）", () => {
    expect(stepsBodyHeight(10) - stepsBodyHeight(5)).toBe(5 * STEP_ROW_HEIGHT);
    expect(stepsBodyHeight(20) - stepsBodyHeight(10)).toBe(10 * STEP_ROW_HEIGHT);
  });

  it("行数一多，步数页自己就超过了时间页（取高者的逻辑仍然成立）", () => {
    expect(stepsBodyHeight(10)).toBeGreaterThan(timeBodyHeight());
    expect(panelContentHeight(10)).toBe(stepsBodyHeight(10));
  });

  it("0 行（空态）比 5 行矮 —— 所以才要 `panelMinHeight` 兜住", () => {
    expect(stepsBodyHeight(0)).toBeLessThan(stepsBodyHeight(5));
  });

  it("`panelMinHeight` 以**两页较高者**为准（不是只按步数页算）", () => {
    expect(panelMinHeight()).toBeGreaterThan(timeBodyHeight());
    expect(panelMinHeight()).toBeGreaterThan(stepsBodyHeight(PANEL_REFERENCE_STEPS));
  });

  it("负数行数当 0 处理，不会得到更矮的面板", () => {
    expect(stepsBodyHeight(-3)).toBe(stepsBodyHeight(0));
  });

  it("删掉那句提示之后，**时间页更高** —— 对齐靠撑高而不是靠凑巧相等", () => {
    expect(timeBodyHeight()).toBeGreaterThan(stepsBodyHeight(5));
  });

  it("步数页的加数自洽（行高是「16px 行 + 上下各 2px 内边距」）", () => {
    expect(stepsBodyHeight(5) - stepsBodyHeight(4)).toBe(STEP_ROW_HEIGHT);
    expect(STEP_ROW_HEIGHT).toBe(20);
  });

  it("常量本身是自洽的（改了任何一个都会咬住）", () => {
    // 时间页：标题 + gap + 副标题 + gap + 图 + gap + 按钮上边距 + 按钮。
    expect(timeBodyHeight(100)).toBe(
      TITLE_HEIGHT + COLUMN_GAP + SUBTITLE_HEIGHT + COLUMN_GAP + 100 + COLUMN_GAP + BUTTON_MARGIN_TOP + BUTTON_HEIGHT,
    );
  });

  it("步数页也已经不再占一行副标题（那句话被用户删掉了）", () => {
    // 只有标题 + 表头 + N 行 + 按钮，没有 SUBTITLE_HEIGHT。
    expect(stepsBodyHeight(0)).toBe(
      TITLE_HEIGHT + COLUMN_GAP + STEP_HEADER_HEIGHT + COLUMN_GAP + COLUMN_GAP + BUTTON_MARGIN_TOP + BUTTON_HEIGHT,
    );
  });
});
