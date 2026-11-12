/**
 * **真实时间线重放**（2026-11-13，验证「峰值偶尔冲到 1000 多」的根因与修法）。
 *
 * 数据来源：本机会话日志里 `assistant/attempt.stream` 的冻结时间线
 *（8439 帧 / 296 秒 / 99,020 字符），由脚本导出到 `.tmp/replay.json`（不进版本库）。
 *
 * 两种到达方式各跑一遍：
 *
 * 1. **正常流式**：每帧按它真实的宿主时间到达；
 * 2. **积压 flush**：主线程被占住后，整段几分钟的帧在几毫秒内一起到达 ——
 *    旧做法（按到达时刻）会读到上千 tok/s，新做法（按宿主时间差重排）仍然接近真实值。
 *
 * 读数的采样方式与生产一致：每 100ms 一次，期间把「已经到了」的帧推给速度计
 *（低通需要时间流逝才能爬上去，所以不能在同一毫秒里连续读）。
 *
 * `.tmp/replay.json` 不存在时跳过（它是一次性诊断数据，不随仓库分发）。
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { retimeBatch } from "../../src/client/pacing";
import { createTpsHistory } from "../../src/client/tps-history";
import { createTpsMeter } from "../../src/client/tps-meter";

/** 重放数据形状。 */
interface Replay {
  readonly t0: number;
  readonly frames: readonly [number, number][];
}

/** 一次重放的结果。 */
interface Outcome {
  /** 速度计的读数峰值（tok/s）。 */
  readonly meterPeak: number;
  /** 折线图历史在最后一分钟里的峰值（tok/s）。 */
  readonly historyPeak: number;
}

/** 数据文件路径（相对仓库根）。 */
const REPLAY_PATH = ".tmp/replay.json";

/** 读数采样间隔（毫秒）：与生产组件的 `TICK_MS` 一致。 */
const TICK_MS = 100;

/**
 * 重放一遍。
 * @param replay - 帧时间线（宿主间隔 + 字符数）。
 * @param arrivalOf - 给帧算「本地到达时刻」的函数。
 * @param retime - `true` = 先按宿主时间差重排（新做法）。
 * @returns 峰值。
 */
function replayAll(
  replay: Replay,
  arrivalOf: (index: number, hostAt: number) => number,
  retime: boolean,
): Outcome {
  const meter = createTpsMeter();
  const history = createTpsHistory();
  const hostTimes: number[] = [];
  const arrivals: number[] = [];
  let hostAt = replay.t0;
  for (let index = 0; index < replay.frames.length; index += 1) {
    hostAt += replay.frames[index]![0];
    hostTimes.push(hostAt);
    arrivals.push(arrivalOf(index, hostAt));
  }
  // 重排：整段当一批（最坏情况）——批尾对齐到最后一个到达时刻。
  // 重排返回 `null` 表示「比能画的历史更旧」，整段重放时直接跳过这类帧。
  const retimed = retime
    ? retimeBatch(
        hostTimes.map((host, index) => ({ host, arrival: arrivals[index]! })),
        arrivals[arrivals.length - 1]!,
      )
    : arrivals;
  const times: number[] = [];
  const kept: number[] = [];
  for (let index = 0; index < retimed.length; index += 1) {
    const at = retimed[index];
    if (at === null || at === undefined) continue;
    times.push(at);
    kept.push(index);
  }

  const firstSample = Math.min(...times);
  const lastSample = Math.max(...times) + 3_000;
  let cursor = 0;
  let meterPeak = 0;
  let lastRead = 0;
  for (let now = firstSample; now <= lastSample; now += TICK_MS) {
    // 把「已经到达」的帧推给速度计（顺序 = 时间顺序）。
    while (cursor < times.length && times[cursor]! <= now) {
      const chars = replay.frames[kept[cursor]!]![1];
      if (chars > 0) {
        const text = "x".repeat(chars);
        meter.push(text, times[cursor]!);
        history.push(text, times[cursor]!);
      }
      cursor += 1;
    }
    const value = meter.reading(now);
    lastRead = now;
    if (value !== undefined && value > meterPeak) meterPeak = value;
  }
  let historyPeak = 0;
  for (const point of history.series(lastRead, 60)) {
    if (point.value > historyPeak) historyPeak = point.value;
  }
  return { meterPeak, historyPeak };
}

/** 从帧时间线里算出「真实的长期平均 tok/s」。 */
function trueRate(replay: Replay): number {
  const spanMs = replay.frames.reduce((sum, [dt]) => sum + dt, 0);
  const chars = replay.frames.reduce((sum, [, len]) => sum + len, 0);
  return chars / 4.2 / (spanMs / 1_000);
}

describe.skipIf(!existsSync(REPLAY_PATH))("真实时间线重放", () => {
  const replay = JSON.parse(readFileSync(REPLAY_PATH, "utf8")) as Replay;
  const truth = trueRate(replay);

  it("正常流式：按到达时刻也能读出接近真实速度", () => {
    // 每帧「准时」到达：到达时刻 = 宿主时间（只做整体平移）。
    const outcome = replayAll(replay, (_index, hostAt) => hostAt, false);
    expect(outcome.meterPeak, `真实长期平均约 ${truth.toFixed(0)} tok/s`).toBeLessThan(truth * 1.8);
  });

  it("**积压 flush：旧做法冲高，新做法不冲**（这就是 1000 多的来源）", () => {
    /*
     * 模拟最坏情况：所有帧都在最后几毫秒内到达（主线程被占住 + 一次性 flush）。
     *
     * - 旧做法（`retime: false`）：几分钟的字挤进几毫秒 → 读数爆表；
     * - 新做法（`retime: true`）：按宿主时间差铺回 296 秒 → 与正常流式一致。
     */
    const arrivalOf = (index: number): number => 1_000 + Math.floor(index / 1_000);
    const naive = replayAll(replay, arrivalOf, false);
    const paced = replayAll(replay, arrivalOf, true);

    expect(naive.meterPeak, "旧做法在积压时必然冲高（这正是用户报的现象）").toBeGreaterThan(500);
    expect(paced.meterPeak, "重排之后回到真实量级").toBeLessThan(truth * 1.5);
    expect(paced.historyPeak, "折线图峰值同样回到真实量级").toBeLessThan(truth * 1.5);
  });
});
