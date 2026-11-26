/** 当前轮次的明细聚合：只读宿主 nodes 与运行中步骤，不碰 React。 */

export interface RunningStepRef {
  readonly turn: number;
  readonly step: number;
}

export interface TurnDetailsInput {
  readonly nodes: readonly unknown[];
  readonly running?: RunningStepRef;
  readonly runningTokens: number;
  readonly liveSpeed: number;
  readonly now: number;
}

export interface TurnDetails {
  readonly turn: number;
  readonly steps: number;
  readonly running: boolean;
  readonly totalMs?: number;
  readonly ttftMs?: number;
  readonly generationMs?: number;
  readonly outputTokens?: number;
  readonly streamSpeed?: number;
  readonly endToEndSpeed?: number;
  readonly cacheHitRatio?: number;
  readonly reasoningRatio?: number;
}

interface StepFacts {
  readonly turn: number;
  readonly step: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly inputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly stepStartTime?: number;
  readonly firstTokenTime?: number;
  readonly completedTime?: number;
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function factsOf(raw: unknown): StepFacts | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const node = raw as {
    kind?: unknown;
    turn?: unknown;
    step?: unknown;
    usage?: unknown;
    timing?: unknown;
  };
  if (node.kind !== "assistant") return undefined;
  const turn = countOf(node.turn);
  const step = countOf(node.step);
  if (turn === undefined || step === undefined) return undefined;
  const usage = typeof node.usage === "object" && node.usage !== null
    ? node.usage as Record<string, unknown>
    : undefined;
  const timing = typeof node.timing === "object" && node.timing !== null
    ? node.timing as Record<string, unknown>
    : undefined;
  return {
    turn,
    step,
    outputTokens: countOf(usage?.outputTokens),
    reasoningTokens: countOf(usage?.reasoningTokens),
    cacheReadTokens: countOf(usage?.cacheReadTokens),
    inputTokens: countOf(usage?.inputTokens),
    cacheWriteTokens: countOf(usage?.cacheWriteTokens),
    totalTokens: countOf(usage?.totalTokens),
    stepStartTime: countOf(timing?.stepStartTime),
    firstTokenTime: countOf(timing?.firstTokenTime),
    completedTime: countOf(timing?.completedTime),
  };
}

function cacheRatioOf(steps: readonly StepFacts[]): number | undefined {
  let cached = 0;
  let prompt = 0;
  let found = false;
  for (const step of steps) {
    const { cacheReadTokens, inputTokens, cacheWriteTokens, totalTokens, outputTokens } = step;
    if (cacheReadTokens === undefined) continue;
    const known = cacheReadTokens + (inputTokens ?? 0) + (cacheWriteTokens ?? 0);
    const promptTokens = totalTokens !== undefined && outputTokens !== undefined
      ? totalTokens - outputTokens
      : inputTokens === undefined ? undefined : known;
    if (promptTokens === undefined || promptTokens <= 0 || promptTokens < known) continue;
    if (inputTokens !== undefined && cacheWriteTokens !== undefined && promptTokens !== known) continue;
    cached += cacheReadTokens;
    prompt += promptTokens;
    found = true;
  }
  return found ? cached / prompt : undefined;
}

function reasoningRatioOf(steps: readonly StepFacts[]): number | undefined {
  let reasoning = 0;
  let output = 0;
  let found = false;
  for (const step of steps) {
    if (step.reasoningTokens === undefined || step.outputTokens === undefined || step.outputTokens <= 0) continue;
    reasoning += step.reasoningTokens;
    output += step.outputTokens;
    found = true;
  }
  return found ? reasoning / output : undefined;
}

/**
 * 汇总当前轮次。
 *
 * 当前轮次取运行中 turn 与已结算 assistant 节点最大 turn 的较大者；同一步骤
 * 以后出现的节点为准。分页缺头（最小 step > 1）或最早步骤缺开始时间时，
 * 总耗时与端到端速度保持未知，避免用不完整区间硬算。
 */
export function turnDetailsOf(input: TurnDetailsInput): TurnDetails | undefined {
  const byStep = new Map<number, StepFacts>();
  let latestTurn = 0;
  let hasNode = false;
  for (const raw of input.nodes) {
    const facts = factsOf(raw);
    if (facts === undefined) continue;
    hasNode = true;
    latestTurn = Math.max(latestTurn, facts.turn);
    if (facts.turn >= latestTurn) byStep.set(facts.step, facts);
  }

  const runningTurn = countOf(input.running?.turn);
  const runningStep = countOf(input.running?.step);
  const turn = Math.max(latestTurn, runningTurn ?? 0);
  if (!hasNode && runningTurn === undefined) return undefined;

  // 只保留当前轮次；上面按 step 去重的 Map 可能含有旧轮次，先过滤。
  const steps = [...byStep.values()].filter((step) => step.turn === turn).sort((a, b) => a.step - b.step);
  const maxStep = steps.at(-1)?.step ?? 0;
  const unsettled = runningTurn === turn && runningStep !== undefined && runningStep > maxStep;
  const observedMin = steps[0]?.step ?? (unsettled ? runningStep! : 0);
  const earliest = steps.find((step) => step.step === observedMin);
  const latest = steps.at(-1);

  const completeOutput = steps.every((step) => step.outputTokens !== undefined);
  const settledOutput = completeOutput
    ? steps.reduce((total, step) => total + step.outputTokens!, 0)
    : undefined;
  const runningEstimate = unsettled && Number.isFinite(input.runningTokens) && input.runningTokens >= 0
    ? input.runningTokens
    : unsettled ? undefined : 0;
  const outputTokens = settledOutput === undefined || runningEstimate === undefined
    ? undefined
    : settledOutput + runningEstimate;

  const start = earliest?.stepStartTime;
  const end = unsettled ? input.now : latest?.completedTime;
  const totalMs = observedMin === 1 && start !== undefined && Number.isFinite(end) && end! > start
    ? end! - start
    : undefined;

  let ttftMs: number | undefined;
  for (const step of steps) {
    if (step.stepStartTime === undefined || step.firstTokenTime === undefined) continue;
    if (step.firstTokenTime < step.stepStartTime) continue;
    ttftMs = step.firstTokenTime - step.stepStartTime;
    break;
  }

  const producing = steps.filter((step) => (step.outputTokens ?? 0) > 0);
  const generationComplete = producing.length > 0 && producing.every((step) =>
    step.stepStartTime !== undefined &&
    step.firstTokenTime !== undefined &&
    step.completedTime !== undefined &&
    step.completedTime > step.firstTokenTime &&
    step.firstTokenTime >= step.stepStartTime,
  );
  const generationMs = generationComplete
    ? producing.reduce((total, step) => total + step.completedTime! - step.firstTokenTime!, 0)
    : undefined;

  const streamSpeed = unsettled
    ? Number.isFinite(input.liveSpeed) && input.liveSpeed >= 0 ? input.liveSpeed : undefined
    : outputTokens !== undefined && generationMs !== undefined && generationMs > 0
      ? outputTokens / (generationMs / 1_000)
      : undefined;
  const endToEndSpeed = outputTokens !== undefined && totalMs !== undefined && totalMs > 0
    ? outputTokens / (totalMs / 1_000)
    : undefined;

  return {
    turn,
    steps: steps.length + (unsettled ? 1 : 0),
    running: unsettled,
    totalMs,
    ttftMs,
    generationMs,
    outputTokens,
    streamSpeed,
    endToEndSpeed,
    cacheHitRatio: cacheRatioOf(steps),
    reasoningRatio: reasoningRatioOf(steps),
  };
}
