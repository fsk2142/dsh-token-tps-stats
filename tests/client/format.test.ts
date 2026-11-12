/**
 * **数字格式化**的单测（2026-11-13）。
 *
 * 钉住两条：
 * 1. **一律整数**（用户要求：「不要有小数了，实际上也不可能存在小数」）；
 * 2. 非有限值 / 负数一律当 0，不产出 `NaN` / `-3`。
 */
import { describe, expect, it } from "vitest";

import { formatRate } from "../../src/client/format";

describe("整数口径", () => {
  it("**没有小数点**：10 以上、10 以下都是整数", () => {
    for (const value of [0, 0.4, 1.4, 4.2, 9.6, 10.5, 42.7, 148.2, 1_234.9]) {
      expect(formatRate(value), `${value} 不该带小数`).not.toContain(".");
    }
  });

  it("按四舍五入变化（4.2 → 4，4.6 → 5）", () => {
    expect(formatRate(4.2)).toBe("4");
    expect(formatRate(4.6)).toBe("5");
  });

  it("0.4 显示 0（低于显示阈值的读数就是没有速度）", () => {
    expect(formatRate(0.4)).toBe("0");
  });

  it("大数是整数、不加千分位（与官方胶囊同口径）", () => {
    expect(formatRate(1_234.9)).toBe("1235");
  });
});

describe("兜底", () => {
  it("负数当 0", () => {
    expect(formatRate(-3)).toBe("0");
  });

  it("非有限值当 0（不产出 NaN）", () => {
    expect(formatRate(Number.NaN)).toBe("0");
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
