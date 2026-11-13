/**
 * **胶囊文字**的单测（2026-11-13）。
 *
 * 那一格只有一个语义：**输出文本的速度**。中途试过「只调工具时显示『工具调用中』」，
 * 用户看过之后决定回到 `0 tok/s` —— 见 `label.ts` 文件头的说明。
 *
 * 所以这里钉住两件事：
 * 1. 数字那一段占定宽位置（`0` / `12` / `1000` 都以同一格式呈现）；
 * 2. 非法读数（`NaN` / 负数 / `Infinity`）一律落到 `0`，不污染显示。
 */
import { describe, expect, it } from "vitest";

import { formatRate } from "../../src/client/format";
import { pillAriaOf, pillLabelOf } from "../../src/client/label";

describe("胶囊文本", () => {
  it("有速度 → 数字 + 单位", () => {
    expect(pillLabelOf(42.6, formatRate)).toEqual({
      prefix: "实时输出速度（TPS）：",
      number: "43",
      suffix: " tok/s",
    });
  });

  it("**空闲 → 0 tok/s**（用户明确要求：不要消失、不要状态词）", () => {
    expect(pillLabelOf(0, formatRate).number).toBe("0");
  });

  it("非法读数一律落到 0（不显示 `NaN` / 负数 / `Infinity`）", () => {
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(pillLabelOf(bad, formatRate).number).toBe("0");
    }
  });

  it("数字与单位之间只有一个空格", () => {
    expect(pillLabelOf(7, formatRate).suffix).toBe(" tok/s");
  });
});

describe("无障碍文案", () => {
  it("读成一句话", () => {
    expect(pillAriaOf(42, formatRate, false)).toBe("实时输出速度（TPS）：42 tok/s，点击查看变化曲线");
  });

  it("已展开时后半句换成「收起」", () => {
    expect(pillAriaOf(42, formatRate, true)).toContain("收起");
  });

  it("非法读数也读 0，不是 NaN", () => {
    expect(pillAriaOf(Number.NaN, formatRate, false)).toContain("0 tok/s");
  });
});
