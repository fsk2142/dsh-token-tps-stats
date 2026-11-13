/** 实时速度胶囊及当前会话的订阅生命周期。 */

import { createElement, useEffect, useRef, useState, type ReactElement } from "react";

import { closeChart, getChartState, setPillElement, subscribeChart, toggleChart, type ChartAnchor } from "./chart-store";
import { formatRate } from "./format";
import { pillAriaOf, pillLabelOf } from "./label";
import type { SessionEventSourceFor } from "./session-events";
import { createSessionStream, observeSessionSpeed, pushNodes, pushSnapshot, resetSnapshotBaseline } from "./session-store";
import { TYPO } from "./styles";

export { formatRate };

/** 胶囊的标记属性（弹层用它判断「点的是不是胶囊」）。 */
const PILL_ATTRIBUTE = "data-token-tps-pill";

/**
 * 登记胶囊元素进状态仓库（`ref` 回调）。
 *
 * 必须是**模块级常量**：写在内联箭头函数里，每次渲染都是新引用，
 * React 会先 `ref(null)` 再 `ref(node)` —— 中间那一瞬仓库里是空引用，
 * 弹层若正好在这一帧重画，位置就丢了。
 * @param element - React 给的 DOM 元素；卸载时是 `null`。
 */
function registerPillElement(element: unknown): void {
  if (element === null || element === undefined) {
    setPillElement(undefined);
    return;
  }
  const candidate = element as { getBoundingClientRect?: () => ChartAnchor };
  setPillElement(typeof candidate.getBoundingClientRect === "function" ? candidate as { getBoundingClientRect(): ChartAnchor } : undefined);
}

/**
 * 胶囊拿得到的槽位属性（**只声明我们用到的两个**）。
 *
 * 宿主对所有 `scope: "session"` 的槽位都会提供这一批标准属性，
 * 但我们不 `require` 宿主包（那是私有 API）—— 所以按鸭子类型只写这两个。
 */
export interface TpsPillProps {
  /** 读当前会话的聊天快照（官方胶囊同款选择器钩子）。 */
  readonly useChat?: unknown;
  /** 当前会话 id。 */
  readonly sessionId?: unknown;
  readonly tpsEventSourceFor?: SessionEventSourceFor;
}

/** 与官方 `.pill` 对齐的内联样式。 */
const PILL_STYLE = {
  boxSizing: "border-box",
  borderRadius: "var(--dsw-radius-sm)",
  maxWidth: "100%",
  color: "var(--dsw-alias-label-tertiary)",
  font: "inherit",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "inherit",
  whiteSpace: "nowrap",
  background: "0 0",
  border: "none",
  alignItems: "center",
  gap: "6px",
  padding: "1px 8px",
  display: "inline-flex",
  cursor: "pointer",
} as const;

/** 与官方 `.anchor` 对齐的外壳样式（字号与行高来自共享排版，理由见 `styles.ts`）。 */
const ANCHOR_STYLE = {
  minWidth: "0",
  fontFamily: TYPO.fontFamily,
  fontSize: TYPO.fontSize,
  lineHeight: TYPO.lineHeight,
  display: "inline-flex",
} as const;

/**
 * 仪表盘图标。
 *
 * ## 为什么用官方的路径数据（2026-11-12 用户反馈「有点小、对比官方不太好看」）
 *
 * 第一版我自己画了「一条上弧 + 一枚指针」，但缺了圆心那个**实心点**、`strokeWidth`
 * 也比官方粗，小尺寸下糊成一团。现在逐字采用宿主图标集里 `gauge-outline` 的几何：
 * `viewBox 0 0 16 16`、`stroke-width: 1`、三段 path（外弧 + 指针 + 圆心实心点）。
 *
 * 尺寸仍由外层样式决定（官方 `.pill svg { width:14px; height:14px }`）。
 * @returns SVG 元素。
 */
function GaugeIcon(): ReactElement {
  return createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": "true",
      focusable: "false",
      style: { flex: "none", width: "14px", height: "14px" },
    },
    // 外弧
    createElement("path", {
      d: "M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096",
      stroke: "currentColor",
      strokeWidth: 1,
    }),
    // 指针
    createElement("path", {
      d: "M8 8.49994L11.6114 4.88855",
      stroke: "currentColor",
      strokeWidth: 1,
    }),
    // 圆心（实心）
    createElement("path", {
      d: "M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z",
      fill: "currentColor",
    }),
  );
}

/**
 * 实时速度胶囊。**始终渲染**（空闲时显示 `0 tok/s`），点击打开折线图。
 * @param props - 槽位标准属性（只用 `useChat` 与 `sessionId`）。
 * @returns 元素。
 */
export function TpsPill(props: TpsPillProps = {}): unknown {
  // Give each session its own effects, baseline and history, even if DSH reuses the slot.
  const sessionKey = typeof props.sessionId === "string" ? props.sessionId : undefined;
  return createElement(SessionPill, { ...props, key: sessionKey, sessionKey });
}

