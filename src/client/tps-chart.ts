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

import { axisScale, buildGeometry } from "./chart-geometry";
import {
  closeChart,
  getChartState,
  readPillRect,
  setChartSeconds,
  setChartSteps,
  setChartTab,
  subscribeChart,
  type ChartAnchor,
  type ChartState,
  type ChartTab,
} from "./chart-store";
import type { DshEvent } from "./dom";
import { formatRatio, formatRate, formatRateWithUnit, formatTokens } from "./format";
import { HELP_LABEL, HELP_SECTIONS } from "./help";
import { BUTTON_MARGIN_TOP, BUTTON_WIDTH, CHART_SVG_HEIGHT, HEADER_BUTTON_SIZE, panelMinHeight } from "./panel-metrics";
import type { SessionStream } from "./session-store";
import { TPS_STEP_RANGES, type StepRow, type TpsStepRange } from "./step-history";
import { HAIRLINE, INK, INK_STRONG, SURFACE, TYPO } from "./styles";
import { TPS_CHART_RANGES, type TpsChartRange, type TpsSeriesSummary } from "./tps-history";

/**
 * 弹层宽度（像素）。
 *
 * 2026-11-13 用户看过真机后要求「这个弹窗框可以再宽一些」：344px 时「每步」那张表
 * 六列挤在一起（读取/输入都是六位数的千分位数字，需要宽度才读得清）。
 * 440px = 内容宽 416px，正好放得下六列 + 折线图的留白。
 */
const PANEL_WIDTH = 440;

/** 弹层内边距（像素）：左右各 12px。 */
const PANEL_PADDING_X = 12;

/** 绘图区宽度（SVG 单位，等于内容宽减去左边距）。 */
const PLOT_WIDTH = PANEL_WIDTH - 2 * PANEL_PADDING_X - 32;

/** 绘图区高度（SVG 单位）：随 {@link CHART_SVG_HEIGHT} 一起放大，用掉多出来的空间。 */
const PLOT_HEIGHT = 99;

/** 绘图区左边距：给纵轴刻度标签留位。 */
const PLOT_LEFT = 32;

/** 绘图区上边距。 */
const PLOT_TOP = 8;

/** 整个 SVG 的 viewBox 宽（= 弹层内容宽，所以横向不会拉伸变形）。 */
const SVG_WIDTH = PANEL_WIDTH - 2 * PANEL_PADDING_X;

/**
 * 整个 SVG 的 viewBox 高（含底部横轴标签）。
 *
 * **这个数由 {@link CHART_SVG_HEIGHT} 决定**，不是随便挑的：它让时间页的高度
 * 恰好等于「5 步」时的步数页 —— 用户 2026-11-13 要求
 * 「实时速度和每步平均的 5 步时候的方框长宽高大小一致」。
 * 推导在两页共用的 `panel-metrics.ts` 里，`panel-metrics.test.ts` 断言这条等式。
 */
const SVG_HEIGHT = CHART_SVG_HEIGHT;

/**
 * 「每步」表格的列宽：步 · 读取 · 输入 · 输出 · 命中 · 速度。
 *
 * 用固定像素而不是 `1fr`：数字列要等宽对齐，`1fr` 会把位数不同的行错开。
 * 六列 396px + 5 个 4px 间隙 = **416px**（= 弹层内容宽），正好铺满。
 *
 * 「命中」给了 60px：99.9% 这类**带小数的读数**要放得下（整数位会进位到 100 时，
 * 命中率会多留一到两位小数，见 `format.ts` 的 `formatRatio`）。
 */
const STEP_GRID = "40px 76px 76px 56px 60px 88px";

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

/**
 * 分段按钮的样式：**选中态**比未选中深一档（否则看不出当前选的是哪个）。
 *
 * 除选中态那一点视觉重量外，按钮与弹层其它文字同色 —— 用户要求「和官方那个
 * 字体颜色保持一致」，所以这里不引入品牌色蓝。
 *
 * `width` 由调用方给（两组按钮的文案宽度不同，见 {@link BUTTON_WIDTH}）：
 * 不给就是按内容自然宽，那是页签用的形态。
 * @param active - 是否选中。
 * @param width - 固定宽度（像素）；`undefined` = 按内容宽。
 * @returns 内联样式。
 */
