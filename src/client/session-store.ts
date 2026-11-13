/**
 * **每个会话一份的实时速度状态**（2026-11-13，修「统计的是全局速度」）。
 *
 * ## 为什么要重写数据源
 *
 * 用户原话：「另外应该统计的是每个会话自己的速度，我看怎么是全局的会话速度？」、
 * 「官方的那个轮次胶囊就是显示当前会话任务的信息，这个实时输出速度希望也是显式
 * 当前会话的输出信息，因为每个会话使用的模型可能不一样，所以不能全局统计」。
 *
 * 旧实现注册了一个 `uiConversation.events` 的 Definition，把每帧流式文本推给一个
 * **模块级**速度计。而宿主的 Definition 注册表是**全局**的、每个会话各自有一个装配器
 * 把这些 Definition 拿去匹配自己那份事件流 —— 于是所有会话（包括同时跑的子代理）
 * 的字都被加进同两个累加器，读数自然成了「全局速度」。
 *
 * `assistant/live-chunk` 的载荷里没有会话 id，从事件回调分不出来。所以数据源换成
 * **槽位属性里的会话快照**：`conversation.composer.dock` 是 `scope: "session"` 的槽位，
 * 它的使用者拿到的 `useChat` 是**这个会话**的聊天快照。官方那两个胶囊正是这么读的。
 *
 * ## 一份状态管一个会话，靠 sessionId 认领
 *
 * 每份状态自带一个 `sessionKey`：槽位组件第一次渲染时用 `sessionId` 认领一份，
 * 之后每拍只读自己那份。切换会话 = 槽位重新渲染并认领另一份 —— **旧的那份不会
 * 被搬过去**，所以切会话不会把上一个会话的曲线带过来（也不会把它们加起来）。
 *
 * ## 为什么仍然要「摊开」
 *
 * 快照按宿主自己的节奏发布（动画帧级）。正常流式一格 ≈ 16ms，没问题；但主线程被
 * 占住（后台标签页、渲染大表格）时会几秒不发布，回前台时**几秒的字一次性**出现在
 * 增量里。不摊开的话那几秒会被记在同一毫秒上，最近 1 秒的窗口全吃进去 → 读数冲到
 * 上千。`spread.ts` 把这一拍的字符按两次采样之间的真实时间差摊开。
 *
 * @module dsh-token-tps-stats/src/client/session-store
 */

import { newTextSince, streamKeyOf, type ProgressBaseline } from "./progress";
import { spreadCounts } from "./spread";
import { countChars, createTpsMeter, type TpsMeter } from "./tps-meter";
import { createTpsHistory, type TpsHistory } from "./tps-history";

/** 一份会话状态。 */
export interface SessionStream {
  /** 归属的会话 id（`undefined` = 还没认领，例如会话列表页）。 */
  sessionKey: string | undefined;
  /** 这个会话的速度计（9 秒窗口 + 3 秒低通）。 */
  readonly meter: TpsMeter;
  /** 这个会话的折线图历史（最多 3 分钟）。 */
  readonly history: TpsHistory;
  /** 上一次采样留下的差分基线。 */
  baseline: ProgressBaseline | undefined;
  /** 上一次采样的时刻（摊开的时间区间起点）。 */
  sampledAt: number;
}

/** 所有会话的状态（key = sessionId）。 */
const streams = new Map<string, SessionStream>();

/** state 还没认领会话时的占位 key。 */
const UNCLAIMED = "\u0000unclaimed";

/** 认领状态（槽位组件挂载时调用）。 */
function entryFor(key: string): SessionStream {
  let entry = streams.get(key);
  if (entry === undefined) {
    entry = {
      sessionKey: key === UNCLAIMED ? undefined : key,
      meter: createTpsMeter(),
      history: createTpsHistory(),
      baseline: undefined,
      sampledAt: 0,
    };
    streams.set(key, entry);
  }
  return entry;
}

/**
 * 认领某个会话的状态。
 * @param sessionKey - 会话 id；列表页/没绑定时传 `undefined`。
 * @returns 那一份状态（同一个 id 永远拿到同一份）。
 */
export function claimSessionStream(sessionKey: string | undefined): SessionStream {
  return entryFor(sessionKey ?? UNCLAIMED);
}

/**
 * 吃一拍会话快照（**只读当前会话**的那一份）。
 *
 * @param entry - 认领到的状态。
 * @param partial - `legacy.partial`（`{ turn, step, blocks }`）；null/undefined 表示这一步不在跑。
 * @param at - 这一拍的本地时刻（毫秒）。
 * @returns 这一拍是否记进了字符。
 */
export function pushSnapshot(entry: SessionStream, partial: unknown, at: number): boolean {
  const shape = partial as { turn?: unknown; step?: unknown; blocks?: unknown } | null | undefined;
  /*
   * **没有在跑的步**：只清基线，不产字符。
   *
   * 基线必须清掉：下一次 `partial` 出现时若是同一 turn/step（重试），
   * 用旧基线做差分会把已经累计的整段文本算成「新到的字」。
   */
  if (shape === null || shape === undefined) {
    entry.baseline = undefined;
    entry.sampledAt = at;
    return false;
  }
  const stream = streamKeyOf(shape.turn, shape.step);
  const previousAt = entry.sampledAt;
  const { pieces, baseline } = newTextSince(entry.baseline, shape.blocks, stream);
  entry.baseline = baseline;
  entry.sampledAt = at;
  if (pieces.length === 0) return false;
  let cjk = 0;
  let other = 0;
  for (const piece of pieces) {
    const counts = countChars(piece);
    cjk += counts.cjk;
    other += counts.other;
  }
  if (cjk + other <= 0) return false;
  // 这一拍的字符按「上一次采样 → 这一次采样」摊开，避免积压时读数冲顶。
  const slices = spreadCounts({ cjk, other }, previousAt, at);
  for (const slice of slices) {
    entry.meter.pushCounts(slice, slice.at);
    entry.history.pushCounts(slice, slice.at);
  }
  return true;
}

/**
 * 读当前显示速度。
 * @param entry - 认领到的状态。
 * @param at - 现在（毫秒）。
 * @returns 非负 tok/s（归零时就是 0）。
 */
export function readingOf(entry: SessionStream, at: number): number {
  const reading = entry.meter.reading(at);
  return typeof reading === "number" && Number.isFinite(reading) && reading > 0 ? reading : 0;
}

/**
 * 释放某个会话的状态（槽位组件卸载时调用）。
 *
 * 只从表里移除；那份状态本身没有定时器、没有全局回调，被移除后就被 GC 回收。
 * @param entry - 那份状态。
 */
export function releaseSessionStream(entry: SessionStream): void {
  for (const [key, candidate] of streams) {
    if (candidate === entry) streams.delete(key);
  }
}

/** **仅供测试**：清掉所有会话状态。 */
export function resetSessionStreamsForTests(): void {
  streams.clear();
}
