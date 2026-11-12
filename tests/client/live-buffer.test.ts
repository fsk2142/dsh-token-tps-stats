/**
 * 帧缓冲的单测（2026-11-13）。
 *
 * 钉住三件事：
 * 1. **一个宏任务一批**：同一任务里的帧攒起来一次性排空（积压 flush 才有机会摊开）；
 * 2. **空转纪律**：没有帧时不排空、不回调；排空后定时器状态清空；
 * 3. **清理**：`dispose` 之后到的帧直接丢弃，已安排的任务被取消。
 */
import { describe, expect, it } from "vitest";

import { createLiveBuffer, type FlushedFrame } from "../../src/client/live-buffer";

/** 一个手动驱动的调度器（测试里不真的等定时器）。 */
function harness() {
  const runs: (() => void)[] = [];
  const flushed: FlushedFrame[][] = [];
  const buffer = createLiveBuffer(
    (frames) => flushed.push([...frames]),
    (run) => {
      runs.push(run);
      return runs.length;
    },
    () => {
      runs.length = 0;
    },
  );
  /** 执行所有已安排的任务（模拟「一个宏任务结束后」）。 */
  const tick = (): void => {
    while (runs.length > 0) runs.shift()!();
  };
  return { buffer, flushed, tick, runs };
}

describe("批处理", () => {
  it("**同一批的帧只排空一次**，且顺序保持到达顺序", () => {
    const { buffer, flushed, tick, runs } = harness();
    buffer.push({ host: 1_000, arrival: 5_000, text: "a" });
    buffer.push({ host: 1_030, arrival: 5_000, text: "b" });
    expect(runs).toHaveLength(1);
    expect(flushed).toHaveLength(0);
    tick();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.map((frame) => frame.text)).toEqual(["a", "b"]);
  });

  it("排空时按宿主时间差铺开（最后一帧落在「现在」）", () => {
    const { buffer, flushed, tick } = harness();
    buffer.push({ host: 1_000, arrival: 5_000, text: "a" });
    buffer.push({ host: 1_030, arrival: 5_000, text: "b" });
    tick();
    const frames = flushed[0]!;
    expect(frames[1]!.at - frames[0]!.at).toBe(30);
  });

  it("**下一批是新的一次排空**（不会和上一批混在一起）", () => {
    const { buffer, flushed, tick } = harness();
    buffer.push({ host: 1_000, arrival: 5_000, text: "a" });
    tick();
    buffer.push({ host: 1_100, arrival: 6_000, text: "b" });
    tick();
    expect(flushed).toHaveLength(2);
    expect(flushed[1]![0]!.text).toBe("b");
  });

  it("**没有帧就不排空**：`push` 之前定时器列表是空的", () => {
    const { runs, tick } = harness();
    tick();
    expect(runs).toHaveLength(0);
  });
});

describe("清理", () => {
  it("`dispose` 之后到的帧被丢弃，不再回调", () => {
    const { buffer, flushed, tick } = harness();
    buffer.push({ host: 1_000, arrival: 5_000, text: "a" });
    buffer.dispose();
    tick();
    expect(flushed).toHaveLength(0);
    buffer.push({ host: 1_030, arrival: 5_000, text: "b" });
    tick();
    expect(flushed).toHaveLength(0);
  });
});
