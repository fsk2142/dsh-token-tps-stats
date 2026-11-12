/**
 * **折线图几何**的单测（2026-11-12，第 3 步）。
 *
 * 钉住三件事：
 * 1. 纵轴最大值取整到「一眼能读」的数（47 → 50，不是 47）；
 * 2. 点序 → 像素坐标：首尾贴边、只有 1 点时居中、越界值被夹住；
 * 3. path 字符串的形状（`M` 开头、点用 `L` 连、填充闭合到基线）。
 */
import { describe, expect, it } from "vitest";

import { axisTicks, buildGeometry, niceMax } from "../../src/client/chart-geometry";

describe("纵轴：取整到可读的数", () => {
  it("47 → 50（不是 47 这种读不顺的数）", () => {
    expect(niceMax(47)).toBe(50);
  });

  it("11 → 20", () => {
    expect(niceMax(11)).toBe(20);
  });

  it("3.4 → 5", () => {
    expect(niceMax(3.4)).toBe(5);
  });

  it("100 → 100（正好整除时不再放大一档）", () => {
    expect(niceMax(100)).toBe(100);
  });

  it("0 或负值给一个最小量程（避免除零、也避免纵轴塌成一条线）", () => {
    expect(niceMax(0)).toBe(10);
    expect(niceMax(-5)).toBe(10);
    expect(niceMax(Number.NaN)).toBe(10);
  });

  it("刻度从 0 到 max，两端都含", () => {
    expect(axisTicks(50, 2)).toEqual([0, 25, 50]);
    expect(axisTicks(10, 1)).toEqual([0, 10]);
  });
});

describe("几何：点序 → 像素坐标", () => {
  it("**首尾贴边**（最旧在 x=0、最新在 x=width）", () => {
    const geometry = buildGeometry([0, 5, 10], { width: 100, height: 40, max: 10 });
    expect(geometry.points[0]).toEqual({ x: 0, y: 40 });
    expect(geometry.points[2]).toEqual({ x: 100, y: 0 });
  });

  it("**只有 1 个点时居中**（否则会被画在左边缘，像被截断）", () => {
    const geometry = buildGeometry([5], { width: 100, height: 40, max: 10 });
    expect(geometry.points).toHaveLength(1);
    expect(geometry.points[0]!.x).toBe(50);
  });

  it("**越界值被夹住**（浮点误差或负值不该画出格）", () => {
    const geometry = buildGeometry([-5, 20], { width: 100, height: 40, max: 10 });
    expect(geometry.points[0]!.y).toBe(40);
    expect(geometry.points[1]!.y).toBe(0);
  });

  it("`max <= 0` 时退回最小量程，不除零", () => {
    const geometry = buildGeometry([1, 2], { width: 100, height: 40, max: 0 });
    for (const point of geometry.points) {
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("path：`M` 开头、后续点用 `L`；填充闭合到基线 `Z`", () => {
    const geometry = buildGeometry([0, 5], { width: 100, height: 40, max: 10 });
    expect(geometry.line.startsWith("M")).toBe(true);
    expect(geometry.line).toContain("L");
    expect(geometry.area.endsWith("Z")).toBe(true);
    expect(geometry.area.startsWith(geometry.line)).toBe(true);
  });

  it("空序列给空 path（调用方据此跳过绘制）", () => {
    expect(buildGeometry([], { width: 100, height: 40, max: 10 }).line).toBe("");
  });

  it("点数 = 序列长度，坐标带两位小数（不吐一长串浮点尾数）", () => {
    const geometry = buildGeometry([0, 1, 2, 3], { width: 90, height: 30, max: 10 });
    expect(geometry.points).toHaveLength(4);
    for (const point of geometry.points) {
      expect(point.x).toBe(Math.round(point.x * 100) / 100);
      expect(point.y).toBe(Math.round(point.y * 100) / 100);
    }
  });
});
