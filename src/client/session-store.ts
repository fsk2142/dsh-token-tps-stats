/** Per-capsule state, scoped to the current DSH session. */
import { newTextSince, streamKeyOf, type ProgressBaseline } from "./progress";
import { observeOutputEvents, type SessionEventSource } from "./session-events";
import { createStepHistory, type StepHistory } from "./step-history";
import { createTpsHistory, TPS_SAMPLE_MS, type TpsHistory } from "./tps-history";
import { countChars, createTpsMeter, tokensOf, type TpsMeter } from "./tps-meter";

/**
 * live 通道「还算活着」的宽限（毫秒）。
 *
 * 真实会话里流式帧的间隔中位数是 0ms、95 分位 287ms、99 分位 702ms（296 秒 /
 * 8439 帧的实测）。所以「1.2 秒没收到任何 live 事件」已经远超出正常节奏 ——
 * 要么流真的停了，要么这条通道根本没在工作。两种情况都该让快照接管。
 */
const LIVE_GRACE_MS = 1_200;

export interface SessionStream {
  readonly sessionKey: string | undefined;
  readonly meter: TpsMeter;
  readonly history: TpsHistory;
  readonly steps: StepHistory;
  baseline?: ProgressBaseline;
  sampledAt?: number;
  lastStep?: string;
  runningTokens?: number;
  /** live 订阅是否已建立（只用于「页面隐藏时要不要推快照」这类判断）。 */
  liveEvents: boolean;
  /**
   * 最近一次收到 live 事件的本地时刻（`Date.now()`）；`undefined` = 还没收到过。
   *
   * **这是「live 到底有没有在工作」的唯一判据**：订阅成功但一个事件都不来，
   * 或中途断流，都靠它把控制权交回快照通道（见 {@link pushSnapshot}）。
   */
  lastLiveAt?: number;
  wake?: () => void;
}

export function createSessionStream(sessionKey: string | undefined): SessionStream {
  return { sessionKey, meter: createTpsMeter(), history: createTpsHistory(), steps: createStepHistory(), liveEvents: false };
}

/**
 * live 通道此刻是否在正常供数。
 * @param entry - 会话状态。
 * @param at - 现在（本地墙钟毫秒）。
 * @returns `true` = 最近 {@link LIVE_GRACE_MS} 内收到过 live 事件。
 */
export function liveChannelHealthy(entry: SessionStream, at: number): boolean {
  return entry.lastLiveAt !== undefined && at - entry.lastLiveAt < LIVE_GRACE_MS;
}

/** Refresh while either filter stage is active. The chart records the very same readings. */
export function observeSessionSpeed(
  entry: SessionStream,
  source: SessionEventSource | undefined,
  onReading: (value: number) => void,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  const tick = (): void => {
    const at = Date.now();
    const value = entry.meter.reading(at);
    entry.history.record(at, value);
    onReading(value);
    if (!entry.meter.active(at)) stopTimer();
  };
  entry.wake = () => {
    if (timer === undefined) timer = setInterval(tick, TPS_SAMPLE_MS);
  };

  if (source !== undefined) {
    try {
      unsubscribe = observeOutputEvents(source, (tokens, at, receivedAt) => {
        /*
         * 记「live 还活着」必须在**推数据之前**：`receivedAt` 是本地墙钟，
         * 而 `push` 里用的是宿主 `event.time`，两者不能混。
         */
        entry.lastLiveAt = receivedAt;
        if (entry.meter.push(tokens, at, receivedAt)) entry.wake?.();
      });
      entry.liveEvents = true;
    } catch (error: unknown) {
      console.debug("[dsh-token-tps-stats] live events unavailable, using chat snapshots", error);
    }
  }
  if (entry.meter.active(Date.now())) entry.wake();
  return () => {
    unsubscribe?.();
    entry.liveEvents = false;
    entry.lastLiveAt = undefined;
    entry.wake = undefined;
    stopTimer();
  };
}

/** A hidden view may return with an accumulated snapshot of unknown age. */
export function resetSnapshotBaseline(entry: SessionStream): void {
  entry.baseline = undefined;
  entry.sampledAt = undefined;
  entry.lastStep = undefined;
  entry.runningTokens = undefined;
}

function estimateTokens(pieces: readonly (string | undefined)[]): number {
  return pieces.reduce((total, piece) => piece ? total + tokensOf(countChars(piece)) : total, 0);
}

/** Estimate the whole running row, and use only new text for live TPS on older hosts. */
export function pushSnapshot(entry: SessionStream, partial: unknown, at: number): boolean {
  const shape = partial as { turn?: unknown; step?: unknown; blocks?: unknown } | null | undefined;
  const previousAt = entry.sampledAt;
  const previous = entry.baseline;
  entry.sampledAt = at;

  if (typeof shape?.turn !== "number" || typeof shape.step !== "number") {
    entry.baseline = undefined;
    entry.runningTokens = undefined;
    entry.steps.clearRunning();
    return false;
  }

  const stream = streamKeyOf(shape.turn, shape.step);
  // Only a known boundary makes the first visible text new. A reappearing retry may carry old text.
  const freshStep = previousAt !== undefined && entry.lastStep !== stream;
  const { pieces, baseline, appendOnly } = newTextSince(previous, shape.blocks, stream, freshStep);
  entry.baseline = baseline;
  entry.lastStep = stream;
  const tokens = estimateTokens(pieces);
  entry.runningTokens = appendOnly
    ? (entry.runningTokens ?? 0) + tokens
    : freshStep ? tokens : estimateTokens(baseline.texts);
  entry.steps.setRunning(shape.turn, shape.step, entry.runningTokens);
  if (tokens <= 0) return false;

  const sameStep = previousAt !== undefined && previous?.stream === stream;
  /*
   * **快照只在 live 不供数时才推**（2026-11-13 修）。
   *
   * 原来的判据是 `!entry.liveEvents` —— 订阅成功就永久禁用快照。问题在于
   * 「订阅成功」和「真的有事件」是两件事：宿主若用 `addedTime` 之类的参数把它
   * 置空、或时机错过，live 一个事件都不来，而快照又被永久禁用 → 胶囊永远 0，
   * 而「每步平均」照常有数（用户报过的现象）。
   *
   * 现在改用 {@link liveChannelHealthy}：只有**最近 1.2 秒内真的收到过 live 事件**
   * 才让位；否则快照照推。两者不会重复计数 —— live 在供数时快照被跳过，
   * live 停供后快照接管。
   */
  if (!liveChannelHealthy(entry, at) && entry.meter.push(tokens, at, at, sameStep ? previousAt : at)) entry.wake?.();
  return true;
}

/** Reuse DSH's immutable snapshot. The table parses it only when read. */
export function pushNodes(entry: SessionStream, nodes: unknown): void {
  if (Array.isArray(nodes)) entry.steps.setCompleted(nodes);
}
