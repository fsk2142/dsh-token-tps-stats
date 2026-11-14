/**
 * **每一步的账**的单测。
 *
 * ## 为什么用 `setCompleted` 而不是一个 `settle()` 入口
 *
 * 生产链路只有一条：胶囊把宿主的 `legacy.nodes` 交给 `setCompleted(nodes)`，
 * 表格在读的时候才解析（`refreshCompleted`）。所以这里也走同一条路 ——
 * 之前那个只是在测试里被调用的 `settle()` 已经删掉了，留下来只会让测试
 * 覆盖一条生产不存在的路径。
 *
 * 容易写歪的地方都钉在这里：
 *
 * 1. token 用量来自真实的 `usage`，不是估算；
 * 2. 已结算的输出和宿主模型耗时齐全时才显示速度；
 * 3. 流式估算只用于正在生成的输出列；
 * 4. 列表是**最新在前**，只取最近 N 步。
 *
 * @module dsh-token-tps-stats/tests/client/step-history
 */
import { describe, expect, it } from "vitest";

import { createStepHistory, STEP_HISTORY_CONSTANTS, TPS_STEP_RANGES, type StepHistory, type StepUsage } from "../../src/client/step-history";

/** 造一个节点用的基准时刻。 */
const T0 = 1_000_000;

/**
 * 把一个 `StepUsage` 折成宿主 `legacy.nodes` 里的助手节点形状。
 * @param turn - 轮次。
 * @param step - 步数。
 * @param usage - 用量。
 * @returns 助手节点。
 */
function nodeOf(turn: number, step: number, usage: StepUsage): unknown {
  const timing =
    usage.modelMs === undefined
      ? undefined
      : { stepStartTime: T0, completedTime: T0 + usage.modelMs };
  const payload: Record<string, unknown> = {
    kind: "assistant",
    turn,
    step,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
    },
  };
  if (timing !== undefined) payload.timing = timing;
  return payload;
}

/**
 * 造一个走生产链路的记账器：`settle` 只是「把这个节点加进宿主快照」的糖。
 * @returns 记账器。
 */
function ledger(): StepHistory & { settle(turn: number, step: number, usage: StepUsage): void } {
  const history = createStepHistory();
  const nodes: unknown[] = [];
  return {
    setRunning: (turn, step, tokens) => history.setRunning(turn, step, tokens),
    clearRunning: () => history.clearRunning(),
    setCompleted: (next) => history.setCompleted(next),
    subscribe: (listener) => history.subscribe(listener),
    rows: (count) => history.rows(count),
    settle(turn, step, usage) {
      nodes.push(nodeOf(turn, step, usage));
      // **传新数组**：`setCompleted` 用引用相等来判断「这份快照没变」，
      // 传同一个数组会被当成没变化而跳过解析。
      history.setCompleted([...nodes]);
    },
  };
}

describe("步账：真实用量优先", () => {
  it("表格订阅只在显示值变化时通知，取消后停止通知", () => {
    const history = ledger();
    let updates = 0;
    const stop = history.subscribe(() => {
      updates += 1;
    });
    history.setRunning(1, 1, 10);
    history.setRunning(1, 1, 10.2);
    history.setRunning(1, 1, 11);
    history.settle(1, 1, { outputTokens: 12 });
    expect(updates).toBe(3);
    stop();
    history.setRunning(1, 2, 5);
    expect(updates).toBe(3);
  });

  it("部分用量只有能确定输入总量时才显示命中率", () => {
    const history = ledger();
    history.settle(1, 1, { cacheReadTokens: 900, outputTokens: 50 });
    history.settle(1, 2, { cacheReadTokens: 900, outputTokens: 50, totalTokens: 1_050 });
    history.settle(1, 3, { cacheReadTokens: 900, outputTokens: 50, totalTokens: 900 });
    history.settle(1, 4, { cacheReadTokens: 900, inputTokens: 0 });
    history.settle(1, 5, { cacheReadTokens: 900, inputTokens: 0, cacheWriteTokens: 100 });
    expect(history.rows(5).map((row) => row.hitRatio)).toEqual([0.9, 1, undefined, 0.9, undefined]);
  });

  it("**有 usage 就显示真实数字**，而不是估算", () => {
    const history = ledger();
    history.setRunning(1, 1, 5);
    history.settle(1, 1, { inputTokens: 120, outputTokens: 300, cacheReadTokens: 900, totalTokens: 1_320 });
    const [row] = history.rows(5);
    expect(row?.outputTokens).toBe(300);
    expect(row?.inputTokens).toBe(120);
    expect(row?.cacheReadTokens).toBe(900);
    // 命中率 = 读取 ÷（读取 + 输入 + 写入）= 900 ÷ 1020。
    expect(row?.hitRatio).toBeCloseTo(900 / 1_020, 6);
    expect(row?.measured).toBe(true);
  });

  it("还没有 usage 时退回流式期间的估算（并标 `measured: false`）", () => {
    const history = ledger();
    history.setRunning(1, 1, 42);
    const [row] = history.rows(5);
    expect(row?.outputTokens).toBe(42);
    expect(row?.inputTokens).toBeUndefined();
    expect(row?.measured).toBe(false);
  });

  it("**同一步重复上报不会多出一行**（宿主每帧都给新数组）", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 100, totalTokens: 500 });
    history.settle(1, 1, { outputTokens: 100, totalTokens: 500 });
    history.settle(1, 1, { outputTokens: 100, totalTokens: 500 });
    expect(history.rows(20)).toHaveLength(1);
  });

  it("推理 token 不单独占一行，但会计进输出那一侧（宿主 `outputTokens` 已含它）", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 250, reasoningTokens: 180, totalTokens: 1_000 });
    expect(history.rows(5)[0]?.outputTokens).toBe(250);
  });
});

