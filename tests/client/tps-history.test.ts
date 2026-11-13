/**
 * **折线图历史**的单测（2026-11-12，第 3 步）。
 *
 * 钉住四件事：
 * 1. 每帧只写一个秒桶 —— 空闲时**没有定时器**，也就没有空转；
 * 2. 每个点都是「最近 9 秒滑动平均」，与胶囊**同一口径**；
 * 3. 序列长度恒定、结尾落在**已走完的整秒**（当前半秒不会塌出坑）；
 * 4. 内存恒定：超出保留期的桶被丢弃。
 */
import { describe, expect, it } from "vitest";

import { createTpsHistory } from "../../src/client/tps-history";

/** 一个可控时钟的历史记录器（9 秒平滑，与生产一致）。 */
function history(seconds = 180) {
  return createTpsHistory({ seconds, binMs: 1_000, smoothWindows: 9 });
}

describe("折线图历史：每秒一个桶", () => {
  it("**滑动窗与「每点各扫一遍」等价**（2026-11-13 的性能优化）", () => {
    /*
     * 优化把「每个点各自 `Map.get` 9 次」（300 秒就是 2700 次查找）改成滑动窗
     * 「加进新桶、减去滑出窗口的桶」（300 + 9 次）。这条用手算参照对拍：
     * 同样的桶集合，每一点必须与「点及其前 8 个桶之和 ÷ 窗口长度」一致。
     */
    const BASE = 1_000_000;
    /** 有输出的那几秒（绝对桶序号 = BASE + 秒）。 */
    const pushed = new Set([0, 1, 2, 4, 5, 7, 9, 10].map((second) => BASE + second));
    const h = history();
    for (const bucket of pushed) h.pushCounts({ cjk: 0, other: 84 }, bucket * 1_000);
    const at = BASE + 12_000;
    /** 某个绝对桶里的 token（84 字符 ÷ 4.2 = 20）。 */
    const tokensIn = (bucket: number): number => (pushed.has(bucket) ? 20 : 0);
    const end = Math.floor(at / 1_000);
    for (const point of h.series(at, 12)) {
      const boundary = end - point.secondsAgo;
      let tokens = 0;
      for (let step = 0; step < 9; step += 1) tokens += tokensIn(boundary - step);
      expect(point.value, `secondsAgo=${point.secondsAgo}`).toBeCloseTo((tokens / 9_000) * 1_000, 9);
    }
  });

  it("**统计值不建点列也算对**（平均 / 峰值 / 最新与 series 一致）", () => {
    const h = history();
    for (const second of [0, 3, 6, 9]) h.pushCounts({ cjk: 0, other: 84 }, 1_000_000 + second * 1_000);
    const at = 1_000_000 + 12_000;
    const points = h.series(at, 12);
    const summary = h.summary(at, 12);
    const sum = points.reduce((total, point) => total + point.value, 0);
    expect(summary.average).toBeCloseTo(sum / points.length, 9);
    expect(summary.peak).toBeCloseTo(Math.max(...points.map((point) => point.value)), 9);
    expect(summary.latest).toBeCloseTo(points[points.length - 1]!.value, 9);
  });

  it("**最旧 → 最新**：`secondsAgo` 单调递减到 0", () => {
    const points = history().series(10_000, 5);
    expect(points.map((point) => point.secondsAgo)).toEqual([4, 3, 2, 1, 0]);
  });

  it("**完全空闲时序列全是 0**，没有 NaN", () => {
    for (const point of history().series(10_000, 10)) {
      expect(point.value).toBe(0);
    }
  });

  it("**最后一点落在已走完的整秒**：当前半秒不参与（否则每帧都塌一个坑）", () => {
    const h = history();
    // 在第 10 秒的**后半段**（10.6s）和 11.4s 各推一批；序列在 11.5s 时读。
    h.push("x".repeat(42), 10_600);
    h.push("x".repeat(42), 11_400);
    const points = h.series(11_500, 2);
    /*
     * 最后一点对应桶 11（10.5s 之后那一秒里只有 10.6s 那批），不含 11.4s 之后
     * 还没走完的 11.5~12.0。换句话说时间轴只画完整的秒。
     */
    expect(points[points.length - 1]!.value).toBeGreaterThan(0);
  });

  it("**每个点是最近 9 秒滑动平均**：稳定输出时读数对得上真实速度", () => {
    const h = history();
    // 20 秒、每秒 42 个其它字符 = 10 tok/s（与 tps-meter 的用例同一口径）。
    for (let second = 1; second <= 20; second += 1) h.push("x".repeat(42), second * 1_000);
    const points = h.series(20_500, 3);
    for (const point of points) {
      expect(point.value).toBeCloseTo(10, 0);
    }
  });

  it("**空桶按 0 计入**：停下来之后折线要往下走，不是僵在高位", () => {
    const h = history();
    for (let second = 1; second <= 9; second += 1) h.push("x".repeat(42), second * 1_000);
    const moving = h.series(9_500, 1)[0]!.value;
    expect(moving).toBeCloseTo(10, 0);
    // 再空 5 秒：最近 9 秒里只有 4 秒有数据 → 平均掉到 4~5 左右。
    const stopped = h.series(14_500, 1)[0]!.value;
    expect(stopped).toBeLessThan(moving);
    expect(stopped).toBeGreaterThan(0);
  });

  it("**统计值**：average / peak / latest 各算各的", () => {
    const h = history();
    // 前 5 秒 20 tok/s（84 字符/秒），后 5 秒 10 tok/s（42 字符/秒）。
    for (let second = 1; second <= 5; second += 1) h.push("x".repeat(84), second * 1_000);
    for (let second = 6; second <= 10; second += 1) h.push("x".repeat(42), second * 1_000);
    // 读到第 20 秒：最近 9 秒几乎全空（只摊到 5~10 秒那批），latest 必然最低。
    const summary = h.summary(20_500, 20);
    expect(summary.peak).toBeGreaterThan(summary.latest);
    expect(summary.average).toBeGreaterThan(0);
    expect(summary.average).toBeLessThanOrEqual(summary.peak);
  });

  it("**内存恒定**：超出保留期的桶被丢弃", () => {
    const h = history(30);
    h.push("x", 1_000);
    // 保留期 = 30 + 9 = 39 个桶；推到 200 秒之后，早期数据必须已被剪掉。
    expect(h.summary(200_000, 200).peak).toBe(0);
  });

  it("空文本不写桶（`block-start` 这类 0 字符帧不参与）", () => {
    const h = history();
    h.push("", 1_000);
    expect(h.series(1_500, 1)[0]!.value).toBe(0);
  });
});
