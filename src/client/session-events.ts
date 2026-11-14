import { countChars, tokensOf } from "./tps-meter";

export interface SessionEventSource {
  getSnapshot(): {
    readonly revision: number;
    readonly change: { readonly kind: string; readonly entries?: readonly unknown[] };
  };
  subscribe(listener: () => void): () => void;
}

export type SessionEventSourceFor = (sessionId: string) => SessionEventSource | undefined;

/** Borrow the feed already opened for this session by DSH. */
export function sessionEventSourceOf(service: unknown, sessionId: string): SessionEventSource | undefined {
  const sessions = service as { binding?(id: string): { eventSource?: SessionEventSource } } | undefined;
  const source = sessions?.binding?.(sessionId)?.eventSource;
  return typeof source?.getSnapshot === "function" && typeof source.subscribe === "function" ? source : undefined;
}

/**
 * 一批增量（**一个回调里的所有 chunk 合并成一次**）。
 *
 * ## 为什么必须合并（2026-11-14 用户报「出现了一个异常峰值」，3925 tok/s）
 *
 * 订阅回调一次可能带来**几百个** chunk：宿主重新订阅、重新基线、页面从后台回来时
 * 会把已累计的整段文本重新 append 一遍。原来的实现是**逐 chunk** 调 `onTokens`，
 * 而 `tps-meter` 的 `push` 在 `from` 缺省时等于 `at` —— 于是每一片都走「点冲激」
 * 分支（`first += tokens/τ`），同一回调里又没有时间流逝，
 * 几百个冲激直接叠加 → 读数冲到几千。
 *
 * 合并之后，这一批 token 带着**真实的起止时间**进入积分分支：
 * `rate = 总 token / (末片时间 - 首片时间)`，于是「重放一段旧文本」只会得到
 * 那段文本的真实速率，而不是无穷大。
 */
export interface OutputBatch {
  /** 这一批合并后的 token 数。 */
  readonly tokens: number;
  /** 首片的源时间（区间起点）。 */
  readonly from: number;
  /** 末片的源时间（区间终点）。 */
  readonly at: number;
}

/** Consume only new live appends. Initial history, reconnect snapshots and settlements can repeat chunks. */
export function observeOutputEvents(
  source: SessionEventSource,
  onBatch: (batch: OutputBatch, receivedAt: number) => void,
): () => void {
  let revision = source.getSnapshot().revision;
  if (!Number.isSafeInteger(revision)) throw new TypeError("Unsupported DSH event source");
  return source.subscribe(() => {
    const { revision: next, change } = source.getSnapshot();
    const consecutive = next === revision + 1;
    revision = next;
    if (!consecutive || change?.kind !== "append" || !Array.isArray(change.entries)) return;
    const receivedAt = Date.now();
    let tokens = 0;
    let from: number | undefined;
    let at: number | undefined;
    for (const raw of change.entries) {
      const entry = raw as {
        type?: unknown;
        event?: { type?: unknown; time?: unknown; data?: { chunk?: { type?: unknown; text?: unknown } } };
      } | null;
      const event = entry?.event;
      if (entry?.type !== "transient" || event?.type !== "assistant/live-chunk") continue;
      const chunk = event.data?.chunk;
      if (chunk?.type !== "text-delta" && chunk?.type !== "reasoning-delta") continue;
      if (typeof chunk.text !== "string" || chunk.text === "") continue;
      const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined;
      tokens += tokensOf(countChars(chunk.text));
      if (time === undefined) continue;
      if (from === undefined || time < from) from = time;
      if (at === undefined || time > at) at = time;
    }
    if (tokens <= 0) return;
    onBatch({ tokens, from: from ?? receivedAt, at: at ?? receivedAt }, receivedAt);
  });
}
