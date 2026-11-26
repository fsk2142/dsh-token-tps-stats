/**
 * **快照差分与会话步统计的单测**（2026-11-13）。
 *
 * 覆盖增量差分、会话隔离和结算快照更新。
 */
import { describe, expect, it } from "vitest";

import { newTextSince, streamKeyOf, textOfBlocks, type ProgressBaseline } from "../../src/client/progress";
import { createSessionStream, pushNodes, pushSnapshot } from "../../src/client/session-store";

describe("块文本提取", () => {
  it("只认 text 与 reasoning（工具参数不算输出速度）", () => {
    const texts = textOfBlocks([
      { kind: "text", text: "正文" },
      { kind: "reasoning", text: "思考" },
      { kind: "tool-call", name: "read", argsRaw: "{}" },
    ]);
    expect(texts).toEqual(["正文", "思考", undefined]);
  });

  it("**保留下标对齐**（块可能中间有空位）", () => {
    const texts = textOfBlocks([undefined, { kind: "text", text: "a" }]);
    expect(texts).toEqual([undefined, "a"]);
  });

  it("不是数组时返回空数组（不崩）", () => {
    expect(textOfBlocks(null)).toEqual([]);
    expect(textOfBlocks({})).toEqual([]);
  });
});

describe("差分：算出这一拍新增的字", () => {
  it("块变长且旧文本是前缀 → 只取尾巴", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: ["你好"] };
    const delta = newTextSince(baseline, [{ kind: "text", text: "你好世界" }], "1:1");
    expect(delta.pieces).toEqual(["世界"]);
  });

  it("**没有基线时什么都不产出**（插件中途挂上不该把已有文本算成新到的字）", () => {
    const delta = newTextSince(undefined, [{ kind: "text", text: "很长的已有文本" }], "1:1");
    expect(delta.pieces).toEqual([]);
    expect(delta.baseline.texts).toEqual(["很长的已有文本"]);
  });

  it("**换了流（turn/step 变了）也不产出**，只换基线", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: ["旧的一步"] };
    const delta = newTextSince(baseline, [{ kind: "text", text: "新一轮的开头" }], "1:2");
    expect(delta.pieces).toEqual([]);
  });

  it("**文本变短（重试清零）不产出**，只更新基线", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: ["一二三四五"] };
    const delta = newTextSince(baseline, [{ kind: "text", text: "一" }], "1:1");
    expect(delta.pieces).toEqual([]);
    expect(delta.baseline.texts).toEqual(["一"]);
  });

  it("**文本被换成另一段（不是前缀）也不产出**", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: ["abc"] };
    const delta = newTextSince(baseline, [{ kind: "text", text: "xyz" }], "1:1");
    expect(delta.pieces).toEqual([]);
  });

  it("块重排时不会把移到新下标的已有文本重算", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: ["已有思考"] };
    const delta = newTextSince(baseline, [
      { kind: "text", text: "新正文" },
      { kind: "reasoning", text: "已有思考" },
    ], "1:1");
    expect(delta.pieces).toEqual([]);
    expect(delta.baseline.texts).toEqual(["新正文", "已有思考"]);
  });

  it("新出现的块整段算作新增", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: [undefined] };
    const delta = newTextSince(baseline, [{ kind: "text", text: "刚开的块" }], "1:1");
    expect(delta.pieces).toEqual(["刚开的块"]);
  });

  it("正文与思考同时在长 → 两段都产出", () => {
    const baseline: ProgressBaseline = { stream: "1:1", texts: ["正文", "思考"] };
    const delta = newTextSince(
      baseline,
      [
        { kind: "text", text: "正文继续" },
        { kind: "reasoning", text: "思考继续" },
      ],
      "1:1",
    );
    expect(delta.pieces).toEqual(["继续", "继续"]);
  });

  it("**同一份快照重复推一次不会重复计**（差分是幂等的）", () => {
    const first = newTextSince(undefined, [{ kind: "text", text: "abc" }], "1:1");
    const second = newTextSince(first.baseline, [{ kind: "text", text: "abc" }], "1:1");
    expect(second.pieces).toEqual([]);
  });

  it("streamKeyOf 把 turn/step 拼成一条流", () => {
    expect(streamKeyOf(3, 7)).toBe("3:7");
  });
});

