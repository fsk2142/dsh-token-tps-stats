import { describe, expect, it } from "vitest";

import { turnDetailsOf } from "../../src/client/turn-details";

/** 造一个宿主助手节点。 */
function node(
  turn: number,
  step: number,
  usage: Record<string, number> | undefined,
  timing: Record<string, number | null> | undefined,
): unknown {
  return { kind: "assistant", turn, step, usage, timing };
}

const first = node(
  61,
  1,
  { outputTokens: 600, reasoningTokens: 180, cacheReadTokens: 900, inputTokens: 100, totalTokens: 1_600 },
  { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 5_000 },
);
const second = node(
  61,
  2,
  { outputTokens: 400, reasoningTokens: 200, cacheReadTokens: 1_800, inputTokens: 200, totalTokens: 2_400 },
  { stepStartTime: 6_000, firstTokenTime: 7_000, completedTime: 9_000 },
);

describe("当前轮次明细：结算汇总", () => {
  it("多步汇总流式/端到端、TTFT/生成/总计、缓存与思维链比例", () => {
    expect(turnDetailsOf({ nodes: [first, second], now: 10_000, runningTokens: 0, liveSpeed: 0 })).toMatchObject({
      turn: 61,
      steps: 2,
      running: false,
      totalMs: 8_000,
      ttftMs: 1_000,
      generationMs: 5_000,
      outputTokens: 1_000,
      streamSpeed: 200,
      endToEndSpeed: 125,
      cacheHitRatio: 0.9,
      reasoningRatio: 0.38,
    });
  });

  it("忽略旧轮次；同一步骤重复时采用最新出现的节点", () => {
    const revised = node(
      61,
      1,
      { outputTokens: 700, reasoningTokens: 200, cacheReadTokens: 900, inputTokens: 100, totalTokens: 1_700 },
      { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 5_000 },
    );
    const details = turnDetailsOf({
      nodes: [node(60, 1, { outputTokens: 9_999 }, { stepStartTime: 0, firstTokenTime: 1, completedTime: 2 }), first, revised, second],
      now: 10_000,
      runningTokens: 0,
      liveSpeed: 0,
    });
    expect(details).toMatchObject({ turn: 61, steps: 2, outputTokens: 1_100, streamSpeed: 220, endToEndSpeed: 137.5 });
  });

  it("工具-only 零输出步骤计入步数与总耗时，但不污染生成耗时", () => {
    const toolOnly = node(
      61,
      3,
      { outputTokens: 0, cacheReadTokens: 100, inputTokens: 0, totalTokens: 100 },
      { stepStartTime: 10_000, firstTokenTime: null, completedTime: 11_000 },
    );
    const details = turnDetailsOf({ nodes: [first, second, toolOnly], now: 12_000, runningTokens: 0, liveSpeed: 0 });
    expect(details).toMatchObject({
      steps: 3,
      totalMs: 10_000,
      generationMs: 5_000,
      outputTokens: 1_000,
      streamSpeed: 200,
      endToEndSpeed: 100,
    });
  });

  it("观测到的最小步骤大于 1 时视为缺头：总计与端到端显示未知", () => {
    const details = turnDetailsOf({ nodes: [second], now: 10_000, runningTokens: 0, liveSpeed: 0 });
    expect(details).toMatchObject({ turn: 61, steps: 1, generationMs: 2_000, outputTokens: 400, streamSpeed: 200 });
    expect(details?.totalMs).toBeUndefined();
    expect(details?.endToEndSpeed).toBeUndefined();
  });

  it("最早步骤缺开始时间时，总计与端到端显示未知", () => {
    const noStart = node(61, 1, { outputTokens: 600 }, { firstTokenTime: 2_000, completedTime: 5_000 });
    const details = turnDetailsOf({ nodes: [noStart, second], now: 10_000, runningTokens: 0, liveSpeed: 0 });
    expect(details?.totalMs).toBeUndefined();
    expect(details?.endToEndSpeed).toBeUndefined();
  });

  it("有输出但缺首 token 时间时，生成耗时与结算流式速度显示未知", () => {
    const noFirst = node(61, 1, { outputTokens: 600 }, { stepStartTime: 1_000, firstTokenTime: null, completedTime: 5_000 });
    const details = turnDetailsOf({ nodes: [noFirst, second], now: 10_000, runningTokens: 0, liveSpeed: 0 });
    expect(details).toMatchObject({ totalMs: 8_000, outputTokens: 1_000, endToEndSpeed: 125 });
    expect(details?.generationMs).toBeUndefined();
    expect(details?.streamSpeed).toBeUndefined();
  });

  it("已结算步骤缺输出用量时，本轮输出与两个速度都显示未知", () => {
    const noUsage = node(61, 1, undefined, { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 5_000 });
    const details = turnDetailsOf({ nodes: [noUsage, second], now: 10_000, runningTokens: 0, liveSpeed: 0 });
    expect(details?.outputTokens).toBeUndefined();
    expect(details?.generationMs).toBeUndefined();
    expect(details?.streamSpeed).toBeUndefined();
    expect(details?.endToEndSpeed).toBeUndefined();
  });
});

