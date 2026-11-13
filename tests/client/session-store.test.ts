/**
 * **差分与摊开的单测**（2026-11-13）。
 *
 * 这两条是「每个会话各自统计」的地基：差分错了会重复计/漏计，摊开错了会让积压
 * 之后的读数冲顶（用户报的「峰值 1000 多」）。所以边界都钉在这里。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { newTextSince, streamKeyOf, textOfBlocks, type ProgressBaseline } from "../../src/client/progress";
import { claimSessionStream, pushNodes, pushSnapshot, readingOf, releaseSessionStream, resetSessionStreamsForTests } from "../../src/client/session-store";
import { spreadCounts } from "../../src/client/spread";

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

describe("摊开：积压的字按真实时间段铺开", () => {
  it("时间跨度为 0 → 只一片（记在当下）", () => {
    expect(spreadCounts({ cjk: 10, other: 0 }, 1_000, 1_000)).toEqual([{ at: 1_000, cjk: 10, other: 0 }]);
  });

  it("**3 秒的积压摊成 3 片**（不摊的话这 3 秒的字会全挤进最近 1 秒的窗口）", () => {
    const slices = spreadCounts({ cjk: 0, other: 300 }, 0, 3_000, 1_000);
    expect(slices).toHaveLength(3);
    expect(slices.map((slice) => slice.at)).toEqual([1_000, 2_000, 3_000]);
    for (const slice of slices) expect(slice.other).toBe(100);
  });

  it("**总量严格守恒**（除不尽的零头进最后一片）", () => {
    const slices = spreadCounts({ cjk: 7, other: 10 }, 0, 3_000, 1_000);
    expect(slices.reduce((sum, slice) => sum + slice.cjk, 0)).toBe(7);
    expect(slices.reduce((sum, slice) => sum + slice.other, 0)).toBe(10);
  });

  it("没有字符时不产出切片", () => {
    expect(spreadCounts({ cjk: 0, other: 0 }, 0, 5_000)).toEqual([]);
  });
});

describe("会话状态：各算各的", () => {
  beforeEach(() => {
    resetSessionStreamsForTests();
  });

  /**
   * 按生产的节奏跑一段：每 100ms 采一拍快照，同时读一次数。
   *
   * **必须边走边读数**：速度计是「一阶低通」，第一拍读数从 0 起步（用户要的
   * 「慢慢爬上去」），所以只在最后一刻读一次是 0，测不出任何东西。
   * @param entry - 会话状态。
   * @param frames - 每一拍的累计文本长度。
   * @param from - 起始时刻。
   * @returns 采样过程中读到的最大读数。
   */
  function drive(entry: ReturnType<typeof claimSessionStream>, frames: readonly number[], from: number): number {
    let at = from;
    let peak = 0;
    for (const length of frames) {
      at += 100;
      pushSnapshot(entry, { turn: 1, step: 1, blocks: [{ kind: "text", text: "x".repeat(length) }] }, at);
      const reading = readingOf(entry, at);
      if (reading > peak) peak = reading;
    }
    return peak;
  }

  it("**两个会话互不影响**（同一个 id 永远拿到同一份，不同 id 是两份）", () => {
    const a = claimSessionStream("A");
    const b = claimSessionStream("B");
    expect(a).not.toBe(b);
    expect(claimSessionStream("A")).toBe(a);
  });

  it("只有 B 输出时，A 的读数恒为 0", () => {
    const a = claimSessionStream("A");
    const b = claimSessionStream("B");
    // 每拍 80 字，20 拍 = 1600 字，约 3 秒 —— 足够让 B 的指针爬上去。
    const frames = Array.from({ length: 20 }, (_value, index) => 80 * (index + 1));
    expect(drive(b, frames, 1_000_000)).toBeGreaterThan(0);
    expect(readingOf(a, 1_000_000 + 20 * 100)).toBe(0);
  });

  it("**切会话不会把上一个会话的曲线带过来**（释放后再认领是全新的一份）", () => {
    const first = claimSessionStream("A");
    const frames = Array.from({ length: 20 }, (_value, index) => 80 * (index + 1));
    expect(drive(first, frames, 1_000_000)).toBeGreaterThan(0);
    releaseSessionStream(first);
    const again = claimSessionStream("A");
    expect(again).not.toBe(first);
    // 新的一份没有任何基线，读数从 0 起步。
    expect(readingOf(again, 1_000_000 + 20 * 100)).toBe(0);
  });

  it("`partial` 为空时只清基线，不产字符", () => {
    const entry = claimSessionStream("A");
    const frames = Array.from({ length: 5 }, (_value, index) => 80 * (index + 1));
    drive(entry, frames, 1_000_000);
    expect(pushSnapshot(entry, null, 1_000_500)).toBe(false);
  });
});

