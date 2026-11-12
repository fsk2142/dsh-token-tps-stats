/**
 * **折线图弹层**（2026-11-12，第 3 步）。
 *
 * ## 挂在哪、为什么不挂在胶囊里面
 *
 * 胶囊在 `conversation.composer.dock` —— 输入框下方、处在会滚动/被裁剪的容器里。
 * 把弹层画在那里，浮层会被那一行切掉（胶囊自己只有 20px 高）。所以弹层注册进
 * `shell.overlay`：宿主对它的描述是「横贯整帧的浮层，在所有列之上，也不在它们的
 * 滚动容器里」，正是浮层该待的地方。
 *
 * 两者不共享 React 树，只通过 {@link module:./chart-store} 交换「开没开 / 锚点 /
 * 时长」三个纯数据。
 *
 * ## 为什么弹层是 `position: fixed` + 每次重画都重算坐标
 *
 * `shell.overlay` 本身是个不占位的层。弹层摆在胶囊**正上方**（上方空间不够时摆到
 * 下方），坐标来自胶囊自己的 `getBoundingClientRect()`。弹层开着时用户可能滚动
 * 页面或拖动窗口，所以**每次重画都重新读一次**（读自己的元素是允许的；不是去读
 * 别人的 DOM 来「猜」排版）。
 *
 * ## 底色与字体（2026-11-12 用户实测反馈）
 *
 * 用户两条原话：「看到一个灰色底，希望能像官方那个胶囊一样用白色底」、
 * 「字体也要保持一致」。
 *
 * - **底色**：之前用的是 `--dsw-alias-bg-overlay` —— 那是**半透明**的浮层色，
 *   叠在聊天内容上必然发灰。现在用 `--dsw-alias-bg-base`（浅色主题就是纯白），
 *   再用宿主的 `--dsw-elevation-prominent` 阴影把卡片和背景分开，与宿主自己的
 *   菜单/浮窗同一套料。
 * - **字体**：字号/行高/字体族全部走 `styles.ts` 里那份与官方胶囊相同的排版
 *   （`--dsh-content-font-size-secondary` 等变量），不再写死 12px。
 *
 * ## 为什么空闲时也不留常驻定时器
 *
 * 弹层**只在打开时**注册 500ms 的刷新定时器（时间轴要随时间右移，即使没有新帧）。
 * 关掉立刻清掉 —— 与胶囊「归零停表」同一条纪律：不在用户看不见的地方空转。
 *
 * @module dsh-token-tps-stats/src/client/tps-chart
 */

import { createElement, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { axisTicks, buildGeometry, niceMax } from "./chart-geometry";
import { closeChart, getChartState, readPillRect, setChartSeconds, subscribeChart, type ChartAnchor } from "./chart-store";
import type { DshEvent } from "./dom";
import { formatRate } from "./format";
import { ACCENT, HAIRLINE, MUTED, SURFACE, TYPO } from "./styles";
import { historySeries, historySummary, TPS_CHART_RANGES, type TpsChartRange } from "./tps-history";
import { subscribeLive } from "./tps-pill";

/** 弹层宽度（像素）。 */
const PANEL_WIDTH = 344;

/** 弹层内边距（像素）：左右各 12px → 内容宽 320px。 */
const PANEL_PADDING_X = 12;

/** 绘图区宽度（SVG 单位，等于内容宽减去左边距）。 */
const PLOT_WIDTH = 284;

/** 绘图区高度（SVG 单位）。 */
const PLOT_HEIGHT = 92;

/** 绘图区左边距：给纵轴刻度标签留位。 */
const PLOT_LEFT = 32;

/** 绘图区上边距。 */
const PLOT_TOP = 8;

/** 整个 SVG 的 viewBox 宽（= 弹层内容宽，所以横向不会拉伸变形）。 */
const SVG_WIDTH = 320;

/** 整个 SVG 的 viewBox 高（含底部横轴标签）。 */
const SVG_HEIGHT = 118;

/** 弹层与胶囊之间的间距（像素）。 */
const PANEL_GAP = 8;

/** 弹层与视口边缘的最小距离（像素）。 */
const VIEWPORT_MARGIN = 8;

/** 弹层的大致高度（像素）：用于判断「上方放不下就放下面」。 */
const PANEL_ESTIMATED_HEIGHT = 190;

/** 弹层打开时的刷新间隔（毫秒）：时间轴在走，即使没有新帧也要重画。 */
const OPEN_TICK_MS = 500;

/** 胶囊的标记属性（与 `tps-pill.ts` 里的同名常量对应，见那里的说明）。 */
const PILL_ATTRIBUTE = "data-token-tps-pill";

/** 弹层根节点的标记属性（判断「点在弹层里」用）。 */
const PANEL_ATTRIBUTE = "data-token-tps-chart";

/** 弹层位置。 */
interface PanelPlacement {
  readonly left: number;
  readonly top: number;
  /** `true` = 摆在胶囊下方（上方放不下时）。 */
  readonly below: boolean;
}

/**
 * 计算弹层位置：优先胶囊正上方；上方空间不够就放到下方；最后夹在视口内。
 * @param anchor - 胶囊的屏幕矩形（打开那一刻取得）。
 * @returns 视口坐标下的位置。
 */
function panelPlacement(anchor: ChartAnchor | undefined): PanelPlacement {
  const innerWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const innerHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  if (anchor === undefined || innerWidth <= 0) {
    // 没有锚点（理论上不会发生）：贴左下角，至少可见、可用。
    return {
      left: VIEWPORT_MARGIN,
      top: Math.max(VIEWPORT_MARGIN, innerHeight - PANEL_ESTIMATED_HEIGHT),
      below: false,
    };
  }
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.left),
    Math.max(VIEWPORT_MARGIN, innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
  );
  const roomAbove = anchor.top;
  const below = roomAbove < PANEL_ESTIMATED_HEIGHT + VIEWPORT_MARGIN;
  return {
    left,
    top: below ? anchor.bottom + PANEL_GAP : anchor.top - PANEL_GAP,
    below,
  };
}

