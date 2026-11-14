import { describe, expect, it } from "vitest";

import { PANEL_WIDTH, panelOuterHeight } from "../../src/client/panel-metrics";
import { panelMaxHeight, panelPlacement, PANEL_GAP, VIEWPORT_MARGIN } from "../../src/client/panel-placement";

/**
 * 定位（{@link panelPlacement}）的净结果：面板占据的竖带
 * `[topEdge, bottomEdge]` 必须落在视口内（留 `VIEWPORT_MARGIN`）。
 *
 * ## 这些用例测的是**真的那一份**实现
 *
 * 2026-11-14 之前定位逻辑埋在渲染函数里，没法直接测 —— 想验证只能「在测试里
 * 重写一遍同样的算法」，而那种测试会在生产改动时一起漂走。抽成纯模块之后，
 * 这里调用的就是生产用的同一个函数。
 *
 * 覆盖的三种真实情形：
 * 1. 正常窗口 → 摆在胶囊上方，整块可见；
 * 2. 上方不足、下方够 → 翻到下面；
 * 3. 20 步档（514px）配矮窗口 → **谁放不下也贴住上边距**（表头必须可见）。
 */
describe("弹层定位", () => {
  const steps20 = panelOuterHeight("steps", 20);

  it("正常窗口（900px）里摆在胶囊上方，整块可见", () => {
    const placement = panelPlacement({ left: 100, top: 800, right: 200, bottom: 820 }, "time", 5, {
      width: 1_200,
      height: 900,
    });
    expect(placement.below).toBe(false);
    expect(placement.topEdge).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(placement.bottomEdge).toBeLessThanOrEqual(900 - VIEWPORT_MARGIN);
    // 放在上方时 `top` 是底边：底边 = 胶囊上沿 - 间距。
    expect(placement.top).toBe(800 - PANEL_GAP);
  });

  it("上方不足、下方够 → 翻到下面（顶边 = 胶囊下沿 + 间距）", () => {
    const placement = panelPlacement({ left: 100, top: 120, right: 200, bottom: 140 }, "steps", 10, {
      width: 1_200,
      height: 900,
    });
    expect(placement.below).toBe(true);
    expect(placement.topEdge).toBe(140 + PANEL_GAP);
    expect(placement.bottomEdge).toBeLessThanOrEqual(900 - VIEWPORT_MARGIN);
  });

  it("**20 步档（514px）配 500px 高的窗口：贴住上边距，不被甩出视口**", () => {
    const placement = panelPlacement({ left: 100, top: 400, right: 200, bottom: 420 }, "steps", 20, {
      width: 1_200,
      height: 500,
    });
    expect(steps20).toBe(514);
    expect(placement.topEdge).toBe(VIEWPORT_MARGIN);
    // 放不下时允许底部溢出，但顶部必须可见（表头 / ? / x 都在顶部）。
    expect(placement.bottomEdge).toBeGreaterThan(0);
  });

  it("**装得下时必须完全装下**（5 步 / 236px，四种锚点位置）", () => {
    const height = panelOuterHeight("steps", 5);
    for (const anchorTop of [40, 198, 250, 700, 860]) {
      const placement = panelPlacement(
        { left: 100, top: anchorTop, right: 200, bottom: anchorTop + 20 },
        "steps",
        5,
        { width: 1_200, height: 900 },
      );
      expect(placement.topEdge, `锚点 ${anchorTop}`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      expect(placement.bottomEdge, `锚点 ${anchorTop}`).toBeLessThanOrEqual(900 - VIEWPORT_MARGIN);
      expect(placement.bottomEdge - placement.topEdge).toBe(height);
    }
  });

  it("横向夹在视口内（胶囊贴左右边都不出界）", () => {
    for (const left of [-50, 1_180, 600]) {
      const placement = panelPlacement({ left, top: 700, right: left + 100, bottom: 720 }, "time", 5, {
        width: 1_200,
        height: 900,
      });
      expect(placement.left, `left=${left}`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      expect(placement.left + PANEL_WIDTH, `left=${left}`).toBeLessThanOrEqual(1_200 - VIEWPORT_MARGIN);
    }
  });

  it("没有锚点时贴左下角，仍然可见", () => {
    const placement = panelPlacement(undefined, "time", 5, { width: 1_200, height: 900 });
    expect(placement.left).toBe(VIEWPORT_MARGIN);
    expect(placement.topEdge).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(placement.bottomEdge).toBeLessThanOrEqual(900);
  });

  it("**矮窗口里靠 maxHeight 开启内部滚动**（否则底部档位按钮永远够不到）", () => {
    // 20 步 + ? 展开 = 764px，窗口只有 600px：面板会被截断并自己滚。
    const placement = panelPlacement(undefined, "steps", 20, { width: 1_200, height: 600 }, true);
    const maxHeight = panelMaxHeight(placement.topEdge, placement.innerHeight);
    expect(maxHeight).toBe(600 - VIEWPORT_MARGIN - VIEWPORT_MARGIN);
    expect(maxHeight).toBeLessThan(panelOuterHeight("steps", 20, true));
  });

  it("装得下时 maxHeight 大于内容高度（不生效）", () => {
    const placement = panelPlacement({ left: 100, top: 700, right: 200, bottom: 720 }, "time", 5, {
      width: 1_200,
      height: 900,
    });
    const maxHeight = panelMaxHeight(placement.topEdge, placement.innerHeight);
    expect(maxHeight).toBeGreaterThan(panelOuterHeight("time", 5));
  });
});
