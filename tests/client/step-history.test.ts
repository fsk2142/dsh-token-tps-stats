/**
 * **每一步的账**的单测（2026-11-13）。
 *
 * 这块数据是**列表**而不是折线：用户要「直接列出来第一步，输出多少，输入多少，
 * 命中多少，平均速率多少」。容易写歪的地方都钉在这里：
 *
 * 1. token 用量来自真实的 `usage`，不是估算；
 * 2. 拿不到流式时长时速率是 `undefined`（显示 `—`），**不拿墙钟凑数**；
 * 3. 时长有下限、间隔有上限 —— 分母只可能偏大，读数只可能偏低；
 * 4. 列表是**最新在前**，只取最近 N 步；
 * 5. 同一步重复 `settle` 不会多出一行。
 */
import { describe, expect, it } from "vitest";

import { createStepHistory, STEP_HISTORY_CONSTANTS, TPS_STEP_RANGES } from "../../src/client/step-history";

describe("步账：真实用量优先", () => {
  it("**有 usage 就显示真实数字**，而不是估算", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 5, 1_000);
    ledger.settle(1, 1, { inputTokens: 120, outputTokens: 300, cacheReadTokens: 900, totalTokens: 1_320 });
    const [row] = ledger.rows(5);
    expect(row?.outputTokens).toBe(300);
    expect(row?.inputTokens).toBe(120);
    expect(row?.cacheReadTokens).toBe(900);
    // 命中率 = 读取 ÷（读取 + 输入 + 写入）= 900 ÷ 1020。
    expect(row?.hitRatio).toBeCloseTo(900 / 1_020, 6);
    expect(row?.measured).toBe(true);
  });

  it("还没有 usage 时退回流式期间的估算（并标 `measured: false`）", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 42, 1_000);
    const [row] = ledger.rows(5);
    expect(row?.outputTokens).toBe(42);
    expect(row?.inputTokens).toBeUndefined();
    expect(row?.measured).toBe(false);
  });

  it("**同一步重复 settle 不会多出一行**（宿主每帧都给新数组）", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 100, totalTokens: 500 });
    ledger.settle(1, 1, { outputTokens: 100, totalTokens: 500 });
    ledger.settle(1, 1, { outputTokens: 100, totalTokens: 500 });
    expect(ledger.rows(20)).toHaveLength(1);
  });

  it("推理 token 不单独占一行，但会计进输出那一侧（宿主 `outputTokens` 已含它）", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 250, reasoningTokens: 180, totalTokens: 1_000 });
    expect(ledger.rows(5)[0]?.outputTokens).toBe(250);
  });
});

describe("步账：平均速率", () => {
  it("300 token / 2 秒 → 150 tok/s", () => {
    const ledger = createStepHistory();
    // 第一次交付的间隔也要计（`at - 上一次采样`），否则每步开头都少一段。
    ledger.add("1:1", 1, 1, 100, 1_000);
    ledger.add("1:1", 1, 1, 200, 1_000);
    ledger.settle(1, 1, { outputTokens: 300, totalTokens: 1_000 });
    expect(ledger.rows(1)[0]?.speed).toBeCloseTo(150, 6);
  });

  it("**量不到时长时 `speed` 是 `undefined`**（列表据此显示 `—`，不拿墙钟凑数）", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 300, totalTokens: 1_000 });
    expect(ledger.rows(1)[0]?.speed).toBeUndefined();
  });

  it("**没有观察到流式时退回宿主的 `timing`**（页面在步骤结束后才挂上也能量出速度）", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 600, totalTokens: 2_000, generationMs: 2_000 });
    // 600 token / 2 秒 = 300 tok/s。
    expect(ledger.rows(1)[0]?.speed).toBeCloseTo(300, 6);
  });

  it("自己观察到的时长**优先于** `timing`（前者更贴近实际流式）", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 300, 1_000);
    ledger.settle(1, 1, { outputTokens: 300, totalTokens: 1_000, generationMs: 10_000 });
    // 用 1 秒（观察值），不是 10 秒（timing）→ 300 tok/s。
    expect(ledger.rows(1)[0]?.speed).toBeCloseTo(300, 6);
  });

  it("两者都没有 → `—`", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 300, totalTokens: 1_000 });
    expect(ledger.rows(1)[0]?.speed).toBeUndefined();
  });

  it("**时长下限**：全部字落在一帧里也不会除出天文数字", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 1_000, 0);
    ledger.settle(1, 1, { outputTokens: 1_000, totalTokens: 2_000 });
    expect(ledger.rows(1)[0]?.speed).toBeCloseTo((1_000 / STEP_HISTORY_CONSTANTS.minDurationMs) * 1_000, 6);
  });

  it("**间隔上限**：主线程被占住 30 秒后一次吐 2000 token 也有个界", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 2_000, 30_000);
    ledger.settle(1, 1, { outputTokens: 2_000, totalTokens: 4_000 });
    const speed = ledger.rows(1)[0]?.speed ?? 0;
    expect(speed).toBeCloseTo((2_000 / STEP_HISTORY_CONSTANTS.gapCapMs) * 1_000, 6);
  });
});

describe("步账：列表形状", () => {
  it("**最新在前**（一眼看到刚跑完的那一步）", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 100, totalTokens: 200 });
    ledger.settle(1, 2, { outputTokens: 200, totalTokens: 400 });
    ledger.settle(2, 1, { outputTokens: 300, totalTokens: 600 });
    expect(ledger.rows(3).map((row) => `${row.turn}:${row.step}`)).toEqual(["2:1", "1:2", "1:1"]);
  });

  it("只取最近 `count` 步", () => {
    const ledger = createStepHistory();
    for (let step = 1; step <= 20; step += 1) ledger.settle(1, step, { outputTokens: step, totalTokens: step * 2 });
    expect(ledger.rows(5)).toHaveLength(5);
    expect(ledger.rows(5)[0]?.step).toBe(20);
  });

  it("步数不够时按现有的返回", () => {
    const ledger = createStepHistory();
    ledger.settle(1, 1, { outputTokens: 10, totalTokens: 20 });
    expect(ledger.rows(20)).toHaveLength(1);
  });

  it("行数封顶（切到 20 步档也不会无限增长）", () => {
    const ledger = createStepHistory();
    for (let step = 1; step <= STEP_HISTORY_CONSTANTS.maxSteps + 20; step += 1) {
      ledger.settle(1, step, { outputTokens: step, totalTokens: step * 2 });
    }
    expect(ledger.rows(200).length).toBeLessThanOrEqual(STEP_HISTORY_CONSTANTS.maxSteps);
  });

  it("没有非法值也能安全返回空列表", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 0, 1_000);
    ledger.add("1:1", 1, 1, Number.NaN, 1_000);
    expect(ledger.rows(5)).toEqual([]);
  });

  it("正在空的那一步标 `running`，settle 之后就不标了", () => {
    const ledger = createStepHistory();
    ledger.add("1:1", 1, 1, 100, 1_000);
    expect(ledger.rows(1)[0]?.running).toBe(true);
    ledger.settle(1, 1, { outputTokens: 100, totalTokens: 200 });
    expect(ledger.rows(1)[0]?.running).toBe(false);
  });
});

describe("步数档", () => {
  it("是 5 / 10 / 20 三档（用户指定）", () => {
    expect(TPS_STEP_RANGES).toEqual([5, 10, 20]);
  });
});