function rangeButtonStyle(active: boolean, width?: number): Record<string, string | number> {
  return {
    border: `1px solid ${active ? INK_STRONG : HAIRLINE}`,
    background: "transparent",
    color: active ? INK_STRONG : INK,
    borderRadius: "6px",
    /*
     * 给了固定宽度就把内边距收窄（`8px` → `6px`）：50px 里要装下「5 分钟」这种
     * 3 字符文案 + 居中，8px 会挤到贴边。
     */
    padding: width === undefined ? "0 8px" : "0 6px",
    height: "22px",
    fontFamily: TYPO.fontFamily,
    fontSize: "11px",
    lineHeight: "20px",
    cursor: "pointer",
    ...(width === undefined ? {} : { width: `${width}px`, boxSizing: "border-box", textAlign: "center" }),
  };
}

/**
 * 时长按钮的显示文案。
 * @param seconds - 时长（秒）。
 * @returns 文案。
 */
function rangeLabel(seconds: TpsChartRange): string {
  if (seconds >= 300) return "5 分钟";
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
  /** 口径说明是否展开（**组件本地状态**，不进 `chart-store`）。 */
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => subscribeChart(() => setState(getChartState())), []);

  useEffect(() => {
    if (!state.open) return;
    /*
     * 每 500ms 重画一次：时间轴在走，即使没有新帧，曲线也要随时间右移。
     *
     * **为什么不再订阅每一帧**：折线按**整秒**取点（最后一点落在上一个已走完的秒），
     * 所以一个 60 秒的图每秒最多变一次 —— 流式帧每秒几十个，逐帧重画只会白烧
     * 一次布局（面板位置要读 `getBoundingClientRect`，那会强制浏览器回流）。
     * 500ms 的节奏足够让新的一秒在半个周期内出现，观感与逐帧重画没有区别。
     */
    const timer = setInterval(() => setTick((tick) => tick + 1), OPEN_TICK_MS);
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
  return renderPanel(state, readPillRect() ?? state.anchor, { helpOpen, toggleHelp: () => setHelpOpen((open) => !open) });
}

/**
 * 渲染弹层内容（**左上角两个标签页**，2026-11-13 用户第二版要求）。
 *
 * > 现在你设计的是并列显示，我需要的是可以在左上角进行选择，然后整个页面都进行切换。
 *
 * 上一版把「实时速度」和「每步平均」并排画成两块，用户不要那个形状：
 * 左上角选一个，整张图跟着换。这样每张图能独占整个宽度，曲线也看得清。
 *
 * 两个页签各自记得自己的档位（60/180/300 秒、5/10/20 步），切换页签不会重置。
 *
 * 口径说明（2026-11-13 用户第三版要求）：
 *
 * > 这个地方不需要这么长的说明吧，可以在右上角的 X 旁边放一个可以点击的
 * > ？来进行解释说明
 *
 * 所以长说明搬进 `?` 的展开面板，常驻只留一句短提示（见 `help.ts`）。
 * @param state - 弹层状态（页签 / 时长 / 步数 / 看哪个会话）。
 * @param anchor - 胶囊矩形。
 * @param help - 说明面板的开关与切换函数。
 * @returns 元素。
 */
function renderPanel(
  state: ChartState,
  anchor: ChartAnchor | undefined,
  help: { helpOpen: boolean; toggleHelp: () => void },
): ReactElement {
  const now = Date.now();
  /*
   * **没有会话就没有曲线**。
   *
   * 理论上升不到这里（弹层只可能由胶囊点开，胶囊一定带着自己那份状态）。
   * 但 `shell.overlay` 是 root 槽位，如果宿主在这次渲染前把 dock 撤了，
   * 这里就只剩一个空壳 —— 与其去读一个不知道是谁的全局历史（那正是用户报的
   * 「怎么是全局速度」），不如老实显示空态。
   */
  const stream = state.stream;
  const timeView = timeSeriesOf(stream, now, state.seconds);
  const rows = stream === undefined ? [] : stream.steps.rows(state.steps);
  const placement = panelPlacement(anchor);
  const seconds = state.seconds;
  const steps = state.steps;
  /*
   * 说明展开时面板会变高，但可能已经贴着视口顶部（`translateY(-100%)` 往上长）。
   * 展开面板因此**画在内容流里**（把两页往下推），而不是浮在上面盖住图表 ——
   * 盖住会让「读说明时想看表格」变得不可能，而这是用户自己点开要看的。
   */

  return createElement(
    "div",
    {
      [PANEL_ATTRIBUTE]: "",
      role: "dialog",
      "aria-label":
        state.tab === "time"
          ? `实时输出速度（TPS），最近 ${rangeLabel(seconds)}`
          : `每步输出统计，最近 ${stepLabel(steps)}`,
      style: {
        position: "fixed",
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        transform: placement.below ? "none" : "translateY(-100%)",
        width: `${PANEL_WIDTH}px`,
        /*
         * **两页一样高**（2026-11-13 用户要求）。
         *
         * 时间页的高度由折线图 SVG 定死；步数页由行数定。折线图的高度已经取成
         * 「5 步」那一档的高度（推导见 `panel-metrics.ts`），所以切页签不会跳。
         *
         * `minHeight` 再兜一层：步数页还没跑完一步时是空态（比 5 行矮），
         * 光靠折线图对齐就管不住它。
         */
        minHeight: `${panelMinHeight()}px`,
        boxSizing: "border-box",
        padding: `10px ${PANEL_PADDING_X}px 8px`,
        /*
         * **两页的档位按钮必须落在同一条底线上**（2026-11-13 用户要求）。
         *
         * > 一个底部对齐，一个上去了，建议你两边对齐一下，不然切换的时候整个页面
         * > 都是跳了一下
         *
         * 光有 `minHeight` 只保证「面板外框一样高」：矮的那页（删掉那句提示后是
         * 步数页，168px < 时间页 190px）会把自己的档位按钮留在 22px 之上，切页签
         * 时按钮行就上下跳一下。
         *
         * 所以面板本身也改成一列 flex，页内容 `flex: 1` 吃掉多出来的高度，
         * 档位按钮那排 `marginTop: auto` 贴到底 —— 两页按钮于是都压在同一个 `y` 上。
         */
        display: "flex",
        flexDirection: "column",
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
    renderHeader(state.tab, help),
    help.helpOpen ? renderHelp() : null,
    state.tab === "time"
      ? renderColumn({
          title: `实时速度 · 最近 ${rangeLabel(seconds)}`,
          /*
           * 三个读数**各自带单位**（2026-11-13 用户反馈）。
           *
           * 原来只有「当前」带 ` tok/s`，平均和峰值是光秃秃的数字：
           * 「当前 75 tok/s · 平均 65 · 峰值 86」。
           */
          subtitle: `当前 ${formatRateWithUnit(timeView.summary.latest)} · 平均 ${formatRateWithUnit(timeView.summary.average)} · 峰值 ${formatRateWithUnit(timeView.summary.peak)}`,
          geometry: timeView.geometry,
          scale: timeView.scale,
          // 峰值为 0 才叫「这段时间还没有输出」；有起伏时别用一句话盖住曲线。
          emptyText: timeView.summary.peak < 0.5 ? "这段时间还没有输出" : undefined,
          axisStart: `${seconds} 秒前`,
          axisEnd: "现在",
          buttons: renderRangeButtons(seconds),
        })
      : renderStepTable(rows, steps),
  );
}

/** 实时速度页的取数结果。 */
interface TimeView {
  readonly geometry: ReturnType<typeof buildGeometry>;
  readonly scale: ReturnType<typeof axisScale>;
  readonly summary: TpsSeriesSummary;
}

/**
 * 取「实时速度」这一页的数据。
 * @param stream - 会话状态；`undefined` 时给空态。
 * @param now - 现在（毫秒）。
 * @param seconds - 展示时长。
 * @returns 几何 + 量程 + 统计值。
 */
function timeSeriesOf(stream: SessionStream | undefined, now: number, seconds: TpsChartRange): TimeView {
  const points = stream === undefined ? [] : stream.history.series(now, seconds);
  /*
   * **统计值直接在这批点上算**（2026-11-13 优化）。
   *
   * 原来 `history.series()` 和 `history.summary()` 各算一遍滑动窗：弹层每 500ms
   * 重画一次，300 秒那一档等于每半秒白算 300 个点。而 `series()` 已经把每个点的
   * 值给出来了 —— 平均/峰值/最新就是它们的 sum / max / 最后一项。
   */
  const summary: TpsSeriesSummary =
    points.length === 0
      ? { average: 0, peak: 0, latest: 0 }
      : {
          average: points.reduce((total, point) => total + point.value, 0) / points.length,
          peak: points.reduce((peak, point) => (point.value > peak ? point.value : peak), 0),
          latest: points[points.length - 1]!.value,
        };
  const scale = axisScale(summary.peak);
  const geometry = buildGeometry(
    points.map((point) => point.value),
    { width: PLOT_WIDTH, height: PLOT_HEIGHT, max: scale.max },
  );
  return { geometry, scale, summary };
}

/**
 * 渲染「每步」这一页：**一张表**，每行一步。
 *
 * 用户 2026-11-13 两次明确要求，这里不要折线：
 *
 * > 每步平均这里不用按照折线图显示，直接列出来第一步，输出多少，输入多少，
 * > 命中多少，平均速率多少，这样子
 *
 * 随后定了**列的顺序与简称**：
 *
 * > 应该先是缓存读取、未缓存输入、输出、缓存命中、平均速度，
 * > 但是都用简写：读取 / 输入 / 输出 / 命中 / 速度。
 *
 * 表格上方那一长行说明已经搬进 `?`（用户：单靠一行说明太长），**常驻一行都不留**
 * （用户随后又明确「这句话不用加」）—— 标题下面直接就是表头，更紧凑。
 *
 * 列是：步 · 读取 · 输入 · 输出 · 命中 · 速度。
 * 「读取」= `cacheReadTokens`，「输入」= `inputTokens`（**未缓存**那部分，
 * 不是 `total − output` —— 那会把缓存算进来）；「命中」= 读取 ÷（读取 + 输入 + 写入）。
 *
 * 列宽用固定像素（数字列右对齐 + 等宽数字），行与行才对齐得起来；
 * 拿不到的字段显示 `—`，不拿估算值假装成账单。
 * @param rows - 最近几步（**最新在前**）。
 * @param steps - 当前档位（用于标题与空态）。
 * @returns 元素。
 */
function renderStepTable(rows: readonly StepRow[], steps: TpsStepRange): ReactElement {
  const header = createElement(
    "div",
    {
      style: {
        display: "grid",
        gridTemplateColumns: STEP_GRID,
        gap: "0 4px",
        padding: "0 0 3px",
        fontSize: "11px",
        lineHeight: "16px",
        color: INK,
      },
    },
    createElement("span", null, "步"),
    createElement("span", { style: { textAlign: "end" } }, "读取"),
    createElement("span", { style: { textAlign: "end" } }, "输入"),
    createElement("span", { style: { textAlign: "end" } }, "输出"),
    createElement("span", { style: { textAlign: "end" } }, "命中"),
    createElement("span", { style: { textAlign: "end" } }, "速度"),
  );

  const body = rows.map((row, index) =>
    createElement(
      "div",
      {
        key: `${row.turn}:${row.step}:${index}`,
        style: {
          display: "grid",
          gridTemplateColumns: STEP_GRID,
          gap: "0 4px",
          padding: "2px 0",
          fontSize: "11px",
          lineHeight: "16px",
          color: INK,
          // 进行中的那一步淡一档：数字还会长。
          opacity: row.running ? 0.6 : 1,
        },
      },
      createElement("span", { style: { whiteSpace: "nowrap" } }, `#${row.turn}.${row.step}`),
      createElement("span", { style: { textAlign: "end", whiteSpace: "nowrap" } }, formatTokens(row.cacheReadTokens)),
      createElement("span", { style: { textAlign: "end", whiteSpace: "nowrap" } }, formatTokens(row.inputTokens)),
      createElement("span", { style: { textAlign: "end", whiteSpace: "nowrap" } }, formatTokens(row.outputTokens)),
      createElement(
        "span",
        { style: { textAlign: "end", whiteSpace: "nowrap" } },
        row.hitRatio === undefined ? "—" : formatRatio(row.hitRatio),
      ),
      createElement(
        "span",
        { style: { textAlign: "end", whiteSpace: "nowrap" } },
        row.speed === undefined ? "—" : formatRateWithUnit(row.speed),
      ),
    ),
  );

  return createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        width: "100%",
        // 吃掉多出来的高度：档位按钮那排才能被 `marginTop: auto` 推到底线。
        flex: "1",
      },
    },
    createElement(
      "span",
      {
        style: {
          fontSize: "12px",
          lineHeight: "17px",
          color: INK,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      },
      `每步输出 · 最近 ${stepLabel(steps)}`,
    ),
    header,
    body.length === 0
      ? createElement(
          "div",
          {
            style: {
              padding: "26px 0",
              textAlign: "center",
              fontSize: "11px",
              color: INK,
            },
          },
          "这一步还没有输出",
        )
      : createElement("div", { style: { display: "flex", flexDirection: "column" } }, ...body),
    renderStepButtons(steps),
  );
}

/**
 * 口径说明面板（`?` 点开时显示）。
 *
 * 画在**内容流里**而不是浮在图表上：用户点开就是想读它，盖住表格会让「一边读
 * 说明一边看数字」变得不可能。展开时面板变高 —— 位置用 `translateY(-100%)`
 * 从胶囊往上长，所以高度增加是向上扩张，不会把面板推到视口外（顶多贴顶，
 * 而积木式的 `?` 按钮本身仍在可视区）。
 * @returns 元素。
 */
function renderHelp(): ReactElement {
  return createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "8px" } },
    ...HELP_SECTIONS.map((section, index) =>
      createElement(
        "div",
        { key: `help-${index}`, style: { display: "flex", flexDirection: "column", gap: "1px" } },
        createElement(
          "span",
          { style: { fontSize: "11px", lineHeight: "16px", color: INK_STRONG, fontWeight: 600 } },
          section.title,
        ),
        ...section.lines.map((line, lineIndex) =>
          createElement(
            "span",
            { key: `help-${index}-${lineIndex}`, style: { fontSize: "11px", lineHeight: "16px", color: INK } },
            `· ${line}`,
          ),
        ),
      ),
    ),
  );
}

