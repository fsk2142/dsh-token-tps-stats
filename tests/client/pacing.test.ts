/**
 * 时间轴重排的单测（2026-11-13，修「峰值偶尔冲到 1000 多」）。
 *
 * 钉住四件事：
 * 1. **批尾对齐**：这一批的最后一帧落在「现在」，其余按宿主时间差往前推；
 * 2. **积压 flush 不再压成一瞬**：一分钟的字在 2ms 内到达，仍然被摊回那几十秒；
 * 3. **差值而不是绝对值**：宿主与本地时钟差多少都不影响间隔；
 * 4. 兜底：没有宿主时间戳、未来时刻、太久的过去，都不产出 NaN 或越界。
 */
import { describe, expect, it } from "vitest";

import { MAX_BACKDATE_MS, retimeBatch } from "../../src/client/pacing";

describe("批尾对齐", () => {
  it("**最新一帧落在 `endLocal`**，前面的帧按宿主时间差往前推", () => {
    // 宿主 1000/1030/1060 的三帧，本地在 5000 时一起排空。
    const times = retimeBatch(
      [
        { host: 1_000, arrival: 4_998 },
        { host: 1_030, arrival: 4_999 },
        { host: 1_060, arrival: 5_000 },
      ],
      5_000,
    );
    expect(times).toEqual([4_940, 4_970, 5_000]);
  });

  it("**顺序无关**：乱序传入也能对齐（按宿主时间差算，不看数组顺序）", () => {
    const times = retimeBatch(
      [
        { host: 1_060, arrival: 5_000 },
        { host: 1_000, arrival: 4_998 },
      ],
      5_000,
    );
    expect(times).toEqual([5_000, 4_940]);
  });

  it("单帧 → 就是 `endLocal`", () => {
    expect(retimeBatch([{ host: 42, arrival: 1 }], 9_000)).toEqual([9_000]);
  });

  it("空批 → 空结果", () => {
    expect(retimeBatch([], 1_000)).toEqual([]);
  });
});

describe("积压 flush：不再压成一瞬", () => {
    it("**宿主侧 60 秒的流、本地 2ms 内全到**：仍摊回那 60 秒", () => {
      /*
       * 场景：宿主每 50ms 一帧，共 1200 帧；本地因为主线程被占住，全部在 2ms 内收到。
       * 旧的「按到达时刻」会把 1200 帧压进 2ms → 读数爆表。
       * 现在最后一帧落在 `now`，每帧间隔 = 宿主间隔 50ms。
       */
      const items = Array.from({ length: 1_200 }, (_, index) => ({ host: index * 50, arrival: 10_000 }));
      const times = retimeBatch(items, 20_000);
      const gaps: number[] = [];
      for (let index = 1; index < times.length; index += 1) gaps.push(times[index]! - times[index - 1]!);
      expect(gaps.every((gap) => gap === 50), "每帧间隔必须是宿主间隔，不是 0").toBe(true);
      expect(times[0]!).toBe(20_000 - 1_199 * 50);
      expect(times.at(-1)!).toBe(20_000);
    });

    it("间隔不匀的批（p90 684ms 那种）也照样铺开", () => {
      const times = retimeBatch(
        [
          { host: 0, arrival: 7_000 },
          { host: 2, arrival: 7_000 },
          { host: 686, arrival: 7_001 },
          { host: 1_527, arrival: 7_001 },
        ],
        7_100,
      );
      expect(times).toEqual([5_573, 5_575, 6_259, 7_100]);
    });
  });

describe("差值而不是绝对值", () => {
  it("宿主比本地早 1000ms：间隔仍然按宿主差值走", () => {
    const times = retimeBatch(
      [
        { host: 10_000, arrival: 11_000 },
        { host: 10_030, arrival: 11_001 },
      ],
      12_000,
    );
    expect(times[1]! - times[0]!).toBe(30);
  });
});

describe("兜底", () => {
  it("**没有宿主时间戳** → 全部用到达时刻（旧宿主也能用）", () => {
    expect(
      retimeBatch(
        [
          { host: undefined, arrival: 100 },
          { host: Number.NaN, arrival: 200 },
        ],
        300,
      ),
    ).toEqual([100, 200]);
  });

  it("**不会跑到未来**：宿主时间戳超前也压到 `endLocal`", () => {
    const times = retimeBatch([{ host: 999_999, arrival: 1_000 }], 1_000);
    expect(times.every((at) => at !== null && at <= 1_000)).toBe(true);
  });

  it("**太旧的帧被丢弃，不是夹到下限**（夹住会造出一个人为的大 burst）", () => {
    /*
     * 两帧：老的那帧在 9 分钟前 —— 映射出来比 3 分钟更早，直接丢（`null`）。
     * 以前把它夹到 `endLocal - 3min`，于是「所有 3 分钟以前的帧」全堆在同一时刻，
     * 读数反而被顶到 992 tok/s（重放测试暴露的正是这条）。
     */
    const times = retimeBatch(
      [
        { host: -MAX_BACKDATE_MS * 3, arrival: 1_000 },
        { host: 0, arrival: 1_000 },
      ],
      1_000,
    );
    expect(times[0]).toBeNull();
    expect(times[1]).toBe(1_000);
  });

  it("刚好落在下限上的帧仍然保留（边界不丢数据）", () => {
    const times = retimeBatch(
      [
        { host: -MAX_BACKDATE_MS, arrival: 1_000 },
        { host: 0, arrival: 1_000 },
      ],
      1_000,
    );
    expect(times[0]).toBe(1_000 - MAX_BACKDATE_MS);
  });
});
