/**
 * **折线图几何**的单测（2026-11-12，第 3 步；2026-11-13 加平滑曲线）。
 *
 * 钉住四件事：
 * 1. 纵轴最大值取整到「一眼能读」的数（47 → 50，不是 47）；
 * 2. 点序 → 像素坐标：首尾贴边、只有 1 点时居中、越界值被夹住；
 * 3. **平滑曲线不过冲**：数据里的峰值就是曲线的峰值（用户要「不要突然上升突然下降」，
 *    但也不能把假尖峰再画大）；
 * 4. path 形状：`M` 开头、多点时用 `C`（三次贝塞尔）连接、填充闭合到基线。
 */
import { describe, expect, it } from "vitest";

import { axisTicks, buildGeometry, niceMax } from "../../src/client/chart-geometry";

/** 从 path 里取出所有坐标（控制点与端点都算）。 */
function pathPoints(d: string): { x: number; y: number }[] {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index]!, y: numbers[index + 1]! });
  }
  return points;
}

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

  it("0 或负值给一个最小量程", () => {
    expect(niceMax(0)).toBe(10);
    expect(niceMax(-5)).toBe(10);
    expect(niceMax(Number.NaN)).toBe(10);
  });

  it("刻度从 0 到 max，两端都含", () => {
    expect(axisTicks(50, 2)).toEqual([0, 25, 50]);
    expect(axisTicks(10, 1)).toEqual([0, 10]);
  });

  it("**刻度一律是整数**（用户要求不要小数；除不尽就取整并去重）", () => {
    for (const max of [50, 100, 200, 500, 1_000, 3, 7]) {
      for (const count of [2, 3, 4]) {
        const ticks = axisTicks(max, count);
        expect(ticks.at(-1), "顶端必须是 max").toBe(max);
        for (const tick of ticks) expect(Number.isInteger(tick), `${tick} 不是整数`).toBe(true);
        // 升序、无重复。
        for (let index = 1; index < ticks.length; index += 1) {
          expect(ticks[index]!).toBeGreaterThan(ticks[index - 1]!);
        }
      }
    }
  });

  it("**量程也是整数**：2.5 这种「数学上漂亮」的数也取整", () => {
    // 峰值 2.4 → 阶梯里落进 2.5 档 → 取整成 3（不是 2.5）。
    expect(niceMax(2.4)).toBe(3);
    // 峰值 0.9 → 1（不是 0）。
    expect(niceMax(0.9)).toBe(1);
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

  it("点数 = 序列长度，坐标带两位小数", () => {
    const geometry = buildGeometry([0, 1, 2, 3], { width: 90, height: 30, max: 10 });
    expect(geometry.points).toHaveLength(4);
    for (const point of geometry.points) {
      expect(point.x).toBe(Math.round(point.x * 100) / 100);
      expect(point.y).toBe(Math.round(point.y * 100) / 100);
    }
  });
});

describe("平滑曲线", () => {
  it("**多点时用贝塞尔 `C`，不是折线 `L`**（用户要「不要折线」）", () => {
    const geometry = buildGeometry([0, 4, 8, 2, 0], { width: 100, height: 40, max: 10 });
    expect(geometry.line.startsWith("M")).toBe(true);
    expect(geometry.line).toContain("C");
    expect(geometry.line).not.toMatch(/(^|\s)L/);
  });

  it("**不过冲**：曲线的控制点不越过数据里的峰值与谷值", () => {
    /*
     * 「长时间 0 → 一段很高 → 又回 0」是最容易出现假尖峰的形状。
     * 保形处理后，所有控制点都必须落在 [0, 峰值] 对应的像素区间内。
     */
    const values = [0, 0, 0, 10, 10, 0, 0, 0];
    const geometry = buildGeometry(values, { width: 140, height: 40, max: 10 });
    const all = pathPoints(geometry.line);
    const minY = Math.min(...all.map((point) => point.y));
    const maxY = Math.max(...all.map((point) => point.y));
    // 峰值 10 → y=0；0 → y=40。控制点不得超出 [0, 40]。
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeLessThanOrEqual(40);
  });

  it("**斜坡上不会冲过端点**（单调数据保持单调）", () => {
    const geometry = buildGeometry([0, 2, 4, 6, 8, 10], { width: 100, height: 40, max: 10 });
    const all = pathPoints(geometry.line);
    // y 随值增大而减小：所有点（含控制点）必须落在 [0, 40]。
    expect(Math.min(...all.map((point) => point.y))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...all.map((point) => point.y))).toBeLessThanOrEqual(40);
  });

  it("**两点仍用直线**（贝塞尔会退化成直线，没必要引入控制点）", () => {
    const geometry = buildGeometry([0, 10], { width: 100, height: 40, max: 10 });
    expect(geometry.line).toContain("L");
    expect(geometry.line).not.toContain("C");
  });

  it("填充闭合到基线 `Z`，且以折线 path 开头", () => {
    const geometry = buildGeometry([0, 5, 3], { width: 100, height: 40, max: 10 });
    expect(geometry.area.endsWith("Z")).toBe(true);
    expect(geometry.area.startsWith(geometry.line)).toBe(true);
  });

  it("空序列给空 path（调用方据此跳过绘制）", () => {
    expect(buildGeometry([], { width: 100, height: 40, max: 10 }).line).toBe("");
  });
});