/**
 * 头部右侧那个**方形图标按钮**的样式（`?` 与 `×` 共用）。
 *
 * 用户 2026-11-13 的原话是「右上角的 X 和 ? 加一个小方框吧，就像和每步平均那个
 * 样子」—— 也就是要和左侧页签按钮、下方档位按钮同一套观感：1px 描边 + 6px 圆角
 * + 22px 高。所以这里**直接复用** {@link rangeButtonStyle} 的边框与圆角，只把
 * 内边距换成「固定正方形 + 内容居中」。
 *
 * 之前它俩是无边框的裸文字：和页签放在一起时，左边三个是按钮、右边两个像文字，
 * 视觉上分成两拨 —— 加方框之后整条头部读起来是一组控件。
 * @param active - 这个按钮是不是处于「打开 / 激活」状态（`?` 展开时是）。
 * @returns 内联样式。
 */
function iconButtonStyle(active: boolean): Record<string, string | number> {
  return {
    ...rangeButtonStyle(active),
    // 固定正方形：两个按钮同宽同高，`?` 和 `×` 的视觉重量才一致。
    width: `${HEADER_BUTTON_SIZE}px`,
    height: `${HEADER_BUTTON_SIZE}px`,
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    // 行高与高度一致，字才真正居中。
    lineHeight: `${HEADER_BUTTON_SIZE - 2}px`,
  };
}

