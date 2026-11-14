/** Per-step usage and average output rate, newest step first. */
export const TPS_STEP_RANGES = [5, 10, 20] as const;
export type TpsStepRange = (typeof TPS_STEP_RANGES)[number];
export const TPS_STEP_DEFAULT = 5;

const MAX_STEPS = 40;

export interface StepUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  /** Host time from step start to assistant message completion, before tool execution. */
  readonly modelMs?: number;
}

export interface StepRow {
  readonly turn: number;
  readonly step: number;
  readonly cacheReadTokens: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly hitRatio: number | undefined;
  readonly speed: number | undefined;
  readonly measured: boolean;
  readonly running: boolean;
}

export interface StepHistory {
  setRunning(turn: number, step: number, tokens: number): void;
  clearRunning(): void;
  setCompleted(nodes: readonly unknown[]): void;
  subscribe(listener: () => void): () => void;
  rows(count: number): StepRow[];
}

type StepId = Pick<StepRow, "turn" | "step">;

function newestFirst(a: StepId, b: StepId): number {
  return b.turn - a.turn || b.step - a.step;
}

function cacheHitRatio(usage: StepUsage): number | undefined {
  const { cacheReadTokens, inputTokens, cacheWriteTokens, totalTokens, outputTokens } = usage;
  if (cacheReadTokens === undefined) return undefined;
  const known = cacheReadTokens + (inputTokens ?? 0) + (cacheWriteTokens ?? 0);
  // DSH's total includes all input buckets and the reported output.
  const promptTokens = totalTokens !== undefined && outputTokens !== undefined
    ? totalTokens - outputTokens
    : inputTokens === undefined ? undefined : known;
  if (promptTokens === undefined || promptTokens <= 0 || promptTokens < known) return undefined;
  if (inputTokens !== undefined && cacheWriteTokens !== undefined && promptTokens !== known) return undefined;
  return cacheReadTokens / promptTokens;
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageOf(raw: unknown, timing: unknown): StepUsage | undefined {
  const times = timing as { stepStartTime?: unknown; completedTime?: unknown } | null | undefined;
  const start = countOf(times?.stepStartTime);
  const done = countOf(times?.completedTime);
  const modelMs = start !== undefined && done !== undefined && done > start ? done - start : undefined;
  const usage = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;
  if (usage === undefined && modelMs === undefined) return undefined;
  return {
    inputTokens: countOf(usage?.inputTokens),
    outputTokens: countOf(usage?.outputTokens),
    cacheReadTokens: countOf(usage?.cacheReadTokens),
    cacheWriteTokens: countOf(usage?.cacheWriteTokens),
    totalTokens: countOf(usage?.totalTokens),
    modelMs,
  };
}

export function createStepHistory(): StepHistory {
  const completed: StepRow[] = [];
  const listeners = new Set<() => void>();
  let source: readonly unknown[] | undefined;
  let materialized = true;
  let running: { turn: number; step: number; tokens: number } | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const insert = (id: StepId, usage: StepUsage, position: number): void => {
    const { cacheReadTokens, inputTokens, outputTokens, modelMs } = usage;
    const row: StepRow = {
      ...id, cacheReadTokens, inputTokens, outputTokens,
      hitRatio: cacheHitRatio(usage),
      speed: outputTokens !== undefined && modelMs !== undefined && Number.isFinite(modelMs) && modelMs > 0
        ? outputTokens / (modelMs / 1_000)
        : undefined,
      measured: outputTokens !== undefined,
      running: false,
    };

    if (position === -1) completed.push(row);
    else completed.splice(position, newestFirst(completed[position]!, row) === 0 ? 1 : 0, row);
    if (completed.length > MAX_STEPS) completed.pop();
  };

  const refreshCompleted = (): void => {
    if (materialized || source === undefined) return;
    materialized = true;
    completed.length = 0;
    // DSH supplies ascending event order. Keep the logical step order even for revised or reordered snapshots.
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const node = source[i] as {
        kind?: unknown; turn?: unknown; step?: unknown; usage?: unknown; timing?: unknown;
      } | null;
      if (node?.kind !== "assistant") continue;
      const turn = countOf(node.turn);
      const step = countOf(node.step);
      if (turn === undefined || step === undefined) continue;
      const oldest = completed[MAX_STEPS - 1];
      if (oldest !== undefined && (turn < oldest.turn || (turn === oldest.turn && step <= oldest.step))) continue;
      const id = { turn, step };
      const position = completed.findIndex((row) => newestFirst(row, id) >= 0);
      // Scan newest first, so a duplicate with valid usage has already been added.
      if (position !== -1 && newestFirst(completed[position]!, id) === 0) continue;
      const usage = usageOf(node.usage, node.timing);
      if (usage !== undefined) {
        if (running?.turn === turn && running.step === step) running = undefined;
        insert(id, usage, position);
      }
    }
  };

  return {
    setRunning(turn, step, tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) {
        if (running === undefined) return;
        running = undefined;
      } else {
        if (running?.turn === turn && running.step === step && Math.round(running.tokens) === Math.round(tokens)) return;
        running = { turn, step, tokens };
      }
      notify();
    },
    clearRunning() {
      if (running === undefined) return;
      running = undefined;
      notify();
    },
    setCompleted(nodes) {
      if (source === nodes) return;
      source = nodes;
      materialized = false;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    rows(count) {
      refreshCompleted();
      const limit = Math.min(MAX_STEPS, Math.max(1, Math.floor(count)));
      const rows = completed.slice(0, limit);
      const draft = running;
      if (draft !== undefined && !completed.some((row) => newestFirst(row, draft) === 0)) {
        rows.push({
          turn: draft.turn, step: draft.step, outputTokens: draft.tokens,
          cacheReadTokens: undefined, inputTokens: undefined, hitRatio: undefined, speed: undefined,
          measured: false, running: true,
        });
        rows.sort(newestFirst);
      }
      return rows.slice(0, limit);
    },
  };
}

export const STEP_HISTORY_CONSTANTS = { maxSteps: MAX_STEPS } as const;
