/**
 * **胶囊文字与「工具调用中」状态**的单测（2026-11-13）。
 *
 * 用户问「现在这个速度是纯输出的速度吗？」，并要求：口径保持「正文 + 思考」，
 * 但模型只在调工具、没有可见文字时不要再显示 0。
 *
 * 这两条都容易写歪，所以钉在纯函数上：
 * 1. 三种状态的文本各自长什么样、宽度是否一致；
 * 2. 「正在调工具」怎么从快照块里认出来。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { formatRate } from "../../src/client/format";
import { pillAriaOf, pillLabelOf } from "../../src/client/label";
import { toolCallInFlight } from "../../src/client/progress";
import { claimSessionStream, modeOf, pushSnapshot, readingOf, resetSessionStreamsForTests } from "../../src/client/session-store";

describe("胶囊文本：三种状态", () => {
  it("有速度 → 数字 + 单位", () => {
    const label = pillLabelOf("rate", 42.6, formatRate);
    expect(label).toEqual({ mode: "rate", prefix: "实时输出速度（TPS）：", number: "43", suffix: " tok/s" });
  });

  it("**工具调用中 → 拿掉数字位与单位**（宽度才不会跳，见 `label.ts`）", () => {
    const label = pillLabelOf("tool", 0, formatRate);
    expect(label.mode).toBe("tool");
    expect(label.number).toBeUndefined();
    expect(label.suffix).toBe("工具调用中");
    // 前缀不变：图标与文字之间那 6px 的间距还在原位。
    expect(label.prefix).toBe(pillLabelOf("rate", 10, formatRate).prefix);
  });

  it("空闲 → 0 tok/s（用户明确要求：不要消失）", () => {
    const label = pillLabelOf("idle", 0, formatRate);
    expect(label).toEqual({ mode: "idle", prefix: "实时输出速度（TPS）：", number: "0", suffix: " tok/s" });
  });

  it("**有读数时不会被误判成工具状态**（mode=rate 但读数为 0 会退回 idle）", () => {
    expect(pillLabelOf("rate", 0, formatRate).mode).toBe("idle");
  });
});

describe("无障碍文案：别把「工具调用中」读成速度", () => {
  it("工具状态说明「正在调用工具」而不是 0 tok/s", () => {
    expect(pillAriaOf("tool", 0, formatRate, false)).toContain("调用工具");
    expect(pillAriaOf("tool", 0, formatRate, false)).not.toContain("0 tok/s");
  });

  it("有速度时读数字", () => {
    expect(pillAriaOf("rate", 42, formatRate, false)).toBe("实时输出速度（TPS）：42 tok/s，点击查看变化曲线");
  });

  it("已展开时后半句换成「收起」", () => {
    expect(pillAriaOf("rate", 42, formatRate, true)).toContain("收起");
  });
});

describe("认出「正在调工具」", () => {
  it("**有 tool-call 块且参数为空 = 还在生成**（宿主只在 block-end 才填 argsRaw）", () => {
    expect(toolCallInFlight([{ kind: "tool-call", callId: "c1", name: "read", argsRaw: "" }])).toBe(true);
  });

  it("参数已填 = 这一块落地了，不算在流式", () => {
    expect(toolCallInFlight([{ kind: "tool-call", callId: "c1", name: "read", argsRaw: "{}" }])).toBe(false);
  });

  it("没有 tool-call 块 → 不在调工具", () => {
    expect(toolCallInFlight([{ kind: "text", text: "你好" }])).toBe(false);
    expect(toolCallInFlight([])).toBe(false);
    expect(toolCallInFlight(null)).toBe(false);
  });

  it("正文与工具块同时存在 → 仍算在调工具（正文也在流，读数不为 0，模式会优先走 rate）", () => {
    expect(toolCallInFlight([{ kind: "text", text: "我先看一下" }, { kind: "tool-call", argsRaw: "" }])).toBe(true);
  });
});

describe("状态机：读数优先，其次工具", () => {
  beforeEach(() => {
    resetSessionStreamsForTests();
  });

  it("有读数时是 rate（即使同时在调工具）", () => {
    const entry = claimSessionStream("A");
    entry.toolInFlight = true;
    expect(modeOf(entry, 42)).toBe("rate");
  });

  it("没读数、在调工具 → tool（不是 idle）", () => {
    const entry = claimSessionStream("A");
    entry.toolInFlight = true;
    expect(modeOf(entry, 0)).toBe("tool");
  });

  it("没读数、也没在调工具 → idle", () => {
    const entry = claimSessionStream("A");
    expect(modeOf(entry, 0)).toBe("idle");
  });

  it("**快照里只有工具块时，读数仍是 0，但状态会变成 tool**", () => {
    const entry = claimSessionStream("A");
    let at = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      at += 100;
      pushSnapshot(entry, { turn: 1, step: 1, blocks: [{ kind: "tool-call", callId: "c", name: "read", argsRaw: "" }] }, at);
      expect(readingOf(entry, at)).toBe(0);
      expect(modeOf(entry, readingOf(entry, at))).toBe("tool");
    }
  });

  it("工具块落地之后回到 idle", () => {
    const entry = claimSessionStream("A");
    pushSnapshot(entry, { turn: 1, step: 1, blocks: [{ kind: "tool-call", argsRaw: "" }] }, 1_000_100);
    expect(modeOf(entry, 0)).toBe("tool");
    pushSnapshot(entry, { turn: 1, step: 1, blocks: [{ kind: "tool-call", argsRaw: '{"a":1}' }] }, 1_000_200);
    expect(modeOf(entry, readingOf(entry, 1_000_200))).toBe("idle");
  });

  it("没有在跑的步 → 清掉工具标志", () => {
    const entry = claimSessionStream("A");
    entry.toolInFlight = true;
    pushSnapshot(entry, null, 1_000_300);
    expect(entry.toolInFlight).toBe(false);
  });
});
