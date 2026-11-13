/**
 * **数字格式化**的单测（2026-11-12，第 3 步；2026-11-13 加 token / 百分比）。
 */
import { describe, expect, it } from "vitest";

import { formatPercent, formatRatio, formatRate, formatTokens } from "../../src/client/format";

describe("速度：一律整数", () => {
  it("四舍五入到个位（读数本来就是估算，小数位是假的）", () => {
    expect(formatRate(42.6)).toBe("43");
    expect(formatRate(42.4)).toBe("42");
    expect(formatRate(0)).toBe("0");
  });

  it("非法值落到 0（不显示 NaN / Infinity）", () => {
    expect(formatRate(Number.NaN)).toBe("0");
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatRate(-5)).toBe("0");
  });
});

describe("token 数：千分位", () => {
  it("上万加千分位（「128,493」比「128493」好读）", () => {
    expect(formatTokens(128_493)).toBe("128,493");
    expect(formatTokens(1_234_567)).toBe("1,234,567");
  });

  it("小数字不加分隔", () => {
    expect(formatTokens(300)).toBe("300");
    expect(formatTokens(0)).toBe("0");
  });

  it("拿不到时显示破折号（不拿 0 假装是账单）", () => {
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
});

describe("缓存命中：整数百分比", () => {
  it("正常比例", () => {
    expect(formatPercent(900, 1_020)).toBe("88%");
  });

  it("分母为 0 / 缺值时是破折号", () => {
    expect(formatPercent(10, 0)).toBe("—");
    expect(formatPercent(10, undefined)).toBe("—");
    expect(formatPercent(undefined, 100)).toBe("—");
  });

  it("被夹在 0~100 之间（脏数据不会显示成 300%）", () => {
    expect(formatPercent(500, 100)).toBe("100%");
  });
});

describe("缓存命中：统一两位小数（用户 2026-11-13 要求）", () => {
  it("**真实 99.87% 就显示 99.87%，不能读成 100%**（用户截图那行的比例）", () => {
    expect(formatRatio(394_880 / (394_880 + 496))).toBe("99.87%");
  });

  it("**只有比例恰好是 1 才显示 100%**（真满命中不加小数点）", () => {
    expect(formatRatio(1)).toBe("100%");
  });

  it("不足两位的补零，让数值列位数一致", () => {
    expect(formatRatio(0.62)).toBe("62.00%");
    expect(formatRatio(0.5)).toBe("50.00%");
    expect(formatRatio(0)).toBe("0.00%");
  });

  it("很接近 100 时仍然不是 100（99.9999 → 99.99%，不是 100%）", () => {
    expect(formatRatio(0.999999)).toBe("99.99%");
  });

  it("普通比例保留两位", () => {
    expect(formatRatio(0.9731)).toBe("97.31%");
  });

  it("缺值是破折号", () => {
    expect(formatRatio(undefined)).toBe("—");
    expect(formatRatio(Number.NaN)).toBe("—");
  });
});
