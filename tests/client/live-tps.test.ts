import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionStream, observeSessionSpeed, pushSnapshot } from "../../src/client/session-store";
import { createTpsMeter } from "../../src/client/tps-meter";
import { createTpsHistory } from "../../src/client/tps-history";
import type { SessionEventSource } from "../../src/client/session-events";

const start = 1_000_000;
const chunk = (time: number, text: string, type = "text-delta") => ({
  type: "transient", event: { type: "assistant/live-chunk", time, data: { chunk: { type, text } } },
});

function eventSource() {
  const listeners = new Set<() => void>();
  let snapshot: ReturnType<SessionEventSource["getSnapshot"]> = {
    revision: 1, change: { kind: "replace", entries: [chunk(start, "中".repeat(900))] },
  };
  const source: SessionEventSource = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const publish = (kind: string, entries: readonly unknown[] = []) => {
    snapshot = { revision: snapshot.revision + 1, change: { kind, entries } };
    for (const listener of listeners) listener();
  };
  return { source, publish };
}

afterEach(() => vi.useRealTimers());

describe("实时输出速度", () => {
  it("短步在半秒内有读数，读数频率不影响滤波结果", () => {
    const meter = createTpsMeter();
    for (const offset of [100, 200, 300]) meter.push(48, start + offset);
    expect(meter.reading(start + 500)).toBeCloseTo(62.75, 1);
    expect(meter.reading(start + 500)).toBeCloseTo(62.75, 1);
  });

  it("卡顿恢复使用原始时间戳，快照回退也能按区间计算", () => {
    const meter = createTpsMeter();
    for (let offset = 100; offset <= 6_000; offset += 100) {
      meter.push(10, start + offset, start + 6_000);
    }
    expect(meter.reading(start + 6_000)).toBeCloseTo(99.7, 0);
    const fallback = createTpsMeter();
    fallback.push(600, start + 6_000, start + 6_000, start);
    expect(fallback.reading(start + 6_000)).toBeCloseTo(99.9, 1);
  });

  it("单个同毫秒短步唤醒刷新，结算后仍显示并在空闲后停表", () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const session = createSessionStream("A");
    const { source, publish } = eventSource();
    const readings: number[] = [];
    const stop = observeSessionSpeed(session, source, (value) => readings.push(value));
    expect(vi.getTimerCount()).toBe(0);
    publish("append", [chunk(start, "中".repeat(60)), chunk(start, "中".repeat(40), "reasoning-delta")]);
    publish("settle-assistant");
    vi.advanceTimersByTime(500);
    expect(readings.at(-1)).toBeCloseTo(54.83, 1);
    expect(session.history.view(Date.now(), 60).summary.latest).toBe(readings.at(-1));
    vi.advanceTimersByTime(10_000);
    expect(readings.at(-1)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("历史重载与其他会话的流不会写入当前会话", () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const first = createSessionStream("A");
    const second = createSessionStream("B");
    const a = eventSource();
    const b = eventSource();
    const stopA = observeSessionSpeed(first, a.source, () => {});
    const stopB = observeSessionSpeed(second, b.source, () => {});
    a.publish("replace", [chunk(start, "中".repeat(900))]);
    a.publish("prepend", [chunk(start, "中".repeat(900))]);
    a.publish("append", [chunk(start, "中".repeat(900), "tool-call-delta")]);
    b.publish("append", [chunk(start, "中".repeat(20))]);
    vi.advanceTimersByTime(500);
    expect(first.history.view(Date.now(), 60).summary.peak).toBe(0);
    expect(second.history.view(Date.now(), 60).summary.peak).toBeGreaterThan(10);
    stopA();
    stopB();
    b.publish("append", [chunk(Date.now(), "中".repeat(20))]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("快照回退识别持续观测下的首包，并跳过挂载时已有的文本", () => {
    const session = createSessionStream("A");
    const snapshot = (step: number, text: string) => ({ turn: 1, step, blocks: [{ kind: "text", text }] });
    expect(pushSnapshot(session, snapshot(1, "已有"), start)).toBe(false);
    expect(pushSnapshot(session, null, start + 100)).toBe(false);
    expect(pushSnapshot(session, snapshot(2, "中".repeat(50)), start + 5_000)).toBe(true);
    expect(session.meter.reading(start + 5_500)).toBeCloseTo(27.42, 1);
  });

  it("折线保留整秒之间的峰值，平均按时间包含空闲", () => {
    const history = createTpsHistory();
    history.record(start + 300, 80);
    history.record(start + 400, 20);
    history.record(start + 500, 0);
    const { points, summary } = history.view(start + 1_000, 2);
    expect(points).toContainEqual({ at: start + 300, value: 80 });
    expect(summary).toEqual({ latest: 0, average: 5, peak: 80 });
  });
});