/**
 * 事件目标是否落在带某个标记属性的元素内。
 *
 * 用**鸭子类型**而不是 `instanceof Element`：`Element` 是全局名字，为它单开一份
 * 类型声明会连 `@types/node` 的同名声明一起搅进来（见 `dom.d.ts` 的说明）。
 * 这里只走 `parentNode` 链 + `hasAttribute`，宿主页面里的真实元素都满足。
 * @param target - 事件目标。
 * @param attribute - 标记属性名。
 * @returns 是则 `true`。
 */
function insideAttribute(target: unknown, attribute: string): boolean {
  let current = target as { parentNode?: unknown; hasAttribute?: (name: string) => boolean } | null;
  let guard = 0;
  while (current !== null && typeof current === "object" && guard < 64) {
    guard += 1;
    if (typeof current.hasAttribute === "function" && current.hasAttribute(attribute)) return true;
    current = current.parentNode as typeof current;
  }
  return false;
}

/** 分段按钮的样式（选中态用品牌色，与宿主的 segmented control 同观感）。 */
function rangeButtonStyle(active: boolean): Record<string, string | number> {
  return {
    border: `1px solid ${active ? ACCENT : HAIRLINE}`,
    background: "transparent",
    color: active ? ACCENT : MUTED,
    borderRadius: "6px",
    padding: "0 8px",
    height: "22px",
    fontFamily: "inherit",
    fontSize: "11px",
    lineHeight: "20px",
    cursor: "pointer",
  };
}

/**
 * 时长按钮的显示文案。
 * @param seconds - 时长（秒）。
 * @returns 文案。
 */
function rangeLabel(seconds: TpsChartRange): string {
  return seconds >= 180 ? "3 分钟" : "1 分钟";
}

/**
 * 折线图弹层本体。
 *
 * 关闭时返回 `null`（不占位、不注册任何监听）。
 * @returns 元素或 `null`。
 */
