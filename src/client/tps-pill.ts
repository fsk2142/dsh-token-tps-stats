/**
 * **实时 tok/s 的胶囊**（2026-11-12，第 2 步；第 3 步加「可点击」；
 * 2026-11-13 改成「每个会话一份」）。
 *
 * ## 放在哪
 *
 * 注册进 `conversation.composer.dock`，`order: -1` —— 官方那两个胶囊
 * （轮次/步数 = order 0、用量 = 1）排在右边，所以它出现在输入框底部那一行
 * 「92 轮 4018 步 · …」的**左边**。
 *
 * ## 数据从哪来（2026-11-13 用户反馈「怎么是全局的会话速度」）
 *
 * 这个槽位是 `scope: "session"`：宿主给使用者发的是**这个会话**的 `useChat`
 * 选择器和 `sessionId`。官方那两个胶囊就是这么读的，我们也只读这一步：
 *
 * ```
 * const partial = useChat((snapshot) => snapshot.legacy.partial);   // 正在生成的那一步
 * useEffect(() => pushSnapshot(entry, partial, Date.now()), [partial]);
 * ```
 *
 * 不再注册 `uiConversation.events` 的 Definition —— 那张注册表是**全局**的，
 * 每个会话都会把它拿去匹配自己那份事件流，累加器只能是一锅粥（详见
 * `session-store.ts` 与 `progress.ts` 的说明）。
 *
 * ## 样式为什么写成一串 CSS 变量的 calc（2026-11-12 用户实测反馈）
 *
 * 用户第一版看到的效果：**「字体和官方的不一致」**。根因是我只写了
 * `display/color/tabular-nums` 三个内联属性，**没有覆盖字号与行高** —— 于是它继承
 * 容器默认值，和旁边官方胶囊差一档。
 *
 * 官方胶囊的真实规则（`@deepseek-ai/dsh-client-ui-chat` 的 `StatsPills` 模块）：
 *
 * ```
 * .anchor { min-width:0; font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
 *           line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px)); display:inline-flex }
 * .pill   { border-radius:var(--dsw-radius-sm); color:var(--dsw-alias-label-tertiary);
 *           font:inherit; font-variant-numeric:tabular-nums; white-space:nowrap;
 *           background:0 0; border:none; align-items:center; gap:6px; padding:1px 8px; display:inline-flex }
 * .pill svg { flex:none; width:14px; height:14px }
 * ```
 *
 * 这里逐条照抄成内联样式（不引它的 CSS Module —— 那是宿主私有类名，换版本会变）。
 *
 * ## 为什么空闲时显示 0 而不是消失（用户明确要求）
 *
 * 用户原话：「完全没有会话动作的时候直接显示 0 tok/s 吧，不要消失」。
 *
 * ## 为什么定时器要能停也能重启
 *
 * 「指针回落」需要即使没有新事件也重算（每 100ms 一次）。但值已经是 0 之后就没必要
 * 再算了 —— 所以归零时**停表**，等下一拍数据（`pushSnapshot`）再重启。
 * 这样空闲时不会留一个每秒唤醒 10 次的主线程定时器。
 *
 * ## 第 3 步：点击打开折线图
 *
 * 用户要求：「这个胶囊可以点击，点击的时候显示一段折线图，反映一段时间内 tps 的变化」。
 *
 * 实现上分三块，各自独立可测：
 * - 本文件：胶囊本体（按钮语义 + 点击时把自己的屏幕矩形与**本会话的流**交给状态仓库）；
 * - `chart-store.ts`：模块级开关（胶囊和弹层不共享 React 树，只能这样交换数据）；
 * - `tps-chart.ts`：画在 `shell.overlay` 上的弹层（折线图 + 时长切换）。
 *
 * 弹层所在的 `shell.overlay` 是 `scope: root`，拿不到 `useChat`/`sessionId` ——
 * 所以「看哪个会话的曲线」必须由胶囊在打开时一起交过去，弹层自己推不出来。
 *
 * @module dsh-token-tps-stats/src/client/tps-pill
 */

import { createElement, useEffect, useState, type ReactElement } from "react";