describe("会话状态：各算各的", () => {
  /**
   * 按生产的节奏跑一段：每 100ms 采一拍快照，同时读一次数。
   *
   * @param entry - 会话状态。
   * @param frames - 每一拍的累计文本长度。
   * @param from - 起始时刻。
   * @returns 采样过程中读到的最大读数。
   */
  function drive(entry: ReturnType<typeof createSessionStream>, frames: readonly number[], from: number): number {
    let at = from;
    let peak = 0;
    for (const length of frames) {
      at += 100;
      pushSnapshot(entry, { turn: 1, step: 1, blocks: [{ kind: "text", text: "x".repeat(length) }] }, at);
      const reading = entry.meter.reading(at);
      if (reading > peak) peak = reading;
    }
    return peak;
  }

  it("只有 B 输出时，A 的读数恒为 0", () => {
    const a = createSessionStream("A");
    const b = createSessionStream("B");
    // 每拍 80 字，20 拍 = 1600 字，约 3 秒 —— 足够让 B 的指针爬上去。
    const frames = Array.from({ length: 20 }, (_value, index) => 80 * (index + 1));
    expect(drive(b, frames, 1_000_000)).toBeGreaterThan(0);
    expect(a.meter.reading(1_000_000 + 20 * 100)).toBe(0);
  });

  it("**重新挂载会话时使用全新的采集状态**", () => {
    const first = createSessionStream("A");
    const frames = Array.from({ length: 20 }, (_value, index) => 80 * (index + 1));
    expect(drive(first, frames, 1_000_000)).toBeGreaterThan(0);
    const again = createSessionStream("A");
    expect(again).not.toBe(first);
    // 新的一份没有任何基线，读数从 0 起步。
    expect(again.meter.reading(1_000_000 + 20 * 100)).toBe(0);
  });

  it("`partial` 为空时只清基线，不产字符", () => {
    const entry = createSessionStream("A");
    const frames = Array.from({ length: 5 }, (_value, index) => 80 * (index + 1));
    drive(entry, frames, 1_000_000);
    expect(pushSnapshot(entry, null, 1_000_500)).toBe(false);
  });
});