/**
 * 头部：**左上角两个页签** + 右侧 `?` 与关闭按钮。
 *
 * 页签沿用宿主分段控件的观感：未选中是透明底 + 发丝边框，选中是略深一档的描边
 * （与下方档位按钮同一套 `rangeButtonStyle`），所以「选中的是哪个」一眼看得出。
 *
 * `?` 是 2026-11-13 用户要求的：
 *
 * > 可以在右上角的 X 旁边放一个可以点击的？来进行解释说明
 *
 * 随后又要求「X 和 ? 加一个小方框，就像每步平均那个样子」—— 所以两者都走
 * {@link iconButtonStyle}，与页签同一套边框，整条头部是一组控件。
 * @param tab - 当前页签。
 * @param help - 说明面板的开关与切换函数。
 * @returns 元素。
 */
function renderHeader(tab: ChartTab, help: { helpOpen: boolean; toggleHelp: () => void }): ReactElement {
  return createElement(
    "div",
    { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" } },
    createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "6px", flex: "1", minWidth: "0" } },
      renderTabButton("time", "实时速度", tab),
      renderTabButton("steps", "每步平均", tab),
    ),
    createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "6px", flex: "none" } },
      createElement(
        "button",
        {
          type: "button",
          "aria-label": HELP_LABEL,
          "aria-pressed": help.helpOpen,
          title: HELP_LABEL,
          onClick: () => help.toggleHelp(),
          style: iconButtonStyle(help.helpOpen),
        },
        "?",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "关闭折线图",
          onClick: () => closeChart(),
          style: iconButtonStyle(false),
        },
        "×",
      ),
    ),
  );
}

