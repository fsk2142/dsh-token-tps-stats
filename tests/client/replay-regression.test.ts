/**
 * **真实时间线重放**（2026-11-13，钉住「积压之后读数冲顶」这个老问题）。
 *
 * 数据来源：本机会话日志里 `assistant/attempt.stream` 的冻结时间线
 *（8439 帧 / 296 秒 / 99,020 字符），由脚本导出到 `.tmp/replay.json`（不进版本库）。
 *
 * ## 这一版测的是什么
 *
 * 数据源已经换成「会话快照差分」（见 `session-store.ts`），但**积压**这个坑还在：
 *
 * - **正常**：主线程每 100ms 空出来一次，这一拍到达的字就这么多；
 * - **积压**：主线程被占住 6 秒（后台标签页、渲染大表格），回前台时**6 秒的字
 *   一次性**出现在增量里。若把它们全记在同一毫秒，最近 1 秒的窗口会全吃进去，
 *   读数直接冲到上千 —— 这正是用户报的「峰值都是 1000 多了」。
 *
 * `spread.ts` 把这一拍的字符按「两次采样之间的真实时间差」摊开；这里同时跑
 * 「不摊开」与「摊开」两种做法，断言前者冲高、后者回到真实量级。
 *
 * `.tmp/replay.json` 不存在时跳过（它是一次性诊断数据，不随仓库分发）。
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { spreadCounts } from "../../src/client/spread";
import { createTpsMeter } from "../../src/client/tps-meter";

/** 重放数据形状。 */
interface Replay {
  readonly t0: number;
  readonly frames: readonly [number, number][];
}

/** 数据文件路径（相对仓库根）。 */
const REPLAY_PATH = ".tmp/replay.json";

/** 采样间隔（毫秒）：与生产组件的 `TICK_MS` 一致。 */
const TICK_MS = 100;

/** 模拟「主线程被占住」的时长（毫秒）：2 分钟，够真实（后台标签页、渲染大表格）。 */
const BLOCK_MS = 120_000;
/**
 * 把帧时间线折成「每 100ms 有多少字符」的一串采样。
 * @param replay - 帧时间线（宿主间隔 + 字符数）。
 * @returns `{ at, chars }` 的升序数组。
 */
function samplesOf(replay: Replay): { at: number; chars: number }[] {
  const out: { at: number; chars: number }[] = [];
  let host = replay.t0;
  let pending = 0;
  let nextTick = replay.t0 + TICK_MS;
  for (const [dt, chars] of replay.frames) {
    host += dt;
    pending += chars;
    while (host >= nextTick) {
      out.push({ at: nextTick, chars: pending });
      pending = 0;
      nextTick += TICK_MS;
    }
  }
  if (pending > 0) out.push({ at: nextTick, chars: pending });
  return out;
}

/**
 * 跑一遍采样，边跑边读数，返回读数峰值。
 *
 * **读数按 100ms 一拍**（与生产组件的定时器一致）—— 速度计是 9 个 1 秒窗口 + 3 秒
 * 低通，只在每拍末读一次是看不到它爬升的。
 * @param samples - 采样序列（`chars` 为 0 的拍表示这一拍没收到字）。
 * @param spread - `true` = 把每一拍的字符按时间差摊开（新做法）。
 * @returns 读数峰值（tok/s）。
 */
function peakOf(samples: readonly { at: number; chars: number }[], spread: boolean): number {
  const meter = createTpsMeter();
  let peak = 0;
  let previousAt = samples[0]?.at ?? 0;
  for (const sample of samples) {
    if (sample.chars > 0) {
      if (spread) {
        for (const slice of spreadCounts({ cjk: 0, other: sample.chars }, previousAt, sample.at)) {
          meter.pushCounts(slice, slice.at);
        }
      } else {
        // 不摊开：整拍的字符全记在这一毫秒上。
        meter.pushCounts({ cjk: 0, other: sample.chars }, sample.at);
      }
    }
    const value = meter.reading(sample.at);
    if (value !== undefined && value > peak) peak = value;
    previousAt = sample.at;
  }
  return peak;
}

/** 从帧时间线里算出「真实的长期平均 tok/s」（用 `tps-meter` 的换算系数）。 */
function trueRate(replay: Replay): number {
  const spanMs = replay.frames.reduce((sum, [dt]) => sum + dt, 0);
  // 这些帧全是英文/代码（`x`），按 `OTHER_CHARS_PER_TOKEN = 4.2` 换算。
  const chars = replay.frames.reduce((sum, [, len]) => sum + len, 0);
  return chars / 4.2 / (spanMs / 1_000);
}

describe.skipIf(!existsSync(REPLAY_PATH))("真实时间线重放", () => {
  const replay = JSON.parse(readFileSync(REPLAY_PATH, "utf8")) as Replay;
  const truth = trueRate(replay);
  const normal = samplesOf(replay);

  it("正常流式：不算积压，读数贴着真实长期平均", () => {
    expect(peakOf(normal, true), `真实长期平均约 ${truth.toFixed(0)} tok/s`).toBeLessThan(truth * 2);
  });

  it("**积压 2 分钟：不摊开会冲高，摊开之后回到真实量级**", () => {
    /*
     * 把 6 秒内的采样合并成一拍送到速度计 —— 模拟主线程被占住后的一次性 flush。
     */
    const blocked: { at: number; chars: number }[] = [];
    let carry = 0;
    let windowStart = normal[0]?.at ?? 0;
    for (const sample of normal) {
      carry += sample.chars;
      if (sample.at - windowStart >= BLOCK_MS) {
        blocked.push({ at: sample.at, chars: carry });
        carry = 0;
        windowStart = sample.at;
      }
    }
    if (carry > 0 && blocked.length > 0) blocked[blocked.length - 1]!.chars += carry;

    const naive = peakOf(blocked, false);
    const paced = peakOf(blocked, true);
    expect(naive, "不摊开时这 6 秒的字会挤进同一毫秒").toBeGreaterThan(truth * 3);
    expect(paced, "摊开之后回到真实量级").toBeLessThan(truth * 1.6);
  });
});
