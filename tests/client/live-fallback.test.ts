import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionStream, liveChannelHealthy, observeSessionSpeed, pushSnapshot, resetSnapshotBaseline } from "../../src/client/session-store";
import type { SessionEventSource } from "../../src/client/session-events";

const start = 1_000_000;

/**
 * 造一个事件源替身。
 * @returns 源与「发布」函数。
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
   * 追加一批 live-chunk。
   * @param at - 事件时间。
   * @param text - 增量正文。
   */
  const publish = (at: number, text: string): void => {
    revision += 1;
    change = {
      kind: "append",
      entries: [
        { type: "transient", event: { type: "assistant/live-chunk", time: at, data: { chunk: { type: "text-delta", text } } } },
      ],
    };
    for (const listener of listeners) listener();
  };
  return { source, publish };
}

/**
 * 造一拍快照。
 * @param length - 累计正文字数。
 * @returns `legacy.partial` 形状。
 */
const snapshot = (length: number) => ({ turn: 1, step: 1, blocks: [{ kind: "text", text: "中".repeat(length) }] });

afterEach(() => vi.useRealTimers());

describe("实时速度的数据来源：live 与快照必须互为后备", () => {
  it("**订阅成功但一个事件都不来 → 快照兜底仍然出读数**（2026-11-13 修）", () => {
    /*
     * 重写后最危险的一处：`subscribe` 只要返回了函数就被当成「live 可用」，
     * 于是快照路径被永久禁用。若宿主此后一个 `assistant/live-chunk` 都不发，
     * 胶囊会永远停在 0，而「每步平均」照常有数 —— 正是用户报过的现象。
     *
     * 注意首拍按设计只建立基线（防止挂载瞬间把整段旧文本算成新字），
     * 所以这里推两拍：第二拍才有增量。
     */
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const session = createSessionStream("A");
    const { source } = eventSource();
    const stop = observeSessionSpeed(session, source, () => {});

    pushSnapshot(session, snapshot(10), start);
    pushSnapshot(session, snapshot(70), start + 200);
    vi.advanceTimersByTime(300);

    expect(liveChannelHealthy(session, Date.now()), "没有 live 事件 → 通道应判为不健康").toBe(false);
    expect(session.meter.reading(Date.now()), "订阅成功但无 live 事件时，快照必须仍然有效").toBeGreaterThan(0);
    stop();
  });

  it("**live 在供数时快照让位**（否则同一段字记两遍）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const session = createSessionStream("A");
    const { source, publish } = eventSource();
    const stop = observeSessionSpeed(session, source, () => {});

    publish(start, "中".repeat(60));
    vi.advanceTimersByTime(100);
    expect(liveChannelHealthy(session, Date.now())).toBe(true);

    // live 刚来过：这一拍快照不该再把同样的字记一遍。
    pushSnapshot(session, snapshot(10), Date.now());
    pushSnapshot(session, snapshot(70), Date.now());
    const liveOnly = session.meter.reading(Date.now());
    stop();

    // 只有 live 那一份（60 token）。若重复计数会明显超过 100。
    expect(liveOnly, `实测 ${liveOnly}`).toBeLessThan(100);
  });

  it("live 断供超过宽限后，快照重新接管", () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const session = createSessionStream("A");
    const { source, publish } = eventSource();
    const stop = observeSessionSpeed(session, source, () => {});

    publish(start, "中".repeat(20));
    vi.advanceTimersByTime(3_000);
    expect(liveChannelHealthy(session, Date.now())).toBe(false);

    pushSnapshot(session, snapshot(10), Date.now());
    pushSnapshot(session, snapshot(40), Date.now() + 100);
    expect(session.meter.reading(Date.now() + 200), "live 停了之后快照要接管").toBeGreaterThan(0);
    stop();
  });

  it("切回可见页清空基线，不会把暂停期间累计的字算成一次爆发", () => {
    const session = createSessionStream("A");
    pushSnapshot(session, snapshot(10), start);
    resetSnapshotBaseline(session);
    const pushed = pushSnapshot(session, snapshot(900), start + 60_000);
    expect(pushed, "基线被清空后，同一流的新快照不该整段计入").toBe(false);
  });
});