/**
 * 造一个页签按钮。
 * @param value - 这个页签的身份。
 * @param text - 按钮文案。
 * @param current - 当前选中的页签。
 * @returns 元素。
 */
function renderTabButton(value: ChartTab, text: string, current: ChartTab): ReactElement {
  return createElement(
    "button",
    {
      key: value,
      type: "button",
      "aria-pressed": value === current,
      onClick: () => setChartTab(value),
      style: rangeButtonStyle(value === current),
    },
    text,
  );
}

/** 一页图的参数（页签切换后只剩一页，所以这块撑满）。 */
interface ColumnOptions {
  /** 标题（第一行）。 */
  readonly title: string;
  /** 副标题：当前 / 平均 / 峰值（第二行）。 */
  readonly subtitle: string;
  /** 绘图几何。 */
  readonly geometry: ReturnType<typeof buildGeometry>;
  /** 纵轴量程。 */
  readonly scale: ReturnType<typeof axisScale>;
  /** 这一段完全没有输出时显示的空态文案；`undefined` = 不显示空态。 */
  readonly emptyText: string | undefined;
  /** 横轴左端的标签（「60 秒前」/「5 步前」）。 */
  readonly axisStart: string;
  /** 横轴右端的标签（「现在」/「这一步」）。 */
  readonly axisEnd: string;
  /** 这一页下方的档位按钮。 */
  readonly buttons: ReactNode;
}

