import { afterEach, describe, expect, it, vi } from "vitest";

import { observeOutputEvents, type SessionEventSource } from "../../src/client/session-events";
import { createTpsMeter, TPS_METER_CONSTANTS } from "../../src/client/tps-meter";

const base = 1_790_000_000_000;

/**
 * 造一个能发 append 的事件源。
 * @returns 源与「发一批 chunk」的函数。
 */
function eventSource() {
  const listeners = new Set<() => void>();
  let revision = 1;
  let change: { kind: string; entries: readonly unknown[] } = { kind: "replace", entries: [] };
  const source: SessionEventSource = {
    getSnapshot: () => ({ revision, change }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  /**
   * 发一批 live-chunk（**同一个回调里**）。
   * @param at - 每片的源时间（可传函数）。
   * @param count - 片数。
   * @param tokensPerChunk - 每片 token 数（按 4.2 字符/token 折算成字符）。
   */
  const append = (at: number | ((index: number) => number), count: number, tokensPerChunk: number): void => {
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const time = typeof at === "function" ? at(index) : at;
      entries.push({
        type: "transient",
        event: {
          type: "assistant/live-chunk",
          time,
          data: { chunk: { type: "text-delta", text: "x".repeat(Math.round(tokensPerChunk * 4.2)) } },
        },
      });
    }
    revision += 1;
    change = { kind: "append", entries };
    for (const listener of listeners) listener();
  };
  return { source, append };
}

/**
 * 接一根生产链路：事件源 → 速度计。
 * @param source - 事件源。
 * @returns 速度计与停止函数。
 */
function wire(source: SessionEventSource) {
  const meter = createTpsMeter();
  const stop = observeOutputEvents(source, (batch, receivedAt) => {
    meter.push(batch.tokens, batch.at, receivedAt, batch.from);
  });
  return { meter, stop };
}

afterEach(() => vi.useRealTimers());

describe("异常峰值：一个回调里到达一大批 chunk（2026-11-14 用户报 3925 tok/s）", () => {
  it("**867 片挤在同一毫秒回调里 → 读数被钳住**（走生产链路）", () => {
    /*
     * 复现用户截图那次：宿主在一次 append 里带来 867 片 delta（重新订阅 /
     * 重新基线时会这样）。生产链路现在把**整批合并成一次 push**，
     * 而速度计对单次 push 有上限，所以读数不会冲到几千。
     *
     * 用假时钟让 `receivedAt`(= Date.now()) 与源时间戳同步 —— 否则
     * `push` 会把整批当成「迟到了很久」而衰减成 0，那是测试的错。
     */
    vi.useFakeTimers();
    vi.setSystemTime(base);
    const { source, append } = eventSource();
    const wired = wire(source);

    append(base, 867, 8);
    const peak = wired.meter.reading(base + 100);
    wired.stop();

    expect(peak, `峰值 ${peak.toFixed(0)} tok/s（867 片 × 8 token = 6936 token）`).toBeLessThan(400);
  });

  it("**同一批但源时间有真实跨度时，读数贴近历史真实速率**", () => {
    /*
     * 这一批不是「瞬间生成」，而是「过去 3 秒生成的文本被重放」。
     * 合并 + 带区间之后，读数反映的是那段文本历史上的速率，
     * 而不是被 1/0 放大后的天文数字。
     */
    vi.useFakeTimers();
    vi.setSystemTime(base);
    const { source, append } = eventSource();
    const wired = wire(source);

    append((index) => base - 3_000 + (3_000 * index) / 866, 867, 8);
    const peak = wired.meter.reading(base + 100);
    wired.stop();

    expect(peak, `峰值 ${peak.toFixed(0)} tok/s`).toBeGreaterThan(0);
    expect(peak, `峰值 ${peak.toFixed(0)} tok/s 不该超过历史速率`).toBeLessThan(2_600);
  });

  it("**正常流式：每片一个回调 → 读数仍是真实速率**（合并不该把日常读数压平）", () => {
    vi.useFakeTimers();
    const { source, append } = eventSource();
    const wired = wire(source);

    // 每 16ms 一片 5 token → 312 tok/s
    for (let index = 1; index <= 200; index += 1) {
      const at = base + index * 16;
      vi.setSystemTime(at);
      append(at, 1, 5);
    }
    const reading = wired.meter.reading(base + 200 * 16);
    wired.stop();

    expect(reading, `稳定读数 ${reading.toFixed(0)}`).toBeGreaterThan(250);
    expect(reading, `稳定读数 ${reading.toFixed(0)}`).toBeLessThan(400);
  });

  it("速度计对**一次到达的隐含速率**有硬上限（最后一道闸）", () => {
    const meter = createTpsMeter();
    meter.push(19_341, base, base, base);
    const peak = meter.reading(base + 100);
    /*
     * 上限 3000 tok/s 的点冲激：等效速率被钳到 3000，
     * 100ms 后的 second ≈ 0.583 × 3000 ≈ 1750。
     * 仍是「一个明显的峰」，但不再是 3925 —— 而 19300 token 一次到达
     * 本来就是「整段重放」，不该被当成实时生成。
     */
    expect(peak, `峰值 ${peak.toFixed(0)} tok/s`).toBeLessThan(2_100);
    expect(TPS_METER_CONSTANTS.maxIntervalRate).toBe(3_000);
  });

  it("**正常的单拍小 delta 仍按点冲激计入**（上限不该把日常读数吃掉）", () => {
    const meter = createTpsMeter();
    meter.push(20, base, base);
    expect(meter.reading(base + 100), "20 token 一拍要能被看见").toBeGreaterThan(3);
    expect(meter.active(base + 100), "两级都该判为活跃").toBe(true);
  });
});
