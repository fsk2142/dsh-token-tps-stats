import { describe, expect, it } from "vitest";

import { renderTurnDetails } from "../../src/client/tps-chart";
import type { TurnDetails } from "../../src/client/turn-details";

/** 递归取元素树里的可见文字。 */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object" || node === null) return "";
  const props = (node as { props?: { children?: unknown } }).props;
  return textOf(props?.children);
}

/** 递归找带指定 style 的元素。 */
function withWidth(node: unknown, width: string): boolean {
  if (typeof node !== "object" || node === null) return false;
  const props = (node as { props?: { style?: { width?: unknown } }; children?: unknown }).props;
  if (props?.style?.width === width) return true;
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return Array.isArray(children) ? children.some((child) => withWidth(child, width)) : withWidth(children, width);
}

const details: TurnDetails = {
  turn: 61,
  steps: 7,
  running: false,
  totalMs: 11_560,
  ttftMs: 4_960,
  generationMs: 6_600,
  outputTokens: 983_000,
  streamSpeed: 239.2,
  endToEndSpeed: 136.6,
  cacheHitRatio: 0.993,
  reasoningRatio: 0.32,
};

describe("本轮细则：纯渲染", () => {
  it("显示轮次、步数、总计与四行核心指标", () => {
    const text = textOf(renderTurnDetails(details));
    expect(text).toContain("第 61 轮 · 7 步 · 总计 11.56s");
    expect(text).toContain("生成速度");
    expect(text).toContain("流式 239 tok/s");
    expect(text).toContain("端到端 137 tok/s");
    expect(text).toContain("TTFT 4.96s");
    expect(text).toContain("生成 6.60s");
    expect(text).toContain("本轮输出");
    expect(text).toContain("983,000 tok");
    expect(text).toContain("缓存率 99.30%");
    expect(text).toContain("思维链 32%");
    expect(text).toContain("正文/工具 68%");
  });

  it("运行中在标题追加「估算」", () => {
    const text = textOf(renderTurnDetails({ ...details, running: true }));
    expect(text).toContain("第 61 轮 · 7 步 · 总计 11.56s · 估算");
  });

  it("缺失字段显示 —，不出现 NaN/Infinity", () => {
    const text = textOf(renderTurnDetails({ turn: 62, steps: 1, running: true }));
    expect(text).toContain("第 62 轮 · 1 步 · 总计 — · 估算");
    expect(text).toContain("流式 —");
    expect(text).toContain("端到端 —");
    expect(text).toContain("TTFT —");
    expect(text).toContain("生成 —");
    expect(text).toContain("本轮输出");
    expect(text).toContain("缓存率 —");
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it("比例条按 32/68 分配宽度，同时保留文字百分比", () => {
    const tree = renderTurnDetails(details);
    expect(withWidth(tree, "32%")).toBe(true);
    expect(withWidth(tree, "68%")).toBe(true);
    expect(textOf(tree)).toContain("思维链 32%");
    expect(textOf(tree)).toContain("正文/工具 68%");
  });

  it("明细内容显式占用 190px 最小高度，与定位模型一致", () => {
    const tree = renderTurnDetails(details);
    const style = (tree as { props?: { style?: { minHeight?: unknown } } }).props?.style;
    expect(style?.minHeight).toBe("190px");
  });

  it("没有可汇总数据时显示空态", () => {
    expect(textOf(renderTurnDetails(undefined))).toContain("当前轮次还没有可汇总的数据");
  });
});
