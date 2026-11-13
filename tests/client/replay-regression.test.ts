import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createTpsMeter } from "../../src/client/tps-meter";

const REPLAY_PATH = ".tmp/replay.json";

describe.skipIf(!existsSync(REPLAY_PATH))("真实流式时间线回放", () => {
  it("正常流式与带原始时间戳的积压保持在同一量级", () => {
    const replay = JSON.parse(readFileSync(REPLAY_PATH, "utf8")) as { frames: [number, number][] };
    const batches = new Map<number, number>();
    let elapsed = 0;
    for (const [dt, length] of replay.frames) {
      elapsed += dt;
      const at = Math.ceil(elapsed / 100) * 100;
      batches.set(at, (batches.get(at) ?? 0) + length / 4.2);
    }
    const normal = createTpsMeter();
    const blocked = createTpsMeter();
    let normalPeak = 0;
    let blockedPeak = 0;
    let compressedPeak = 0;
    let pending: [number, number][] = [];
    for (let at = 0; at <= elapsed; at += 100) {
      const tokens = batches.get(at) ?? 0;
      normal.push(tokens, at);
      normalPeak = Math.max(normalPeak, normal.reading(at));
      if (tokens > 0) pending.push([at, tokens]);
      if (at === 0 || at % 6_000 !== 0) continue;
      const compressed = createTpsMeter();
      compressed.push(pending.reduce((sum, [, count]) => sum + count, 0), at);
      compressedPeak = Math.max(compressedPeak, compressed.reading(at + 650));
      for (const [sourceTime, count] of pending) blocked.push(count, sourceTime, at);
      pending = [];
      blockedPeak = Math.max(blockedPeak, blocked.reading(at));
    }
    expect(normalPeak).toBeGreaterThan(90);
    expect(normalPeak).toBeLessThan(120);
    expect(blockedPeak).toBeGreaterThan(80);
    expect(blockedPeak).toBeLessThan(120);
    expect(compressedPeak).toBeGreaterThan(250);
  });
});
