/**
 * **折线图弹层的开关状态**（2026-11-12，第 3 步）。
 *
 * ## 为什么是一个模块级小仓库
 *
 * 点击发生在**胶囊**里（`conversation.composer.dock`），而弹层必须画在
 * **`shell.overlay`** 上 —— 那是宿主「横贯整帧的浮层，在所有列之上、也不在它们的
 * 滚动容器里」。两个组件挂在不同的槽位，不共享 React 树，所以只能通过一个模块级
 * 仓库交换「开没开、锚点在哪、看多长时间」。
 *
 * ## 为什么不放进胶囊组件自己的 state
 *
 * 弹层在另一个槽位、是另一个组件；胶囊的 state 传不过去。反过来把弹层塞进胶囊
 * 也不行 —— dock 在输入框下方、处在会滚动/被裁剪的容器里，浮层会被切掉。
 *
 * 仓库里只存**纯数据**（布尔 + 几个数字），不碰 React、不碰 DOM，可以单测。
 *
 * @module dsh-token-tps-stats/src/client/chart-store
 */

import { TPS_CHART_DEFAULT_SECONDS, type TpsChartRange } from "./tps-history";

/** 锚点：胶囊那一刻的屏幕矩形（只留摆弹层要用的四个边）。 */
export interface ChartAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 弹层状态。 */
export interface ChartState {
  /** 是否打开。 */
  readonly open: boolean;
  /** 打开时胶囊的位置；没有时弹层贴左下角（理论上不会发生）。 */
  readonly anchor: ChartAnchor | undefined;
  /** 展示时长（秒）。 */
  readonly seconds: TpsChartRange;
}

/** 初始状态：关闭、默认 1 分钟。 */
const INITIAL: ChartState = { open: false, anchor: undefined, seconds: TPS_CHART_DEFAULT_SECONDS };

/** 当前状态（模块级单例）。 */
let state: ChartState = INITIAL;

/**
 * 胶囊的 DOM 元素（由胶囊挂载时登记）。
 *
 * 为什么存元素而不只存打开那一刻的矩形：用户可能在弹层开着时**滚动**或拖动窗口，
 * 胶囊的位置会变。存着元素就能在每次重画时读一次**当前**矩形（读自己的元素是允许的），
 * 弹层跟着胶囊走，而不是钉在打开时的旧位置上。
 */
let pillElement: { getBoundingClientRect(): ChartAnchor } | undefined;

/**
 * 登记/注销胶囊元素。
 * @param element - 胶囊的 DOM 元素；`undefined` 表示卸载。
 */
export function setPillElement(element: { getBoundingClientRect(): ChartAnchor } | undefined): void {
  pillElement = element;
}

/**
 * 读胶囊**当前**的屏幕矩形。
 * @returns 矩形；胶囊还没挂上或已卸载时 `undefined`。
 */
export function readPillRect(): ChartAnchor | undefined {
  const element = pillElement;
  if (element === undefined) return undefined;
  try {
    return element.getBoundingClientRect();
  } catch {
    // 卸载后残留的引用可能已经不在文档里；读矩形抛错时当作没有。
    return undefined;
  }
}

/** 订阅者（弹层组件挂载时登记）。 */
const listeners = new Set<() => void>();

/**
 * 读当前状态（弹层每次渲染都读它）。
 * @returns 状态快照。
 */
export function getChartState(): ChartState {
  return state;
}

/** 通知订阅者状态变了。 */
function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 订阅状态变化。
 * @param listener - 回调。
 * @returns 取消订阅。
 */
export function subscribeChart(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 开/关弹层（点胶囊）。
 *
 * 关的时候顺手把锚点丢掉 —— 留着会让下次打开前的一帧（如果正好在渲染）用旧位置。
 * @param anchor - 胶囊当前的屏幕矩形；`undefined` 表示这次是关。
 */
export function toggleChart(anchor?: ChartAnchor): void {
  state = state.open
    ? { open: false, anchor: undefined, seconds: state.seconds }
    : { open: true, anchor, seconds: state.seconds };
  emit();
}

/**
 * 关掉弹层（Esc、点外面、点关闭按钮）。
 */
export function closeChart(): void {
  if (!state.open) return;
  state = { open: false, anchor: undefined, seconds: state.seconds };
  emit();
}

/**
 * 换展示时长（弹层底部的分段按钮）。
 * @param seconds - 60 或 180（受历史长度限制）。
 */
export function setChartSeconds(seconds: TpsChartRange): void {
  if (state.seconds === seconds) return;
  state = { ...state, seconds };
  emit();
}

/**
 * **仅供测试**：恢复初始状态并清空订阅者，避免用例之间互相污染。
 */
export function resetChartStateForTests(): void {
  state = INITIAL;
  pillElement = undefined;
  listeners.clear();
}
