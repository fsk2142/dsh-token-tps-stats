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
import { createStepHistory, type StepHistory } from "./step-history";
import { countChars, createTpsMeter, tokensOf, type TpsMeter } from "./tps-meter";
import { createTpsHistory, type TpsHistory } from "./tps-history";

/** 一份会话状态。 */
export interface SessionStream {
  /** 归属的会话 id（`undefined` = 还没认领，例如会话列表页）。 */
  sessionKey: string | undefined;
  /** 这个会话的速度计（9 秒窗口 + 3 秒低通）。 */
  readonly meter: TpsMeter;
  /** 这个会话的折线图历史（最多 3 分钟）。 */
  readonly history: TpsHistory;
  /** 这个会话**每一步**的平均速度（弹窗右上角那块用它）。 */
  readonly steps: StepHistory;
  /** 上一次采样留下的差分基线。 */
  baseline: ProgressBaseline | undefined;
  /** 上一次采样的时刻（摊开的时间区间起点）。 */
  sampledAt: number;
  /**
   * 上一次处理过的 `legacy.nodes` 引用（**不是拷贝**）。
   *
   * 只用来判断「这批消息没变」：同一引用就整段跳过，见 `pushNodes` 的说明。
   */
  nodesSeen: unknown;
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
      steps: createStepHistory(),
      baseline: undefined,
      sampledAt: 0,
      nodesSeen: undefined,
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
  /*
   * 记一次**这一步**的交付：字符 → token，间隔按「上一次采样 → 这一次采样」计。
   *
   * 间隔取**原始时间差**（不像折线那样摊开）：步统计量的是「有字在流的时长」，
   * 摊开的切片会把同一次交付拆成好多段短间隔，加起来反而失真。
   */
  entry.steps.add(
    stream,
    shape.turn as number,
    shape.step as number,
    tokensOf({ cjk, other }),
    at - previousAt,
  );
  // 这一拍的字符按「上一次采样 → 这一次采样」摊开，避免积压时读数冲顶。
  const slices = spreadCounts({ cjk, other }, previousAt, at);
  for (const slice of slices) {
    entry.meter.pushCounts(slice, slice.at);
    entry.history.pushCounts(slice, slice.at);
  }
  return true;
}

/**
 * 吃一拍**已经结束的**助手节点，把它们的真实 `usage` 记进步统计。
 *
 * 为什么单独一个入口：`legacy.nodes`（已完成的消息）与 `legacy.partial`（正在生成的
 * 那一步）是两份数据。前者带 `usage`（真实 token 账单），后者只有累计文本。
 * 列表里的「输入 / 输出 / 命中」只能来自前者 —— 估算值在那一列没有意义。
 *
 * 幂等：宿主每帧都给新的数组，但同一步的 `usage` 不会变，`settle` 只更新不多加行。
 * @param entry - 认领到的状态。
 * @param nodes - `legacy.nodes`。
 */
export function pushNodes(entry: SessionStream, nodes: unknown): void {
  if (!Array.isArray(nodes)) return;
  /*
   * **引用没变就整段跳过**（2026-11-13 加）。
   *
   * 宿主对「内容没变」的 `legacy.nodes` 返回**同一个数组引用**（内部有
   * `sameReferences` 判断，见 `dsh-client-ui-chat` 的 `rebuildFinalized`）。
   * 而我们的 effect 每来一帧快照就会跑一次；会话越长 `nodes` 越长，逐条扫一遍
   * 是 O(消息数) 的纯浪费。同一引用必然对应同一批用量，跳过是安全的。
   */
  if (entry.nodesSeen === nodes) return;
  entry.nodesSeen = nodes;
  for (const node of nodes as readonly unknown[]) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as { kind?: unknown; turn?: unknown; step?: unknown; usage?: unknown; timing?: unknown };
    if (record.kind !== "assistant") continue;
    if (typeof record.turn !== "number" || typeof record.step !== "number") continue;
    const usage = record.usage as { [key: string]: unknown } | null | undefined;
    if (typeof usage !== "object" || usage === null) continue;
    entry.steps.settle(record.turn, record.step, {
      inputTokens: countOf(usage.inputTokens),
      outputTokens: countOf(usage.outputTokens),
      cacheReadTokens: countOf(usage.cacheReadTokens),
      cacheWriteTokens: countOf(usage.cacheWriteTokens),
      reasoningTokens: countOf(usage.reasoningTokens),
      totalTokens: countOf(usage.totalTokens),
      generationMs: generationMsOf(record.timing),
    });
  }
}

/**
 * 从宿主节点的 `timing` 折出「这一步真正在生成」的时长。
 *
 * 宿主给三个墙钟时刻：`stepStartTime`（步开始）、`firstTokenTime`（第一个 token
 * 到达）、`completedTime`（生成结束）。**事件顺序决定了这三个里哪两段是「在生成」**：
 *
 * ```
 * step/start → assistant/message → tool/call → tool/result → step/end
 * ```
 *
 * 工具是在 `assistant/message` **之后**才执行的，所以「等工具返回」落在
 * message → step/end 之间，**不在**我们要的那一段里。于是：
 *
 * 1. `completedTime − firstTokenTime` —— 有首 token 时刻时，这是最贴的「吐字时长」；
 * 2. 没有首 token 时刻（`firstTokenTime` 为 `null`：这一步的增量里没有可识别的
 *    token delta，例如一次性吐出的工具参数）时，退回
 *    `completedTime − stepStartTime`。**这仍然是纯生成时间** —— 工具还没开始跑。
 *
 * 早先只实现了第 1 条，于是这些步在结束后读数是 `—`。用户在真机上正好看到
 * 「速度在步数结束后就消失了」，说的就是这批行。
 * @param timing - 宿主节点上的 `timing`。
 * @returns 毫秒；字段缺失或倒挂时 `undefined`。
 */
function generationMsOf(timing: unknown): number | undefined {
  if (typeof timing !== "object" || timing === null) return undefined;
  const record = timing as { stepStartTime?: unknown; firstTokenTime?: unknown; completedTime?: unknown };
  const done = countOf(record.completedTime);
  if (done === undefined) return undefined;
  const first = countOf(record.firstTokenTime);
  if (first !== undefined && done - first > 0) return done - first;
  const start = countOf(record.stepStartTime);
  if (start !== undefined && done - start > 0) return done - start;
  return undefined;
}

/**
 * 取一个非负整数（宿主的用量字段都是这种）；其它值当作「没有」。
 * @param value - 原始值。
 * @returns 非负整数或 `undefined`。
 */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
