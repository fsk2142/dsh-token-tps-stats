/**
 * **弹层开关状态**的单测（2026-11-12，第 3 步）。
 *
 * 这个模块没有 UI，但它是「点胶囊 → 弹层出现 → 点外面/Esc 关掉」这条链路的
 * 全部状态机，所以边界要钉住：关闭时不留下一次的位置、换时长不动开关、
 * 胶囊元素注销后读不到矩形。
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { SessionStream } from "../../src/client/session-store";

import {
  closeChart,
  getChartState,
  readPillRect,
  resetChartStateForTests,
  setChartSeconds,
  setChartSteps,
  setChartTab,
  setPillElement,
  subscribeChart,
  toggleChart,
  type ChartAnchor,
} from "../../src/client/chart-store";

/** 一个假的胶囊矩形。 */
const anchor: ChartAnchor = { left: 100, top: 200, right: 260, bottom: 220 };

/** 一个假的会话状态（本用例只关心「弹层记不记得看的是谁」）。 */
const stream = { sessionKey: "s1" } as unknown as SessionStream;

beforeEach(() => {
  resetChartStateForTests();
});

describe("弹层开关", () => {
  it("初始是关闭的（插件装好后不该凭空冒出一张图）", () => {
    expect(getChartState().open).toBe(false);
  });

  it("点胶囊打开，并记下锚点与**所属会话**", () => {
    toggleChart(anchor, stream);
    expect(getChartState().open).toBe(true);
    expect(getChartState().anchor).toEqual(anchor);
    expect(getChartState().stream).toBe(stream);
  });

  it("再点一次关掉，**并且把锚点与所属会话清掉**（否则下次打开前一帧会用旧数据）", () => {
    toggleChart(anchor, stream);
    toggleChart(anchor);
    expect(getChartState().open).toBe(false);
    expect(getChartState().anchor).toBeUndefined();
    expect(getChartState().stream).toBeUndefined();
  });

  it("`closeChart` 是幂等的（已经关着时不再通知订阅者）", () => {
    let calls = 0;
    subscribeChart(() => {
      calls += 1;
    });
    closeChart();
    expect(calls).toBe(0);
    toggleChart(anchor);
    expect(calls).toBe(1);
    closeChart();
    expect(calls).toBe(2);
    closeChart();
    expect(calls).toBe(2);
  });

  it("换时长不改开关状态", () => {
    toggleChart(anchor);
    setChartSeconds(300);
    expect(getChartState().open).toBe(true);
    expect(getChartState().seconds).toBe(300);
  });

  it("设成同一个时长不触发通知", () => {
    let calls = 0;
    subscribeChart(() => {
      calls += 1;
    });
    setChartSeconds(60);
    expect(calls).toBe(0);
    setChartSeconds(180);
    expect(calls).toBe(1);
  });

  it("**换步数档也不改开关状态**，且设成同一档不通知", () => {
    toggleChart(anchor);
    let calls = 0;
    subscribeChart(() => {
      calls += 1;
    });
    expect(getChartState().steps).toBe(5);
    setChartSteps(5);
    expect(calls).toBe(0);
    setChartSteps(20);
    expect(calls).toBe(1);
    expect(getChartState().open).toBe(true);
    expect(getChartState().steps).toBe(20);
  });

  it("时长与步数档**互不覆盖**（关掉再开都还在）", () => {
    toggleChart(anchor);
    setChartSeconds(300);
    setChartSteps(10);
    toggleChart(anchor);
    toggleChart(anchor, stream);
    expect(getChartState().seconds).toBe(300);
    expect(getChartState().steps).toBe(10);
  });

  it("**左上角页签默认是实时速度**，切到每步平均不关窗", () => {
    toggleChart(anchor);
    expect(getChartState().tab).toBe("time");
    setChartTab("steps");
    expect(getChartState().open).toBe(true);
    expect(getChartState().tab).toBe("steps");
  });

  it("切到同一个页签不通知；切一次只通知一次", () => {
    let calls = 0;
    subscribeChart(() => {
      calls += 1;
    });
    setChartTab("time");
    expect(calls).toBe(0);
    setChartTab("steps");
    expect(calls).toBe(1);
  });

  it("**关掉再开页签还在**（用户切过的视图不该被重置）", () => {
    toggleChart(anchor);
    setChartTab("steps");
    closeChart();
    toggleChart(anchor, stream);
    expect(getChartState().tab).toBe("steps");
  });

  it("两个页签的档位**各自记忆**，互不覆盖", () => {
    toggleChart(anchor);
    setChartTab("time");
    setChartSeconds(60);
    setChartSteps(20);
    setChartTab("steps");
    setChartSeconds(300);
    expect(getChartState().steps).toBe(20);
    setChartTab("time");
    expect(getChartState().seconds).toBe(300);
  });
});

describe("胶囊元素 → 锚点", () => {
  it("登记过元素就能读到它的**当前**矩形（滚动后位置会变，所以每次现读）", () => {
    let rect: ChartAnchor = anchor;
    setPillElement({ getBoundingClientRect: () => rect });
    rect = { left: 120, top: 240, right: 280, bottom: 260 };
    expect(readPillRect()).toEqual({ left: 120, top: 240, right: 280, bottom: 260 });
  });

  it("注销后读不到（返回 undefined，弹层退回快照/贴角）", () => {
    setPillElement({ getBoundingClientRect: () => anchor });
    setPillElement(undefined);
    expect(readPillRect()).toBeUndefined();
  });

  it("元素已经不在文档里、读矩形抛错时也不崩（当作没有）", () => {
    setPillElement({
      getBoundingClientRect: () => {
        throw new Error("detached");
      },
    });
    expect(readPillRect()).toBeUndefined();
  });
});