export function TpsChart(): unknown {
  const [state, setState] = useState(() => getChartState());
  /** 每次重画的触发器；读数据时再取最新的 `Date.now()`。 */
  const [, setTick] = useState(0);

  useEffect(() => subscribeChart(() => setState(getChartState())), []);

  useEffect(() => {
    if (!state.open) return;
    // 时间轴在走：即使没有新帧，曲线也要随时间右移。
    const timer = setInterval(() => setTick((tick) => tick + 1), OPEN_TICK_MS);
    // 有新帧时立刻重画，不必等下一次 tick。
    const offLive = subscribeLive(() => setTick((tick) => tick + 1));
    const onKey = (event: DshEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation?.();
      closeChart();
    };
    /*
     * 点弹层和胶囊**以外**的地方就关。
     *
     * 用 `pointerdown`（捕获阶段）而不是 `click`：胶囊自己的 `click` 会随后触发，
     * 两个都处理就会变成「先关再开」，看起来像点不动 —— 所以胶囊里的点击也被放过，
     * 由胶囊自己的 `click` 决定开还是关。
     */
    const onPointerDown = (event: DshEvent): void => {
      if (insideAttribute(event.target, PANEL_ATTRIBUTE)) return;
      if (insideAttribute(event.target, PILL_ATTRIBUTE)) return;
      closeChart();
    };
    // 视口变了，锚点就失效了：直接关，别让弹层飘在错的地方。
    const onResize = (): void => closeChart();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      clearInterval(timer);
      offLive();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [state.open]);

  if (!state.open) return null;
  /*
   * 位置每次重画都重新读：优先用仓库里登记的**胶囊当前矩形**（弹层开着时用户
   * 滚动页面或拖窗口，胶囊会动）；仓库里没有元素才退回打开时存下的那份快照。
   */
  return renderPanel(state.seconds, readPillRect() ?? state.anchor);
}

/**
 * 渲染弹层内容。
 * @param seconds - 展示时长。
 * @param anchor - 胶囊矩形。
 * @returns 元素。
 */
function renderPanel(seconds: TpsChartRange, anchor: ChartAnchor | undefined): ReactElement {
  const now = Date.now();
  const points = historySeries(now, seconds);
  const summary = historySummary(now, seconds);
  const max = niceMax(summary.peak);
  const geometry = buildGeometry(
    points.map((point) => point.value),
    { width: PLOT_WIDTH, height: PLOT_HEIGHT, max },
  );
  const placement = panelPlacement(anchor);
  const quiet = summary.peak < 0.5;

  return createElement(
    "div",
    {
      [PANEL_ATTRIBUTE]: "",
      role: "dialog",
      "aria-label": `实时输出速度（TPS）折线图，最近 ${rangeLabel(seconds)}`,
      style: {
        position: "fixed",
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        transform: placement.below ? "none" : "translateY(-100%)",
        width: `${PANEL_WIDTH}px`,
        boxSizing: "border-box",
        padding: `10px ${PANEL_PADDING_X}px 8px`,
        // 白色（浅色主题）不透明卡片 + 宿主浮层的 elevation；字体与官方胶囊同源。
        ...SURFACE,
        borderRadius: "12px",
        fontFamily: TYPO.fontFamily,
        fontSize: TYPO.fontSize,
        lineHeight: TYPO.lineHeight,
        fontVariantNumeric: TYPO.fontVariantNumeric,
        zIndex: 1,
      },
    },
    renderHeader(seconds, summary.latest, summary.average, summary.peak),
    renderChart({ geometry, max, quiet, seconds }),
    renderFooter(seconds),
  );
}

/**
 * 头部：标题 + 当前值 + 副标题（均值/峰值）+ 关闭按钮。
 * @param seconds - 展示时长。
 * @param latest - 最新一点。
 * @param average - 区间平均。
 * @param peak - 区间峰值。
 * @returns 元素。
 */
function renderHeader(seconds: TpsChartRange, latest: number, average: number, peak: number): ReactElement {
  return createElement(
    "div",
    { style: { display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "6px" } },
    createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0", flex: "1" } },
      createElement(
        "span",
        {
          style: {
            fontWeight: 600,
            fontSize: "13px",
            lineHeight: "18px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        `实时输出速度（TPS）· 最近 ${rangeLabel(seconds)}`,
      ),
      createElement(
        "span",
        { style: { color: MUTED, fontSize: "11px", lineHeight: "16px", whiteSpace: "nowrap" } },
        `当前 ${formatRate(latest)} tok/s · 平均 ${formatRate(average)} · 峰值 ${formatRate(peak)}`,
      ),
    ),
    createElement(
      "button",
      {
        type: "button",
        "aria-label": "关闭折线图",
        onClick: () => closeChart(),
        style: {
          flex: "none",
          border: "none",
          background: "transparent",
          color: MUTED,
          fontFamily: "inherit",
          fontSize: "15px",
          lineHeight: "18px",
          padding: "0 2px",
          cursor: "pointer",
        },
      },
      "×",
    ),
  );
}

/** 折线图参数。 */
interface ChartViewOptions {
  readonly geometry: ReturnType<typeof buildGeometry>;
  readonly max: number;
  readonly quiet: boolean;
  readonly seconds: TpsChartRange;
}

/**
 * 折线图本体（SVG + 空态提示）。
 * @param options - 几何 + 状态。
 * @returns 元素。
 */
function renderChart(options: ChartViewOptions): ReactElement {
  const { geometry, max, quiet, seconds } = options;
  const ticks = axisTicks(max, 2);
  const gridlines = ticks.map((tick, index) => {
    const y = PLOT_TOP + (PLOT_HEIGHT - (tick / max) * PLOT_HEIGHT);
    return createElement("line", {
      key: `grid-${index}`,
      x1: PLOT_LEFT,
      x2: PLOT_LEFT + PLOT_WIDTH,
      y1: y,
      y2: y,
      stroke: HAIRLINE,
      strokeWidth: 1,
      // 顶与底用实线、中间用虚线：有框架感但不抢戏。
      strokeDasharray: index === 0 || index === ticks.length - 1 ? undefined : "3 3",
    });
  });
  const tickLabels = ticks.map((tick, index) => {
    const y = PLOT_TOP + (PLOT_HEIGHT - (tick / max) * PLOT_HEIGHT) + 3;
    return createElement(
      "text",
      {
        key: `tick-${index}`,
        x: PLOT_LEFT - 6,
        y,
        textAnchor: "end",
        fontSize: 10,
        fill: MUTED,
        style: { fontVariantNumeric: "tabular-nums" },
      },
      formatRate(tick),
    );
  });
  const last = geometry.points.length > 0 ? geometry.points[geometry.points.length - 1]! : undefined;
  return createElement(
    "div",
    { style: { position: "relative" } },
    createElement(
      "svg",
      {
        viewBox: `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`,
        // 内容宽与 viewBox 宽相等，所以这里不拉伸；文字不会被压扁。
        preserveAspectRatio: "xMidYMid meet",
        width: "100%",
        height: `${SVG_HEIGHT}px`,
        "aria-hidden": "true",
        focusable: "false",
        style: { display: "block", width: "100%", height: `${SVG_HEIGHT}px` },
      },
      ...gridlines,
      ...tickLabels,
      geometry.line === ""
        ? null
        : createElement(
            "g",
            { transform: `translate(${PLOT_LEFT} ${PLOT_TOP})` },
            createElement("path", {
              d: geometry.area,
              fill: "color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 12%, transparent)",
              stroke: "none",
            }),
            createElement("path", {
              d: geometry.line,
              fill: "none",
              stroke: ACCENT,
              strokeWidth: 1.5,
              strokeLinejoin: "round",
            }),
            last === undefined
              ? null
              : createElement("circle", { cx: last.x, cy: last.y, r: 2.5, fill: ACCENT }),
          ),
      createElement(
        "text",
        {
          x: PLOT_LEFT,
          y: SVG_HEIGHT - 2,
          fontSize: 10,
          textAnchor: "start",
          fill: MUTED,
        },
        `${seconds} 秒前`,
      ),
      createElement(
        "text",
        {
          x: PLOT_LEFT + PLOT_WIDTH,
          y: SVG_HEIGHT - 2,
          fontSize: 10,
          textAnchor: "end",
          fill: MUTED,
        },
        "现在",
      ),
    ),
    quiet
      ? createElement(
          "div",
          {
            style: {
              position: "absolute",
              left: `${((PLOT_LEFT + PLOT_WIDTH / 2) / SVG_WIDTH) * 100}%`,
              top: `${((PLOT_TOP + PLOT_HEIGHT / 2) / SVG_HEIGHT) * 100}%`,
              transform: "translate(-50%, -50%)",
              color: MUTED,
              fontSize: "11px",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            },
          },
          "这段时间还没有输出",
        )
      : null,
  );
}

/**
 * 底部：时长切换（分段按钮）。
 * @param seconds - 当前时长。
 * @returns 元素。
 */
function renderFooter(seconds: TpsChartRange): ReactElement {
  const buttons: ReactNode[] = TPS_CHART_RANGES.map((range) =>
    createElement(
      "button",
      {
        key: `range-${range}`,
        type: "button",
        "aria-pressed": range === seconds,
        onClick: () => setChartSeconds(range),
        style: rangeButtonStyle(range === seconds),
      },
      rangeLabel(range),
    ),
  );
  return createElement(
    "div",
    { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px", marginTop: "6px" } },
    ...buttons,
  );
}