function SessionPill(props: TpsPillProps & { sessionKey?: string }): unknown {
  const { sessionKey } = props;
  const [entry] = useState(() => createSessionStream(sessionKey));
  const [value, setValue] = useState(0);
  const [expanded, setExpanded] = useState(() => getChartState().open);
  const label = pillLabelOf(value, formatRate);
  type ChatSnapshot = { legacy?: { partial?: unknown; nodes?: unknown } };
  const useChat = typeof props.useChat === "function"
    ? props.useChat as (selector: (snapshot: ChatSnapshot) => unknown) => unknown
    : undefined;
  const partial = useChat?.((snapshot) => snapshot?.legacy?.partial);
  const nodes = useChat?.((snapshot) => snapshot?.legacy?.nodes);
  /*
   * **把事件源解析函数钉在 ref 里**（2026-11-13）。
   *
   * `tpsEventSourceFor` 来自 `slots.register` 的 `inject:` 工厂 —— 那是宿主用来
   * 算 props 的，**每次渲染都可能返回新对象**。如果把它直接放进 useEffect 的
   * 依赖表，那个建立订阅的 effect 会随每次渲染拆掉重建：订阅被反复取消/重建，
   * 定时器也跟着停停启启。
   *
   * 用 ref 存一份「最新」，effect 只依赖会话 id —— 订阅只建立一次。
   */
  const sourceFor = useRef(props.tpsEventSourceFor);
  sourceFor.current = props.tpsEventSourceFor;

  useEffect(() => {
    let source;
    try {
      source = sessionKey === undefined ? undefined : sourceFor.current?.(sessionKey);
    } catch (error: unknown) {
      console.debug("[dsh-token-tps-stats] session feed unavailable", error);
    }
    const stop = observeSessionSpeed(entry, source, setValue);
    const onVisibility = (): void => resetSnapshotBaseline(entry);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      if (getChartState().stream === entry) closeChart();
    };
    // 依赖里**不放** `tpsEventSourceFor`：它每次渲染都可能是新函数（理由见上）。
  }, [entry, sessionKey]);

  useEffect(() => {
    if (document.visibilityState === "hidden" && !entry.liveEvents) return;
    pushSnapshot(entry, partial, Date.now());
  }, [entry, partial]);

  useEffect(() => pushNodes(entry, nodes), [entry, nodes]);

  /** 订阅弹层的开关（只为了给按钮刷 `aria-expanded`）。 */
  useEffect(() => subscribeChart(() => setExpanded(getChartState().open)), []);

  /**
   * 胶囊自己的屏幕矩形（作为弹层的锚点）。
   *
   * 鸭子类型而不是 `instanceof Element`：理由见 `dom.d.ts` —— 只为一次取值引入
   * 一整套 DOM 类型不划算。宿主页面里的真实元素一定带 `getBoundingClientRect`。
   * @param event - 点击事件。
   * @returns 矩形；拿不到时 `undefined`（弹层退回贴左下角）。
   */
  const anchorOf = (event: { currentTarget: unknown }): ChartAnchor | undefined => {
    const element = event.currentTarget as { getBoundingClientRect?: () => ChartAnchor } | null;
    if (typeof element?.getBoundingClientRect !== "function") return undefined;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };

  return createElement(
    "span",
    { "data-composer-stat": "token-tps", style: ANCHOR_STYLE },
    createElement(
      "button",
      {
        type: "button",
        [PILL_ATTRIBUTE]: "",
        /*
         * 登记自己的 DOM 元素：弹层开着时用户滚动/拖窗口，胶囊位置会变，
         * 弹层每次重画都读一次**当前**矩形，跟着胶囊走而不是钉在旧位置。
         */
        ref: registerPillElement,
        style: PILL_STYLE,
        title: expanded ? "点击收起 TPS 变化曲线" : "点击查看 TPS 变化曲线",
        "aria-expanded": expanded,
        "aria-haspopup": "dialog",
        "aria-label": pillAriaOf(value, formatRate, expanded),
        onClick: (event: { currentTarget: unknown }) => toggleChart(anchorOf(event), entry),
      },
      GaugeIcon(),
      /*
       * 文案放在**一个**子节点里（`pill` 的 `gap: 6px` 只该隔开图标与文字；拆成
       * 多个兄弟节点会连字与字之间也插进 6px）。
       *
       * 三段布局（2026-11-13 用户反馈「速度变化时会不停改变整个胶囊宽度，导致所有
       * 胶囊位置变化，能不能固定一个宽度」）：前缀 + **定宽的数字** + 单位。
       * 官方那两个胶囊排在我们右边，我们一变宽它们就跟着被推来推去；所以数字占
       * 固定 `4ch`（等宽数字下容得下「1000」）并**右对齐**，外框纹丝不动。
       *
       * 工具调用阶段同样显示 `0 tok/s`（2026-11-13 用户改口：「工具调用的时候还是
       * 不要显示文字，还是显示 0 tok/s 吧」）—— 那一格只有「输出文本的速度」一个语义，
       * 插状态词会让它变含糊（见 `label.ts`）。
       */
      createElement(
        "span",
        { style: { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" } },
        label.prefix,
        createElement(
          "span",
          { style: { display: "inline-block", minWidth: "4ch", textAlign: "end" } },
          label.number,
        ),
        label.suffix,
      ),
    ),
  );
}

/** 兼容旧导出名（`install.ts` 用 `TpsPill`，测试用 `TpsPill`）。 */
export { TpsPill as TpsPillComponent };
