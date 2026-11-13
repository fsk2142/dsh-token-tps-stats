import { describe, expect, it } from "vitest";

import { countChars, createTpsMeter, tokensOf } from "../../src/client/tps-meter";

describe("字符计数：CJK 与其它分开", () => {
  it("纯中文：每个汉字算 1 个 CJK", () => {
    expect(countChars("你好世界")).toEqual({ cjk: 4, other: 0 });
  });

  it("纯英文：每个字符算 1 个 other", () => {
    expect(countChars("hello")).toEqual({ cjk: 0, other: 5 });
  });

  it("混合文本各归各的", () => {
    expect(countChars("abc中文def")).toEqual({ cjk: 2, other: 6 });
  });

  it("全角标点按 CJK 计（分词器里它们也是 1 字 1 token）", () => {
    expect(countChars("，。！")).toEqual({ cjk: 3, other: 0 });
  });

  it("**按码位而非 UTF-16 长度**：emoji 只算 1 个字符", () => {
    // "😀" 的 length 是 2（代理对），按码位是 1。算成 2 会让速度虚高。
    expect(countChars("😀").other).toBe(1);
  });

  it("空串与纯空白不崩", () => {
    expect(countChars("")).toEqual({ cjk: 0, other: 0 });
  });
});

describe("换算系数", () => {
  it("CJK 1 字 ≈ 1 token", () => {
    expect(tokensOf({ cjk: 100, other: 0 })).toBeCloseTo(100, 5);
  });

  it("其它字符 4.2 个 ≈ 1 token（来自本机 5.03 字符/token 的实测口径）", () => {
    expect(tokensOf({ cjk: 0, other: 42 })).toBeCloseTo(10, 5);
  });

  it("零字符是零 token（不是 NaN）", () => {
    expect(tokensOf({ cjk: 0, other: 0 })).toBe(0);
  });
});

describe("双指数速度计", () => {
  it("稳定流在约三秒内接近目标，长流读数保持稳定", () => {
    const meter = createTpsMeter();
    const readings = [];
    for (let at = 100; at <= 10_000; at += 100) {
      meter.push(10, at);
      if (at >= 3_000) readings.push(meter.reading(at));
    }
    expect(Math.min(...readings)).toBeGreaterThan(93);
    expect(Math.max(...readings)).toBeLessThan(101);
    expect(meter.reading(10_000)).toBeCloseTo(99.8, 0);
    expect(meter.reading(13_000)).toBeGreaterThan(4);
    expect(meter.reading(13_000)).toBeLessThan(7);
    expect(meter.active(20_000)).toBe(false);
  });

  it("插入迟到的数据等于按原始时刻顺序处理", () => {
    const ordered = createTpsMeter();
    ordered.push(100, 1_000);
    ordered.push(20, 1_250);
    const delayed = createTpsMeter();
    delayed.push(20, 1_250);
    const first = delayed.reading(1_500);
    delayed.push(100, 1_000, 1_500);
    expect(delayed.reading(1_500)).toBeGreaterThan(first);
    expect(delayed.reading(1_500)).toBeCloseTo(ordered.reading(1_500), 9);
  });

  it("同毫秒的增量与合并成一包的读数一致", () => {
    const meter = createTpsMeter();
    meter.push(50, 1_000);
    meter.push(30, 1_000);
    expect(meter.reading(1_000)).toBe(0);
    expect(meter.active(1_000)).toBe(true);
    expect(meter.reading(1_650)).toBeCloseTo(45.28, 2);
  });

  it("空闲以及无效计数保持为零", () => {
    const meter = createTpsMeter();
    expect(meter.push(0, 1_000)).toBe(false);
    expect(meter.push(NaN, 1_000)).toBe(false);
    expect(meter.push(30, NaN)).toBe(false);
    expect(meter.reading(1_500)).toBe(0);
    expect(meter.active(1_500)).toBe(false);
  });
});