describe("pushNodes：每步的真实用量", () => {
  beforeEach(() => {
    resetSessionStreamsForTests();
  });

  /** 造一个带 usage 与 timing 的助手节点。 */
  const assistantNode = (turn: number, step: number, extra: Record<string, unknown> = {}): unknown => ({
    kind: "assistant",
    turn,
    step,
    usage: { inputTokens: 100, outputTokens: 300, cacheReadTokens: 900, totalTokens: 1_320 },
    timing: { firstTokenTime: 1_000, completedTime: 3_000 },
    ...extra,
  });

  it("把已结束节点的 usage 记进步账", () => {
    const entry = claimSessionStream("A");
    pushNodes(entry, [assistantNode(1, 1)]);
    const row = entry.steps.rows(5)[0]!;
    expect(row.outputTokens).toBe(300);
    expect(row.inputTokens).toBe(100);
    expect(row.cacheReadTokens).toBe(900);
  });

  it("**同一数组引用第二次不重复处理**（会话越长越省）", () => {
    const entry = claimSessionStream("A");
    const nodes = [assistantNode(1, 1)];
    pushNodes(entry, nodes);
    pushNodes(entry, nodes);
    expect(entry.steps.rows(20)).toHaveLength(1);
    expect(entry.nodesSeen).toBe(nodes);
  });

  it("换了数组（哪怕内容相同）也会再看一遍 —— 幂等，不会多出行", () => {
    const entry = claimSessionStream("A");
    pushNodes(entry, [assistantNode(1, 1)]);
    pushNodes(entry, [assistantNode(1, 1)]);
    expect(entry.steps.rows(20)).toHaveLength(1);
  });

  it("跳过非助手节点、缺 turn/step 或 usage 的节点", () => {
    const entry = claimSessionStream("A");
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
    const entry = claimSessionStream("A");
    expect(() => pushNodes(entry, undefined)).not.toThrow();
    expect(() => pushNodes(entry, {})).not.toThrow();
  });
});

describe("generationMs：速度在步结束后也要留住（2026-11-13 用户反馈）", () => {
  beforeEach(() => {
    resetSessionStreamsForTests();
  });

  /**
   * 造一个助手节点（字段名与宿主 `finalNode` 完全一致）。
   * @param timing - 宿主的 `timing`。
   * @returns 节点。
   */
  const nodeWith = (timing: Record<string, unknown>): unknown => ({
    kind: "assistant",
    turn: 1,
    step: 1,
    usage: { inputTokens: 100, outputTokens: 600, cacheReadTokens: 900, totalTokens: 1_600 },
    timing,
  });

  /** 记一条人，返回它的速度。 */
  const speedOf = (timing: Record<string, unknown>): number | undefined => {
    const entry = claimSessionStream("A");
    pushNodes(entry, [nodeWith(timing)]);
    return entry.steps.rows(1)[0]?.speed;
  };

  it("**有首 token 时刻**：用 `completedTime − firstTokenTime`", () => {
    // 600 token / 2 秒 = 300 tok/s。
    expect(speedOf({ stepStartTime: 500, firstTokenTime: 1_000, completedTime: 3_000 })).toBeCloseTo(300, 6);
  });

  it("**首 token 是 `null`**（这一步没有可识别的 token delta）→ 退回 `stepStartTime`", () => {
    /*
     * 用户截图里那些步全是「只有 tool-call 块」：宿主判 `isTokenDelta` 时
     * `argumentsDelta` 为空就不算首 token，于是 `firstTokenTime` 是 `null`。
     * 早先只实现了上一种，这些步就永远显示 `—`。
     *
     * 工具在 `assistant/message` **之后**才跑，所以 `completedTime − stepStartTime`
     * 仍然是纯生成时间。600 token / 2 秒 = 300 tok/s。
     */
    expect(speedOf({ stepStartTime: 1_000, firstTokenTime: null, completedTime: 3_000 })).toBeCloseTo(300, 6);
  });

  it("两个时刻都缺 → `—`（不拿墙钟凑数）", () => {
    expect(speedOf({ completedTime: 3_000 })).toBeUndefined();
  });

  it("时刻倒挂（时钟回拨）→ `—`", () => {
    expect(speedOf({ stepStartTime: 9_000, firstTokenTime: 8_000, completedTime: 3_000 })).toBeUndefined();
  });

  it("首 token 比完成晚 → 退回 `stepStartTime` 而不是算成负数", () => {
    expect(speedOf({ stepStartTime: 1_000, firstTokenTime: 5_000, completedTime: 3_000 })).toBeCloseTo(300, 6);
  });
});
