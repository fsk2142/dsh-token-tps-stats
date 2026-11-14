import { describe, expect, it } from "vitest";

import { axisScale, buildGeometry } from "../../src/client/chart-geometry";

/**
 * 纵轴的**生产路径**是 `axisScale`（`niceMax` / `axisTicks` 是重写后遗留的
 * 孤儿 API，生产代码 0 调用）。这里测的是**真正在用的那一条**。
 */
describe("纵轴（生产路径 axisScale）", () => {
  it("**108 → 0/50/100/150**（用户点名的例子）", () => {
    const scale = axisScale(108);
    expect(scale.max).toBe(150);
    expect(scale.ticks).toEqual([0, 50, 100, 150]);
  });

  it("峰值 <= 50 时最小量程是 0/50（空图表也不换刻度）", () => {
    expect(axisScale(0).ticks).toEqual([0, 50]);
    expect(axisScale(50).ticks).toEqual([0, 50]);
  });

  it("**刻度一律是 50 的整数倍**", () => {
    for (const peak of [1, 51, 108, 199, 250, 251, 400, 1_000]) {
      const scale = axisScale(peak);
      for (const tick of scale.ticks) expect(tick % 50).toBe(0);
    }
  });

  it("刻度从 0 开始、到 max 结束，且是等差数列", () => {
    const scale = axisScale(400);
    expect(scale.ticks[0]).toBe(0);
    expect(scale.ticks.at(-1)).toBe(scale.max);
    expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < scale.ticks.length; index += 1) {
      expect(scale.ticks[index]! - scale.ticks[index - 1]!).toBe(scale.step);
    }
  });

  it("**量程与刻度都是整数**（不出现 2.5 这种伪精度）", () => {
    for (const peak of [33.3, 108.7, 1_234.56]) {
      const scale = axisScale(peak);
      expect(Number.isInteger(scale.max)).toBe(true);
      expect(Number.isInteger(scale.step)).toBe(true);
      for (const tick of scale.ticks) expect(Number.isInteger(tick)).toBe(true);
    }
  });

  it("峰值很大时格宽放大，但段数不超过上限", () => {
    const scale = axisScale(50_000);
    expect(scale.ticks.length).toBeLessThanOrEqual(7);
  });

  it("**峰值就落在曲线顶点上**（max ≥ peak，不改写数据）", () => {
    for (const peak of [51, 108, 250, 999]) {
      expect(axisScale(peak).max).toBeGreaterThanOrEqual(peak);
    }
  });
});

describe("几何：按真实时刻定位（不均间隔）", () => {
  it("**给了 positions 就按它取 x**（折线时间轴按实际时刻绘制）", () => {
    const geometry = buildGeometry([10, 20, 30], {
      width: 100,
      height: 50,
      max: 50,
      positions: [0, 0.25, 1],
    });
    expect(geometry.points[0]!.x).toBe(0);
    expect(geometry.points[1]!.x).toBe(25);
    expect(geometry.points[2]!.x).toBe(100);
  });

  it("不给 positions 就等距（兼容等间隔序列）", () => {
    const geometry = buildGeometry([10, 20, 30], { width: 100, height: 50, max: 50 });
    expect(geometry.points.map((point) => point.x)).toEqual([0, 50, 100]);
  });

  it("positions 越界会被夹到 [0,1]（浮点误差不该画出格）", () => {
    const geometry = buildGeometry([10, 20], { width: 100, height: 50, max: 50, positions: [-0.5, 1.5] });
    expect(geometry.points[0]!.x).toBe(0);
    expect(geometry.points[1]!.x).toBe(100);
  });
});