import { getChartState, setPillElement, subscribeChart, toggleChart, type ChartAnchor } from "./chart-store";
import { formatRate } from "./format";
import { pillAriaOf, pillLabelOf } from "./label";
import { claimSessionStream, pushSnapshot, readingOf, releaseSessionStream, type SessionStream } from "./session-store";
import { TYPO } from "./styles";

export { formatRate };

/** 重渲染间隔（毫秒）：100ms 足够顺滑，又不至于像 60fps 那样白烧。 */
const TICK_MS = 100;

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
}

/** 与官方 `.pill` 逐条对齐的内联样式（理由见文件头）。 */
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
  const sessionKey = typeof props.sessionId === "string" ? props.sessionId : undefined;
  /*
   * 认领一份**属于这个会话**的状态。
   *
   * `useState` 的惰性初始化只在首次渲染跑一次：会话 id 变了 React 会给这个组件换 key
   * （槽位按 session 重建），所以这里不必处理「中途换 id」的情况；万一宿主没换 key，
   * 下面的 effect 会把状态重新认领一次（见依赖表）。
   */
  const [entry, setEntry] = useState<SessionStream>(() => claimSessionStream(sessionKey));

  /*
   * 读当前会话「正在生成的这一步」。
   *
   * `legacy.partial` 的形状是 `{ turn, step, blocks }`，`blocks` 里的文本是**累计**的
   * （宿主每来一帧就拼一次）。这里订阅的正是官方胶囊用的那份快照 —— 它只含**这个会话**
   * 的内容，所以不会再混进别的会话。
   *
   * 钩子必须无条件调用（React 的规则），所以先在本行取值，再在 effect 里推。
   */
  const useChat = props.useChat as ((selector: (snapshot: unknown) => unknown) => unknown) | undefined;
  const partial = typeof useChat === "function" ? useChat((snapshot) => (snapshot as { legacy?: { partial?: unknown } })?.legacy?.partial) : undefined;

  /*
   * 诊断：拿不到 `useChat` 就只会恒显示 0，必须在控制台留一句 ——
   * 否则「数字一直是 0」会被当成计算问题，实际是槽位属性没送到。
   */
  useEffect(() => {
    if (typeof useChat === "function") return;
    console.debug(
      "[dsh-token-tps-stats] tps pill: slot props have no useChat; the reading will stay 0 (session scope missing?)",
    );
  }, [useChat]);

  const [value, setValue] = useState<number>(() => readingOf(entry, Date.now()));
  const [expanded, setExpanded] = useState<boolean>(() => getChartState().open);
  /** 这次渲染要显示的三段文本（固定前缀 + 定宽数字 + 单位，见 `label.ts`）。 */
  const label = pillLabelOf(value, formatRate);

  /*
   * 会话换了（理论上宿主会给新 key，但这里仍兜一层）：换到新的那份状态，并把旧的还回去。
   */
  useEffect(() => {
    if (entry.sessionKey === sessionKey) return;
    const next = claimSessionStream(sessionKey);
    releaseSessionStream(entry);
    setEntry(next);
  }, [entry, sessionKey]);

  /*
   * 每一拍快照 → 差分 + 摊开 → 速度计与历史。
   *
   * 放在 effect 里而不是渲染中：渲染必须无副作用（StrictMode 下渲染会跑两次）。
   * 差分本身是幂等的 —— 同一份 `partial` 重复推一次，`newTextSince` 看到「文本没变长」
   * 就什么都不产出。
   *
   * **`partial` 为空时也要推**（不要在这里 `return`）：这一步结束时 `pushSnapshot`
   * 要把基线清掉（`sampledAt` 也推进），否则下一次同样的 turn/step 重试会被旧基线
   * 把整段累计文本算成「新到的字」。
   */
  useEffect(() => {
    pushSnapshot(entry, partial, Date.now());
    setValue(readingOf(entry, Date.now()));
  }, [entry, partial]);

  /*
   * 指针回落需要**没有新数据时也继续重算**（每 100ms 一次）；归零就停表。
   *
   * 依赖用 `[entry, active]` 而不是 `[entry, value]`：读出 47→48→49 这种变化时
   * 定时器不该被拆了重建（那会每 100ms 造一个定时器）。只在「有速度 ↔ 没速度」
   * 这条边界上启停。
   */
  const active = value > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setValue(readingOf(entry, Date.now()));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [entry, active]);

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