/**
 * 渲染**当前页**（标题 + 副标题 + SVG + 档位按钮）。
 *
 * 只有一页时不需要再包一层固定宽度：直接撑满弹层内容宽，曲线横向有更多像素。
 *
 * `flex: 1` 让这一列吃掉面板多出来的高度，配合按钮那排的 `marginTop: auto`，
 * 档位按钮就贴在面板底线上（理由见 `renderPanel` 的说明）。
 * @param options - 这一页的参数。
 * @returns 元素。
 */
function renderColumn(options: ColumnOptions): ReactElement {
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        width: "100%",
        flex: "1",
      },
    },
    createElement(
      "span",
      {
        style: {
          fontSize: "12px",
          lineHeight: "17px",
          color: INK,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      },
      options.title,
    ),
    createElement(
      "span",
      {
        style: {
          fontSize: "11px",
          lineHeight: "16px",
          color: INK,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      },
      options.subtitle,
    ),
    renderChart(options),
    options.buttons,
  );
}

/** 折线图参数。 */
interface ChartViewOptions {
  /** 绘图几何。 */
  readonly geometry: ReturnType<typeof buildGeometry>;
  /** 纵轴量程（上限 / 格宽 / 刻度），由 `chart-geometry.ts` 的 `axisScale` 算好。 */
  readonly scale: ReturnType<typeof axisScale>;
  /** 完全没有输出时显示的空态文案；`undefined` = 不显示。 */
  readonly emptyText: string | undefined;
  /** 横轴左端标签。 */
  readonly axisStart: string;
  /** 横轴右端标签。 */
  readonly axisEnd: string;
}

/**
 * 折线图本体（SVG + 空态提示）。
 *
 * 折线、端点、刻度、轴标签**全部用同一个 `INK`**（= 官方胶囊的 `label-tertiary`）：
 * 用户 2026-11-12 的原话是「折线颜色，还有其他文字的字体颜色，和官方那个保持一致」。
 * 之前折线用 `brand-primary`（近黑）、刻度用 `label-secondary`，弹层整体比旁边胶囊黑一档。
 *
 * 纵轴（2026-11-13 用户反馈「峰值过高不要纵轴翻倍，可以 50 递增」）：量程与刻度由
 * `axisScale` 一并给出，刻度落在整格上（108 → 0/50/100/150，而不是 0/100/200）。
 * @param options - 几何 + 量程 + 状态。
 * @returns 元素。
 */
