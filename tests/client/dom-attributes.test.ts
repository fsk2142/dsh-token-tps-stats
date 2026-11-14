import { describe, expect, it } from "vitest";

import { PANEL_ATTRIBUTE, PILL_ATTRIBUTE } from "../../src/client/dom-attributes";

/**
 * 这两个字符串是**跨模块契约**：胶囊渲染时带上 `PILL_ATTRIBUTE`，
 * 弹层关闭时用它做「点的不是胶囊」的豁免；弹层根节点带 `PANEL_ATTRIBUTE`，
 * 用来判断「点在弹层里」。
 *
 * 2026-11-14 之前它们各写了两份（`tps-chart.ts` / `tps-pill.ts`）。
 * 现在收进一个模块 —— 这组用例钉住「它们是唯一的来源、且值符合约定的前缀」。
 */
describe("DOM 标记属性", () => {
  it("值符合 `data-token-tps-` 前缀约定", () => {
    expect(PILL_ATTRIBUTE).toBe("data-token-tps-pill");
    expect(PANEL_ATTRIBUTE).toBe("data-token-tps-chart");
  });

  it("两个属性互不相同（否则豁免判断会一起命中）", () => {
    expect(PILL_ATTRIBUTE).not.toBe(PANEL_ATTRIBUTE);
  });

  it("都是合法的 HTML 自定义属性名（小写 + 连字符，不含空格）", () => {
    for (const attribute of [PILL_ATTRIBUTE, PANEL_ATTRIBUTE]) {
      expect(attribute).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(attribute.startsWith("data-")).toBe(true);
    }
  });
});
