import { describe, expect, it } from "vitest";

import { HELP_SIZE } from "../../src/client/help";
import { helpBodyHeight, panelOuterHeight } from "../../src/client/panel-metrics";
import { panelPlacement, VIEWPORT_MARGIN } from "../../src/client/panel-placement";

/**
 * **`?` 展开后弹层会长高约 250px**（两节共 12 条说明）。
 *
 * 面板是靠 `translateY(-100%)` **向上长**的 —— 变高等于顶边往上跑。
 * 不把这段算进定位，展开说明就会把表头和 `x` 顶出视口，
 * 于是用户看到一个长得像走不掉的弹层。
 */
describe("? 展开：定位要把说明的高度算进去", () => {
  it("说明块高度 = 2 节 × 16 + 12 条 × 16 + 6 + 12 + 8 = **250px**", () => {
    expect(HELP_SIZE).toEqual({ sections: 2, lines: 12 });
    expect(helpBodyHeight(HELP_SIZE.sections, HELP_SIZE.lines)).toBe(250);
  });

  it("展开后外高 = 收起时的外高 + 250", () => {
    const cases: [tab: "time" | "steps", steps: number][] = [
      ["time", 5],
      ["steps", 5],
      ["steps", 10],
      ["steps", 20],
    ];
    for (const [tab, steps] of cases) {
      const closed = panelOuterHeight(tab, steps, false);
      const open = panelOuterHeight(tab, steps, true);
      expect(open - closed, `${tab}/${steps}`).toBe(250);
    }
  });

  it("**5 步档展开后 486px**（236 + 250）", () => {
    expect(panelOuterHeight("steps", 5, true)).toBe(486);
  });

  it("**展开后定位仍然把整块放在视口内**（把表头和 x 留在看得见的地方）", () => {
    const height = panelOuterHeight("steps", 5, true);
    // 900px 高的窗口，胶囊在中下部、上方放不下 486px：应当翻到下方并且装得下。
    const placement = panelPlacement(
      { left: 600, top: 300, right: 700, bottom: 320 },
      "steps",
      5,
      { width: 1_200, height: 900 },
      true,
    );
    expect(placement.below).toBe(true);
    expect(placement.topEdge).toBe(320 + 8);
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
    // 盒子被 maxHeight 压到可用高度，而不是按 764px 摆出去。
    expect(placement.bottomEdge).toBe(500 - VIEWPORT_MARGIN);
  });
});