describe("步账：平均速率", () => {
  it("300 token / 2 秒 → 150 tok/s", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 300, totalTokens: 1_000, modelMs: 2_000 });
    expect(history.rows(1)[0]?.speed).toBeCloseTo(150, 6);
  });

  it("**量不到时长时 `speed` 是 `undefined`**（列表据此显示 `—`，不拿墙钟凑数）", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 300, totalTokens: 1_000 });
    expect(history.rows(1)[0]?.speed).toBeUndefined();
  });

  it("**只看宿主 `timing`**（页面在步骤结束后才挂上也能量出速度）", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 600, totalTokens: 2_000, modelMs: 2_000 });
    // 600 token / 2 秒 = 300 tok/s。
    expect(history.rows(1)[0]?.speed).toBeCloseTo(300, 6);
  });

  it("正在生成时显示估算输出，速度等结算后计算", () => {
    const history = ledger();
    history.setRunning(1, 1, 300);
    expect(history.rows(1)[0]).toMatchObject({ outputTokens: 300, speed: undefined, running: true });
    history.settle(1, 1, { outputTokens: 300, totalTokens: 1_000, modelMs: 10_000 });
    expect(history.rows(1)[0]).toMatchObject({ outputTokens: 300, speed: 30, running: false });
  });

  it("两者都没有 → `—`", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 300, totalTokens: 1_000 });
    expect(history.rows(1)[0]?.speed).toBeUndefined();
  });

  it("结算未上报输出 token 时不拿流式估算当作结算用量", () => {
    const history = ledger();
    history.setRunning(1, 1, 1_000);
    history.settle(1, 1, { inputTokens: 400, modelMs: 2_000 });
    expect(history.rows(1)[0]).toMatchObject({ outputTokens: undefined, speed: undefined, running: false });
  });

  it("结算缺少有效宿主时长时，不使用页面观察到的时间", () => {
    const history = ledger();
    history.setRunning(1, 1, 2_000);
    history.settle(1, 1, { outputTokens: 2_000, totalTokens: 4_000 });
    expect(history.rows(1)[0]?.speed).toBeUndefined();
  });
});

describe("步账：列表形状", () => {
  it("**最新在前**（一眼看到刚跑完的那一步）", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 100, totalTokens: 200 });
    history.settle(1, 2, { outputTokens: 200, totalTokens: 400 });
    history.settle(2, 1, { outputTokens: 300, totalTokens: 600 });
    expect(history.rows(3).map((row) => `${row.turn}:${row.step}`)).toEqual(["2:1", "1:2", "1:1"]);
  });

  it("只取最近 `count` 步", () => {
    const history = ledger();
    for (let step = 1; step <= 20; step += 1) history.settle(1, step, { outputTokens: step, totalTokens: step * 2 });
    expect(history.rows(5)).toHaveLength(5);
    expect(history.rows(5)[0]?.step).toBe(20);
  });

  it("步数不够时按现有的返回", () => {
    const history = ledger();
    history.settle(1, 1, { outputTokens: 10, totalTokens: 20 });
    expect(history.rows(20)).toHaveLength(1);
  });

  it("行数封顶（切到 20 步档也不会无限增长）", () => {
    const history = ledger();
    for (let step = 1; step <= STEP_HISTORY_CONSTANTS.maxSteps + 20; step += 1) {
      history.settle(1, step, { outputTokens: step, totalTokens: step * 2 });
    }
    expect(history.rows(200).length).toBeLessThanOrEqual(STEP_HISTORY_CONSTANTS.maxSteps);
  });

  it("补载超过容量的旧步骤也不会淘汰已经看到的新步骤", () => {
    const history = ledger();
    for (const step of [101, 102, 103]) history.settle(1, step, { outputTokens: step });
    for (let step = 1; step <= 100; step += 1) history.settle(1, step, { outputTokens: step });
    expect(history.rows(5).map(({ step }) => step)).toEqual([103, 102, 101, 100, 99]);
  });

  it("没有非法值也能安全返回空列表", () => {
    const history = ledger();
    history.setRunning(1, 1, 0);
    history.setRunning(1, 1, Number.NaN);
    expect(history.rows(5)).toEqual([]);
  });

  it("正在空的那一步标 `running`，结算之后就不标了", () => {
    const history = ledger();
    history.setRunning(1, 1, 100);
    expect(history.rows(1)[0]?.running).toBe(true);
    history.settle(1, 1, { outputTokens: 100, totalTokens: 200 });
    expect(history.rows(1)[0]?.running).toBe(false);
  });
});

describe("步数档", () => {
  it("是 5 / 10 / 20 三档（用户指定）", () => {
    expect(TPS_STEP_RANGES).toEqual([5, 10, 20]);
  });
});
