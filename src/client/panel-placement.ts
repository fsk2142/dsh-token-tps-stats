/**
 * **弹层摆在哪**（纯函数，可单测）。
 *
 * ## 为什么从 `tps-chart.ts` 抽出来（2026-11-14）
 *
 * 定位逻辑原本写在渲染函数里，只能靠「在测试里重新写一遍同样的算法」来验证 ——
 * 那种测试是假的：生产改了、测试还按旧规则算，两边一起漂走也照样绿。
 * 抽成纯函数之后，测试直接调用**真的那一份**。
 *
 * ## 三条规则
 *
 * 1. 优先摆在胶囊**正上方**（向上长，`translateY(-100%)`）；
 * 2. 上方装不下、下方装得下 → 翻到**下方**；
 * 3. 两边都装不下（矮窗口 + 20 步档这种 514px 的弹层）→ **贴住上边距**，
 *    宁可底部溢出。表头（页签、`?`、`x`）在顶部，被顶出去就等于
 *    「打开了一个关不掉的弹层」。
 *
 * 高度的来源是 `panelOuterHeight()`（真实外高，含内边距与头部）——
 * 2026-11-14 之前这里用的是常量 190，那是**内容区**高度，漏了 46px，
 * 所以 20 步档会被判定「放得下」然后被裁掉几百像素。
 *
 * @module dsh-token-tps-stats/src/client/panel-placement
 */

import type { ChartAnchor, ChartTab } from "./chart-store";
import { PANEL_WIDTH, panelOuterHeight } from "./panel-metrics";
import type { TpsStepRange } from "./step-history";

/** 弹层与胶囊之间的间距（像素）。 */
export const PANEL_GAP = 8;

/** 弹层与视口边缘的最小距离（像素）。 */
export const VIEWPORT_MARGIN = 8;

/** 弹层位置。 */
export interface PanelPlacement {
  readonly left: number;
  /** 放在下方时是**顶边**；放在上方时是**底边**（靠 `translateY(-100%)` 往上长）。 */
  readonly top: number;
  /** `true` = 摆在胶囊下方（上方放不下时）。 */
  readonly below: boolean;
  /** 这一块占据的竖带，便于断言「整块落在视口内」。 */
  readonly topEdge: number;
  readonly bottomEdge: number;
  /** 计算时用的视口高（渲染层据此算 maxHeight）。 */
  readonly innerHeight: number;
}

/**
 * 计算弹层位置。
 * @param anchor - 胶囊的屏幕矩形（打开那一刻取得）。
 * @param tab - 当前页签（两页高度不同）。
 * @param steps - 步数页当前档位。
 * @param viewport - 视口尺寸（测试可注入；缺省读 `window`）。
 * @param helpOpen - `?` 是否展开（展开后面板高 250px，必须参与定位）。
 * @returns 视口坐标下的位置。
 */
export function panelPlacement(
  anchor: ChartAnchor | undefined,
  tab: ChartTab,
  steps: TpsStepRange,
  viewport?: { readonly width: number; readonly height: number },
  helpOpen = false,
): PanelPlacement {
  const innerWidth = viewport?.width ?? (typeof window === "undefined" ? 0 : window.innerWidth);
  const innerHeight = viewport?.height ?? (typeof window === "undefined" ? 0 : window.innerHeight);
  /*
   * **高度必须带上 `helpOpen`**：面板靠 `translateY(-100%)` 向上长，
   * `?` 一展开就多 250px，不算进来会把表头和 `x` 顶出视口。
   */
  const panelHeight = panelOuterHeight(tab, steps, helpOpen);

  const clampTopEdge = (desired: number): number => {
    // 窗口比面板还矮时 `limit < VIEWPORT_MARGIN`，取上边距仍是最优解（表头可见）。
    const limit = Math.max(VIEWPORT_MARGIN, innerHeight - VIEWPORT_MARGIN - panelHeight);
    return Math.min(Math.max(desired, VIEWPORT_MARGIN), limit);
  };

  if (anchor === undefined || innerWidth <= 0) {
    // 没有锚点（理论上不会发生）：贴左下角，至少可见、可用。
    const topEdge = Math.max(VIEWPORT_MARGIN, innerHeight - panelHeight);
    return {
      left: VIEWPORT_MARGIN,
      top: topEdge,
      below: true,
      topEdge,
      bottomEdge: topEdge + panelHeight,
      innerHeight,
    };
  }

  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.left),
    Math.max(VIEWPORT_MARGIN, innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
  );
  // 「上方 / 下方」都留出间距与边距，再判断哪一边装得下。
  const roomAbove = anchor.top - PANEL_GAP - VIEWPORT_MARGIN;
  const roomBelow = innerHeight - anchor.bottom - PANEL_GAP - VIEWPORT_MARGIN;
  const below = roomAbove < panelHeight && roomBelow >= panelHeight;
  const desiredEdge = below ? anchor.bottom + PANEL_GAP : anchor.top - PANEL_GAP - panelHeight;
  const topEdge = clampTopEdge(desiredEdge);
  return {
    left,
    top: below ? topEdge : topEdge + panelHeight,
    below,
    topEdge,
    bottomEdge: topEdge + panelHeight,
    innerHeight,
  };
}

/**
 * **弹层最多能有多高**（矮窗口里靠它开启内部滚动）。
 *
 * ## 为什么需要（2026-11-14 第二轮排查发现）
 *
 * 定位保证了「表头可见」，但 20 步档 + `?` 展开有 764px 高 —— 窗口矮于这个数
 * （768px 的笔记本屏减去标题栏就差不多了）时，底部那排档位按钮与表格末行会被
 * 推出视口。面板本身不滚的话，那部分**永远够不到**。
 *
 * 所以渲染时挂一个 `maxHeight`：装得下时它大于内容高度、不生效；装不下时才
 * 截断并让弹层自己滚。
 *
 * ## 为什么两种摆法用同一个式子
 *
 * 弹层**占据的竖带顶边**都是 `placement.topEdge`（放在上方时靠
 * `translateY(-100%)` 往上长，视觉顶边仍是 `topEdge`）。所以可用高度永远是
 * 「视口高 − 顶边 − 下边距」，与 `below` 无关。
 * @param topEdge - 竖带顶边（`PanelPlacement.topEdge`）。
 * @param innerHeight - 视口高。
 * @returns 像素（不小于 0）。
 */
export function panelMaxHeight(topEdge: number, innerHeight: number): number {
  return Math.max(0, innerHeight - topEdge - VIEWPORT_MARGIN);
}
