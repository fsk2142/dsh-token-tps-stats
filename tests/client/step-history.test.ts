/**
 * **每一步的平均速度**的单测（2026-11-13）。
 *
 * 这块数据回答的是「这一步整体多快」，与实时曲线（「现在快不快」）是两个问题。
 * 容易写歪的边界都钉在这里：
 *
 * 1. 时长只量「有字在流」的部分（工具调用时的等待不该拉低平均值）；
 * 2. 单次交付的间隔封顶，主线程被占住几秒后一次吐一大段不会变成假峰值；
 * 3. 时长有下限，分母不会被压到 0 —— 宁可少报，不出假峰值；
 * 4. 换步就翻篇，最近 `count` 步是最旧 → 最新。
 */
import { describe, expect, it } from "vitest";

import { createStepHistory, STEP_HISTORY_CONSTANTS, TPS_STEP_RANGES } from "../../src/client/step-history";

describe("步统计：口径", () => {
  it("一步 100 token / 2 秒 → 50 tok/s", () => {
    const history = createStepHistory();
    // 第一次交付没有「上一个采样」，间隔按 0 计（由下面的第二次补上时长）。
    history.add("1:1", 50, 0, 1_000);
    history.add("1:1", 50, 2_000, 3_000);
    const summary = history.summary(5);
    // 分母取 max(activeMs, 下限 500) = 2000ms。
    expect(summary.latest).toBeCloseTo(50, 6);
    expect(summary.average).toBeCloseTo(50, 6);
  });

  it("**换步就翻篇**：上一步不会混进这一步的统计", () => {
    const history = createStepHistory();
    history.add("1:1", 300, 1_000, 1_000);
    history.add("1:2", 60, 1_000, 2_000);
    const series = history.series(5);
    expect(series).toHaveLength(2);
    // 最新一步（index 1）只含它自己那 60 token。
    expect(series[1]!.stepsAgo).toBe(0);
    expect(series[1]!.speed).toBeCloseTo(60, 6);
    // 旧一步 300 token / 1s = 300 tok/s。
    expect(series[0]!.speed).toBeCloseTo(300, 6);
  });

  it("**单次交付的间隔封顶**：主线程被占住 30 秒后一次吐 2000 token 不会变成几十 tok/s 以下", () => {
    const history = createStepHistory();
    history.add("1:1", 2_000, 30_000, 30_000);
    const speed = history.summary(1).latest;
    // 分母 = min(30000, 2000) = 2000ms → 1000 tok/s（而不是 66）。
    expect(speed).toBeCloseTo((2_000 / STEP_HISTORY_CONSTANTS.gapCapMs) * 1_000, 6);
  });

  it("**时长有下限**：全部字落在同一帧里也不会顶到天上", () => {
    const history = createStepHistory();
    history.add("1:1", 1_000, 0, 5_000);
    const speed = history.summary(1).latest;
    expect(speed).toBeCloseTo((1_000 / STEP_HISTORY_CONSTANTS.minDurationMs) * 1_000, 6);
  });

  it("0 token 的交付被忽略（不会造出一个 0 步）", () => {
    const history = createStepHistory();
    history.add("1:1", 0, 1_000, 1_000);
    expect(history.series(5)).toHaveLength(0);
  });

  it("非有限值被忽略", () => {
    const history = createStepHistory();
    history.add("1:1", Number.NaN, 1_000, 1_000);
    expect(history.series(5)).toHaveLength(0);
  });
});

describe("步统计：序列形状", () => {
  it("**最旧 → 最新**，`stepsAgo` 反过来数", () => {
    const history = createStepHistory();
    for (let step = 1; step <= 4; step += 1) history.add(`1:${step}`, 100 * step, 1_000, step * 1_000);
    const series = history.series(4);
    expect(series.map((point) => point.stepsAgo)).toEqual([3, 2, 1, 0]);
    // 速度随 step 递增。
    expect(series.map((point) => Math.round(point.speed))).toEqual([100, 200, 300, 400]);
  });

  it("只取最近 `count` 步", () => {
    const history = createStepHistory();
    for (let step = 1; step <= 20; step += 1) history.add(`1:${step}`, 100, 1_000, step * 1_000);
    expect(history.series(5)).toHaveLength(5);
    expect(history.series(5).at(-1)!.stepsAgo).toBe(0);
  });

  it("步数不够时按现有的返回（不补空点）", () => {
    const history = createStepHistory();
    history.add("1:1", 100, 1_000, 1_000);
    expect(history.series(20)).toHaveLength(1);
  });

  it("history 长度封顶（切到 20 步档也不会无限增长）", () => {
    const history = createStepHistory();
    for (let step = 1; step <= STEP_HISTORY_CONSTANTS.maxSteps + 10; step += 1) {
      history.add(`1:${step}`, 100, 1_000, step * 1_000);
    }
    expect(history.series(STEP_HISTORY_CONSTANTS.maxSteps + 5).length).toBeLessThanOrEqual(
      STEP_HISTORY_CONSTANTS.maxSteps + 1,
    );
  });
});

describe("步统计：空态", () => {
  it("一步都没有时全是 0（弹窗据此显示空态）", () => {
    const history = createStepHistory();
    expect(history.series(5)).toEqual([]);
    expect(history.summary(5)).toEqual({ average: 0, peak: 0, latest: 0 });
  });
});

describe("步数档", () => {
  it("是 5 / 10 / 20 三档（用户指定）", () => {
    expect(TPS_STEP_RANGES).toEqual([5, 10, 20]);
  });
});
