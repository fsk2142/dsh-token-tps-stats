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

/** Consume only new live appends. Initial history, reconnect snapshots and settlements can repeat chunks. */
export function observeOutputEvents(
  source: SessionEventSource,
  onTokens: (tokens: number, at: number, receivedAt: number) => void,
): () => void {
  let revision = source.getSnapshot().revision;
  if (!Number.isSafeInteger(revision)) throw new TypeError("Unsupported DSH event source");
  return source.subscribe(() => {
    const { revision: next, change } = source.getSnapshot();
    const consecutive = next === revision + 1;
    revision = next;
    if (!consecutive || change?.kind !== "append" || !Array.isArray(change.entries)) return;
    const receivedAt = Date.now();
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
      const at = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : receivedAt;
      onTokens(tokensOf(countChars(chunk.text)), at, receivedAt);
    }
  });
}