describe("当前轮次明细：运行中", () => {
  it("运行中步骤加估算输出，流式取实时读数，总计取 now", () => {
    const details = turnDetailsOf({
      nodes: [first],
      running: { turn: 61, step: 2 },
      runningTokens: 250,
      liveSpeed: 239.2,
      now: 7_000,
    });
    expect(details).toMatchObject({
      turn: 61,
      steps: 2,
      running: true,
      totalMs: 6_000,
      outputTokens: 850,
      streamSpeed: 239.2,
      endToEndSpeed: 850 / 6,
    });
  });

  it("运行中步骤已有结算节点时忽略估算，不重复计步数或 token", () => {
    const details = turnDetailsOf({
      nodes: [first, second],
      running: { turn: 61, step: 2 },
      runningTokens: 999,
      liveSpeed: 999,
      now: 10_000,
    });
    expect(details).toMatchObject({ steps: 2, running: false, outputTokens: 1_000, streamSpeed: 200 });
  });

  it("新轮次只有运行中步骤时也能显示轮次与估算输出，但总计未知", () => {
    const details = turnDetailsOf({
      nodes: [first, second],
      running: { turn: 62, step: 1 },
      runningTokens: 80,
      liveSpeed: 120,
      now: 12_000,
    });
    expect(details).toMatchObject({ turn: 62, steps: 1, running: true, outputTokens: 80, streamSpeed: 120 });
    expect(details?.totalMs).toBeUndefined();
    expect(details?.endToEndSpeed).toBeUndefined();
  });
});

describe("当前轮次明细：缺失与非法输入", () => {
  it("没有有效助手节点或运行中步骤时返回 undefined", () => {
    expect(turnDetailsOf({ nodes: [null, {}, { kind: "tool", turn: 1, step: 1 }], now: 0, runningTokens: 0, liveSpeed: 0 })).toBeUndefined();
  });

  it("缓存率只汇总能确定提示总量的步骤；完全不可确定时显示未知", () => {
    const invalidCache = node(61, 1, { outputTokens: 10, cacheReadTokens: 100, totalTokens: 50 }, { stepStartTime: 1, firstTokenTime: 2, completedTime: 3 });
    const details = turnDetailsOf({ nodes: [invalidCache], now: 4, runningTokens: 0, liveSpeed: 0 });
    expect(details?.cacheHitRatio).toBeUndefined();
  });

  it("思维链比例只汇总字段齐全的步骤；完全不可确定时显示未知", () => {
    const noReasoning = node(61, 1, { outputTokens: 100 }, { stepStartTime: 1, firstTokenTime: 2, completedTime: 3 });
    const details = turnDetailsOf({ nodes: [noReasoning], now: 4, runningTokens: 0, liveSpeed: 0 });
    expect(details?.reasoningRatio).toBeUndefined();
  });
});
