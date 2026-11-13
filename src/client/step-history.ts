/**
 * **每一步的平均输出速度**（2026-11-13）。
 *
 * ## 用户要的是什么
 *
 * > 就在左上角显示两个：一个是实时速度折线图，一个是步数输出平均速度。
 * > 这边可以显示 1 分钟 / 3 分钟 / 5 分钟，那边可以显示 5 步 / 10 步 / 20 步。
 *
 * 实时曲线回答「现在快不快」，但**「这一步整体多快」**是另一个问题：一次长回复
 * 里前段吐字快、后段慢，曲线会告诉你有起伏，却不会告诉你怎么比。所以这里按
 * **步**（宿主的一次 `step`）收一份统计，弹窗里可以只画最近 5 / 10 / 20 步。
 *
 * ## 一步的「时长」怎么量
 *
 * 不用墙钟（步开始 → 步结束）：一步里有工具调用，模型那时**不在吐字**，把那段
 * 等待算进分母会让每一步的平均速度都很低，毫无可比性。
 *
 * 这里量的是**有字在流的时间**：每次交付字符时，把「上次采样 → 这次采样」的间隔
 * 累加进 `activeMs`（每段最多计 {@link STEP_GAP_CAP_MS}）。主线程被占住几秒后
 * 一次交付一大段，也不会让这一段变成「1 秒吐 500 字」的假峰值。
 *
 * ## 为什么给时长设一个下限
 *
 * 某个步的所有字恰好落在同一帧里时 `activeMs` 几乎为 0，除下去会顶到天上。
 * 用 {@link MIN_DURATION_MS} 兜底：**分母只可能偏大，读数只可能偏低**。宁可少报，
 * 不出假峰值 —— 用户为「偶尔冲到 300 多」专门提过一次。
 *
 * @module dsh-token-tps-stats/src/client/step-history
 */

/** 弹窗里「每步平均」视图可选的步数档。 */
export const TPS_STEP_RANGES = [5, 10, 20] as const;

/** 可选步数档的类型。 */
export type TpsStepRange = (typeof TPS_STEP_RANGES)[number];

/** 默认显示几步。 */
export const TPS_STEP_DEFAULT = 5;

/** 最多留多少步（20 步视图留一倍余量，便于切档时不丢最近的）。 */
const MAX_STEPS = 40;

/** 单次交付的间隔最多计多久（毫秒）：主线程被占住时别让一次交付撑大分母的反面（缩小分母）。 */
const STEP_GAP_CAP_MS = 2_000;

/** 一步的时长下限（毫秒）：见文件头「为什么给时长设一个下限」。 */
const MIN_DURATION_MS = 500;

/** 一步的统计。 */
export interface StepSample {
  /** 这一步的流标识（`turn:step`）。 */
  readonly stream: string;
  /** 估算 token 数。 */
  readonly tokens: number;
  /** 有字在流的总时长（毫秒，已按 {@link STEP_GAP_CAP_MS} 截断）。 */
  readonly activeMs: number;
  /** 这一步开始有字的时刻。 */
  readonly startedAt: number;
  /** 这一步最后有字的时刻。 */
  readonly endedAt: number;
}

/** 一步**在图上**的样子。 */
export interface StepPoint {
  /** 这一步的估算速度（tok/s）。 */
  readonly speed: number;
  /** 序号：0 = 最新这一步，越大越旧（与时间轴一致，方便按位置读）。 */
  readonly stepsAgo: number;
}

/** 步数序列的统计值。 */
export interface StepSummary {
  /** 这几步的平均速度。 */
  readonly average: number;
  /** 这几步里的峰值。 */
  readonly peak: number;
  /** 最新一步（`stepsAgo === 0`）。 */
  readonly latest: number;
}

/** 步统计的对外面。 */
export interface StepHistory {
  /**
   * 记一次交付。
   * @param stream - 流标识（`turn:step`）。
   * @param tokens - 这次交付的估算 token 数。
   * @param gapMs - 距上一次采样的间隔（毫秒）；内部按 {@link STEP_GAP_CAP_MS} 截断。
   * @param at - 这次交付的时刻。
   */
  add(stream: string, tokens: number, gapMs: number, at: number): void;
  /** 最近 `count` 步（**最旧 → 最新**，长度不超过已有的步数）。 */
  series(count: number): StepPoint[];
  /** 最近 `count` 步的统计值。 */
  summary(count: number): StepSummary;
}

/**
 * 一步的速度（tok/s）。
 * @param sample - 这一步的统计。
 * @returns 非负 tok/s；分母不小于 {@link MIN_DURATION_MS}。
 */
function speedOf(sample: StepSample): number {
  if (!Number.isFinite(sample.tokens) || sample.tokens <= 0) return 0;
  const durationMs = Math.max(sample.activeMs, MIN_DURATION_MS);
  return (sample.tokens / durationMs) * 1_000;
}

/**
 * 造一个步统计器。
 * @returns 步统计器。
 */
export function createStepHistory(): StepHistory {
  /** 当前这一步（还不知道它结束没有）。 */
  let current: StepSample | undefined;
  /** 已经翻篇的步（最新在末尾）。 */
  let past: StepSample[] = [];

  /** 把当前这一步推进「已完成」，给下一步腾位置。 */
  const roll = (): void => {
    if (current === undefined) return;
    past.push(current);
    current = undefined;
    if (past.length > MAX_STEPS) past = past.slice(past.length - MAX_STEPS);
  };

  /** 最近 `count` 步（含当前这一步，作为最新）。 */
  const visible = (count: number): StepSample[] => {
    const list = current === undefined ? past : [...past, current];
    const requested = Math.max(1, Math.floor(count));
    return list.length <= requested ? list : list.slice(list.length - requested);
  };
  return {
    add: (stream, tokens, gapMs, at) => {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      if (current !== undefined && current.stream !== stream) roll();
      if (current === undefined) {
        /*
         * 这一步的**第一次交付**也要计间隔：`at - 上一次采样` 正是这批字积累的
         * 时长（新步的第一帧通常紧接上一帧，主线程卡住时会被 {@link STEP_GAP_CAP_MS} 截断）。
         * 不计的话每步开头都少一段，短步骤会被时长下限兜死。
         */
        current = {
          stream,
          tokens,
          activeMs: Math.min(Math.max(0, gapMs), STEP_GAP_CAP_MS),
          startedAt: at,
          endedAt: at,
        };
      } else {
        current = {
          ...current,
          tokens: current.tokens + tokens,
          activeMs: current.activeMs + Math.min(Math.max(0, gapMs), STEP_GAP_CAP_MS),
          endedAt: at,
        };
      }
    },
    series: (count) => {
      const list = visible(count);
      const total = list.length;
      return list.map((sample, index) => ({
        speed: speedOf(sample),
        stepsAgo: total - 1 - index,
      }));
    },
    summary: (count) => {
      const speeds = visible(count).map(speedOf);
      let sum = 0;
      let peak = 0;
      for (const speed of speeds) {
        sum += speed;
        if (speed > peak) peak = speed;
      }
      const latest = speeds.length > 0 ? speeds[speeds.length - 1]! : 0;
      return { average: speeds.length > 0 ? sum / speeds.length : 0, peak, latest };
    },
  };
}

/** **仅供测试**：导出内部常量，方便断言边界。 */
export const STEP_HISTORY_CONSTANTS = {
  maxSteps: MAX_STEPS,
  gapCapMs: STEP_GAP_CAP_MS,
  minDurationMs: MIN_DURATION_MS,
} as const;