function renderChart(options: ChartViewOptions): ReactElement {
  const { geometry, scale, emptyText, axisStart, axisEnd } = options;
  const max = scale.max;
  const ticks = scale.ticks;
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
        fill: INK,
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
            /*
             * **不填面积**（2026-11-12 用户看截图后反馈「折线图里为什么还是灰色的」）。
             *
             * 上一版给曲线下方铺了一层 `color-mix(brand-primary 12%, transparent)`。
             * 本主题的 `--dsw-alias-brand-primary` 是**近黑色**（#0f1115），
             * 12% 的近黑叠在白色卡片上就是一片**灰**——用户看到「图表区域是灰的」
             * 正是这层填充，不是卡片底色（卡片已经是白的）。
             *
             * 换浅蓝也不行：那会把「白底 + 黑线」的官方观感改成另一种配色。
             * 所以这里只画线，绘图区留白，与卡片同色。
             */
            createElement("path", {
              d: geometry.line,
              fill: "none",
              stroke: INK,
              strokeWidth: 1.5,
              strokeLinejoin: "round",
            }),
            last === undefined
              ? null
              : createElement("circle", { cx: last.x, cy: last.y, r: 2.5, fill: INK }),
          ),
      createElement(
        "text",
        {
          x: PLOT_LEFT,
          y: SVG_HEIGHT - 2,
          fontSize: 10,
          textAnchor: "start",
          fill: INK,
        },
        axisStart,
      ),
      createElement(
        "text",
        {
          x: PLOT_LEFT + PLOT_WIDTH,
          y: SVG_HEIGHT - 2,
          fontSize: 10,
          textAnchor: "end",
          fill: INK,
        },
        axisEnd,
      ),
    ),
    emptyText === undefined
      ? null
      : createElement(
          "div",
          {
            style: {
              position: "absolute",
              left: `${((PLOT_LEFT + PLOT_WIDTH / 2) / SVG_WIDTH) * 100}%`,
              top: `${((PLOT_TOP + PLOT_HEIGHT / 2) / SVG_HEIGHT) * 100}%`,
              transform: "translate(-50%, -50%)",
              color: INK,
              fontSize: "11px",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            },
          },
          emptyText,
        ),
  );
}

/**
 * 左块的档位按钮：1 / 3 / 5 分钟。
 * @param seconds - 当前时长。
 * @returns 元素。
 */
function renderRangeButtons(seconds: TpsChartRange): ReactElement {
  return renderButtonRow(
    TPS_CHART_RANGES.map((range) =>
      createElement(
        "button",
        {
          key: `range-${range}`,
          type: "button",
          "aria-pressed": range === seconds,
          onClick: () => setChartSeconds(range),
          style: rangeButtonStyle(range === seconds, BUTTON_WIDTH),
        },
        rangeLabel(range),
      ),
    ),
  );
}

/**
 * 右块的档位按钮：5 / 10 / 20 步。
 * @param steps - 当前步数。
 * @returns 元素。
 */
function renderStepButtons(steps: TpsStepRange): ReactElement {
  return renderButtonRow(
    TPS_STEP_RANGES.map((count) =>
      createElement(
        "button",
        {
          key: `step-${count}`,
          type: "button",
          "aria-pressed": count === steps,
          onClick: () => setChartSteps(count),
          style: rangeButtonStyle(count === steps, BUTTON_WIDTH),
        },
        stepLabel(count),
      ),
    ),
  );
}

/**
 * 一排档位按钮（两块共用同一套外观与布局）。
 *
 * `marginTop: "auto"`（而不是固定的 4px）：这一排永远贴着**面板底边**。
 *
 * 用户的抱怨是「一个底部对齐，一个上去了」——
 *
 * > 建议你两边对齐一下，不然切换的时候整个页面都是跳了一下，不好看
 *
 * 光靠面板 `minHeight` 只会让外框一样高：矮的那页（步数页 168px < 时间页 190px）
 * 会把按钮留在上方，切页签时按钮行上下跳。交给 `auto` 之后，两页的按钮都在
 * 面板底边的同一个 `y` 上，切页签时按钮不动 —— 动的只有上方那块图表/表格。
 * 原来那个 4px 视觉间距由面板下内边距（8px）覆盖，实际留白反而更稳。
 * @param buttons - 按钮节点。
 * @returns 元素。
 */
function renderButtonRow(buttons: ReactNode[]): ReactElement {
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "6px",
        marginTop: "auto",
        // 兜底：即使外层不是 flex 列（理论上不会），也还有一点间距。
        paddingTop: `${BUTTON_MARGIN_TOP}px`,
      },
    },
    ...buttons,
  );
}

/**
 * 步数档的显示文案。
 * @param steps - 步数。
 * @returns 文案。
 */
function stepLabel(steps: TpsStepRange): string {
  return `${steps} 步`;
}

