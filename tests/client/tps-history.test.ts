import { describe, expect, it } from "vitest";

import { createTpsHistory } from "../../src/client/tps-history";

describe("实时曲线", () => {
  it("空闲范围两端均为零", () => {
    const history = createTpsHistory();
    expect(history.view(10_500, 3)).toMatchObject({
      summary: { latest: 0, average: 0, peak: 0 },
    });
    expect(history.view(10_500, 3).points.at(-1)).toEqual({ at: 10_500, value: 0 });
  });

  it("没有新读数时，挂起的空档不会继承上一次速度", () => {
    const history = createTpsHistory();
    history.record(10_000, 80);
    history.record(15_000, 0);
    const { summary, points } = history.view(15_000, 5);
    expect(summary).toEqual({ latest: 0, average: 3.2, peak: 80 });
    expect(points).toContainEqual({ at: 12_000, value: 0 });
  });

  it("在滚动边界截断时间权重，清理五分钟前的采样", () => {
    const history = createTpsHistory();
    history.record(1_000, 60);
    history.record(1_100, 0);
    expect(history.view(2_050, 1).summary.average).toBe(3);
    history.record(302_000, 0);
    expect(history.view(302_000, 300).summary.peak).toBe(0);
  });
});