describe("pushNodes：每步的真实用量", () => {
  /** 造一个带 usage 与 timing 的助手节点。 */
  const assistantNode = (turn: number, step: number, extra: Record<string, unknown> = {}) => ({
    kind: "assistant",
    turn,
    step,
    usage: { inputTokens: 100, outputTokens: 300, cacheReadTokens: 900, totalTokens: 1_320 },
    timing: { firstTokenTime: 1_000, completedTime: 3_000 },
    ...extra,
  });

  it("把已结束节点的 usage 记进步账", () => {
    const entry = createSessionStream("A");
    pushNodes(entry, [assistantNode(1, 1)]);
    const row = entry.steps.rows(5)[0]!;
    expect(row.outputTokens).toBe(300);
    expect(row.inputTokens).toBe(100);
    expect(row.cacheReadTokens).toBe(900);
  });

  it("宿主快照移除或更正已完成节点时，表格同步更新", () => {
    const entry = createSessionStream("A");
    pushNodes(entry, [assistantNode(1, 1), assistantNode(1, 2)]);
    pushNodes(entry, [assistantNode(1, 2, { usage: { outputTokens: 42 } })]);
    expect(entry.steps.rows(5).map(({ step, outputTokens }) => [step, outputTokens])).toEqual([[2, 42]]);
    pushNodes(entry, []);
    expect(entry.steps.rows(5)).toEqual([]);
  });

  it("只在读取表格时解析用量，长会话只解析最近的步骤", () => {
    const entry = createSessionStream("A");
    const parsed: number[] = [];
    const nodes = Array.from({ length: 500 }, (_, index) => {
      const step = index + 1;
      const node = assistantNode(1, step);
      return { ...node, get usage() { parsed.push(step); return { outputTokens: step }; } };
    });
    pushNodes(entry, nodes);
    expect(parsed).toHaveLength(0);
    expect(entry.steps.rows(5).map(({ step }) => step)).toEqual([500, 499, 498, 497, 496]);
    expect(parsed).toHaveLength(40);
    entry.steps.rows(20);
    expect(parsed).toHaveLength(40);
  });

  it("乱序的结算快照也按轮次和步号保留最新步骤", () => {
    const entry = createSessionStream("A");
    const nodes = Array.from({ length: 100 }, (_, index) => assistantNode(1, 101 - index));
    pushNodes(entry, [assistantNode(2, 1), ...nodes, assistantNode(1, 101, { usage: { outputTokens: 900 } })]);
    expect(entry.steps.rows(4).map(({ turn, step, outputTokens }) => [turn, step, outputTokens])).toEqual([
      [2, 1, 300], [1, 101, 900], [1, 100, 300], [1, 99, 300],
    ]);
  });

  it("结算快照更新时保留正在生成的下一步", () => {
    const entry = createSessionStream("A");
    pushSnapshot(entry, { turn: 1, step: 3, blocks: [{ kind: "text", text: "正文" }] }, 4_000);
    pushNodes(entry, [assistantNode(1, 2)]);
    expect(entry.steps.rows(2).map(({ step, running }) => [step, running])).toEqual([[3, true], [2, false]]);
  });

  it("**同一数组引用第二次不重复处理**（会话越长越省）", () => {
    const entry = createSessionStream("A");
    const nodes = [assistantNode(1, 1)];
    let updates = 0;
    const stop = entry.steps.subscribe(() => { updates += 1; });
    pushNodes(entry, nodes);
    pushNodes(entry, nodes);
    expect(entry.steps.rows(20)).toHaveLength(1);
    expect(updates).toBe(1);
    stop();
  });

  it("换了数组（哪怕内容相同）也会再看一遍 —— 幂等，不会多出行", () => {
    const entry = createSessionStream("A");
    pushNodes(entry, [assistantNode(1, 1)]);
    pushNodes(entry, [assistantNode(1, 1)]);
    expect(entry.steps.rows(20)).toHaveLength(1);
  });

  it("跳过非助手节点、缺 turn/step 或 usage 的节点", () => {
    const entry = createSessionStream("A");
    pushNodes(entry, [
      { kind: "user", turn: 1, step: 1 },
      { kind: "assistant", turn: "x", step: 1, usage: { outputTokens: 1 } },
      { kind: "assistant", turn: 1, step: 1 },
      null,
      "not a node",
    ]);
    expect(entry.steps.rows(20)).toEqual([]);
  });

  it("非数组输入安全返回", () => {
    const entry = createSessionStream("A");
    expect(() => pushNodes(entry, undefined)).not.toThrow();
    expect(() => pushNodes(entry, {})).not.toThrow();
  });

  it("步骤完成但宿主未上报用量时，表格保留该步并显示缺失值", () => {
    const entry = createSessionStream("A");
    const snapshot = (text: string) => ({ turn: 1, step: 1, blocks: [{ kind: "text", text }] });
    pushSnapshot(entry, snapshot(""), 1_000);
    pushSnapshot(entry, snapshot("流式文本"), 2_000);
    expect(entry.steps.rows(1)[0]?.running).toBe(true);
    pushSnapshot(entry, null, 3_000);
    pushNodes(entry, [assistantNode(1, 1, {
      usage: undefined, timing: { stepStartTime: 1_000, completedTime: 3_000 },
    })]);
    expect(entry.steps.rows(1)[0]).toMatchObject({ running: false, outputTokens: undefined, speed: undefined });
  });
});

