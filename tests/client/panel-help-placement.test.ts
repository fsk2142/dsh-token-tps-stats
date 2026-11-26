import { describe, expect, it } from "vitest";

import { HELP_SIZE } from "../../src/client/help";
import { helpBodyHeight, panelMinHeight, panelOuterHeight } from "../../src/client/panel-metrics";
import { panelPlacement, VIEWPORT_MARGIN } from "../../src/client/panel-placement";

/**
 * **`?` 展开后弹层会长高**（高度由 `HELP_SIZE` 与 `helpBodyHeight()` 推导）。
 *
 * 面板是靠 `translateY(-100%)` **向上长**的 —— 变高等于顶边往上跑。
 * 不把这段算进定位，展开说明就会把表头和 `x` 顶出视口，
 * 于是用户看到一个长得像走不掉的弹层。
 */
describe("? 展开：定位要把说明的高度算进去", () => {
  const helpHeight = helpBodyHeight(HELP_SIZE.sections, HELP_SIZE.lines);

  it("说明块高度与实际 HELP_SIZE 一致", () => {
    expect(HELP_SIZE.sections).toBeGreaterThanOrEqual(3);
    expect(HELP_SIZE.lines).toBeGreaterThanOrEqual(18);
    expect(helpHeight).toBe(
      HELP_SIZE.sections * 16 + HELP_SIZE.lines * 16 + (HELP_SIZE.sections - 1) * 6 + HELP_SIZE.lines + 8,
    );
  });

  it("展开后外高 = 收起时的外高 + 实际说明高度", () => {
    const cases: [tab: "time" | "steps" | "details", steps: number][] = [
      ["time", 5],
      ["steps", 5],
      ["steps", 10],
      ["steps", 20],
      ["details", 5],
    ];
    for (const [tab, steps] of cases) {
      const closed = panelOuterHeight(tab, steps, false);
      const open = panelOuterHeight(tab, steps, true);
      expect(open - closed, `${tab}/${steps}`).toBe(helpHeight);
    }
  });

  it("**5 步档展开后的外高由实际说明高度推导**", () => {
    expect(panelOuterHeight("steps", 5, true)).toBe(panelMinHeight() + helpHeight);
  });

  it("**展开后定位仍然把整块放在视口内**（把表头和 x 留在看得见的地方）", () => {
    const height = panelOuterHeight("steps", 5, true);
    // 说明扩到三节后面板高 610px；900px 窗口里把胶囊放在 200px 处，确保下方装得下。
    const placement = panelPlacement(
      { left: 600, top: 200, right: 700, bottom: 220 },
      "steps",
      5,
      { width: 1_200, height: 900 },
      true,
    );
    expect(placement.below).toBe(true);
    expect(placement.topEdge).toBe(220 + 8);
    expect(placement.bottomEdge).toBeLessThanOrEqual(900 - VIEWPORT_MARGIN);
    expect(placement.bottomEdge - placement.topEdge).toBe(height);
  });

  it("**窗口不够高时（500px）贴住上边距**，表头不被顶出视口", () => {
    const height = panelOuterHeight("steps", 20, true);
    const placement = panelPlacement(
      { left: 600, top: 420, right: 700, bottom: 440 },
      "steps",
      20,
      { width: 1_200, height: 500 },
      true,
    );
    expect(height).toBeGreaterThan(500);
    expect(placement.topEdge).toBe(VIEWPORT_MARGIN);
    // 盒子被 maxHeight 压到可用高度，而不是按展开后的总高摆出去。
    expect(placement.bottomEdge).toBe(500 - VIEWPORT_MARGIN);
  });
});