describe("进行中的输出来自当前快照", () => {
  const snapshot = (text: string) => ({ turn: 1, step: 1, blocks: [{ kind: "text", text }] });

  it("中途挂载显示已有输出，但已有文本不进入实时 TPS", () => {
    const entry = createSessionStream("A");
    expect(pushSnapshot(entry, snapshot("中".repeat(1_000)), 1_000)).toBe(false);
    expect(entry.steps.rows(1)[0]?.outputTokens).toBe(1_000);
    expect(entry.meter.reading(1_500)).toBe(0);
    pushSnapshot(entry, snapshot("中".repeat(1_010)), 1_100);
    expect(entry.steps.rows(1)[0]?.outputTokens).toBe(1_010);
  });

  it("重试清空并替换文本时，输出只显示当前尝试", () => {
    const entry = createSessionStream("A");
    pushSnapshot(entry, null, 1_000);
    pushSnapshot(entry, snapshot("中".repeat(1_000)), 1_100);
    pushSnapshot(entry, snapshot(""), 1_200);
    expect(entry.steps.rows(1)).toEqual([]);
    pushSnapshot(entry, snapshot("新".repeat(10)), 1_300);
    expect(entry.steps.rows(1)[0]?.outputTokens).toBe(10);
    pushSnapshot(entry, snapshot("替换"), 1_400);
    expect(entry.steps.rows(1)[0]?.outputTokens).toBe(2);
  });
});

describe("generationMs：速度在步结束后也要留住（2026-11-13 用户反馈）", () => {
  /**
   * 造一个助手节点（字段名与宿主 `finalNode` 完全一致）。
   * @param timing - 宿主的 `timing`。
   * @returns 节点。
   */
  const nodeWith = (timing: Record<string, unknown>) => ({
    kind: "assistant",
    turn: 1,
    step: 1,
    usage: { inputTokens: 100, outputTokens: 600, cacheReadTokens: 900, totalTokens: 1_600 },
    timing,
  });

  /** 记一条人，返回它的速度。 */
  const speedOf = (timing: Record<string, unknown>): number | undefined => {
    const entry = createSessionStream("A");
    pushNodes(entry, [nodeWith(timing)]);
    return entry.steps.rows(1)[0]?.speed;
  };

  it("有首包时间时，仍使用从步骤开始到模型完成的 2.5 秒", () => {
    expect(speedOf({ stepStartTime: 500, firstTokenTime: 1_000, completedTime: 3_000 })).toBe(240);
  });

  it("首包缺失或集中在结束前 1ms，使用同一段模型耗时", () => {
    expect(speedOf({ stepStartTime: 1_000, firstTokenTime: null, completedTime: 3_000 })).toBeCloseTo(300, 6);
    expect(speedOf({ stepStartTime: 1_000, firstTokenTime: 2_999, completedTime: 3_000 })).toBeCloseTo(300, 6);
  });

  it("缺步骤开始时间或完成时间时不估算", () => {
    expect(speedOf({ firstTokenTime: 2_000, completedTime: 3_000 })).toBeUndefined();
    expect(speedOf({ stepStartTime: 2_000 })).toBeUndefined();
  });

  it("时刻倒挂（时钟回拨）→ `—`", () => {
    expect(speedOf({ stepStartTime: 9_000, firstTokenTime: 8_000, completedTime: 3_000 })).toBeUndefined();
  });

  it("页面只观察到最后一段输出，结算速度和重新打开会话时一致", () => {
    const entry = createSessionStream("A");
    const snapshot = (text: string) => ({ turn: 1, step: 1, blocks: [{ kind: "text", text }] });
    pushSnapshot(entry, snapshot("此前输出"), 10_000);
    pushSnapshot(entry, snapshot("此前输出加上最后一包"), 11_000);
    const timing = { stepStartTime: 1_000, firstTokenTime: 5_000, completedTime: 11_000 };
    pushNodes(entry, [nodeWith(timing)]);
    expect(entry.steps.rows(1)[0]?.speed).toBe(60);
    expect(entry.steps.rows(1)[0]?.speed).toBe(speedOf(timing));
  });

  it("补载历史时仍显示最近的轮次和步骤", () => {
    const entry = createSessionStream("A");
    const timing = { stepStartTime: 1_000, completedTime: 2_000 };
    const node = (turn: number, step: number) => ({ ...nodeWith(timing), turn, step });
    const recent = [node(2, 10), node(2, 11), node(3, 1)];
    pushNodes(entry, recent);
    pushNodes(entry, [node(1, 30), node(2, 8), node(2, 9), ...recent]);
    expect(entry.steps.rows(5).map(({ turn, step }) => [turn, step])).toEqual([
      [3, 1], [2, 11], [2, 10], [2, 9], [2, 8],
    ]);
  });
});
