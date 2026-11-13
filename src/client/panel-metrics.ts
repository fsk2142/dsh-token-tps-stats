/**
 * **弹层两个页签的版面高度**（2026-11-13）。
 *
 * ## 用户要的是什么
 *
 * > 实时速度和每步均的方框大小不一样，要求实时速度和每步平均的 5 步时候的
 * > 方框长宽高大小一致
 *
 * 宽度两边本来就是同一个 `PANEL_WIDTH`；问题出在**高度** —— 切换页签时面板
 * 会变高变矮，眼睛看得出跳动。
 *
 * ## 怎么做到「一致」
 *
 * 高度的来源全是固定像素（标题与副标题都是 `nowrap + ellipsis`，永远一行，不换行）：
 *
 * ```
 * 时间页：标题 + 副标题 + 折线图 + 档位按钮          （4 个子项 → 3 个 gap）
 * 步数页：标题 + 副标题 + 表头 + N 行 + 档位按钮      （5 个子项 → 4 个 gap）
 * ```
 *
 * 于是把**折线图的高度**取成「5 行时步数页的自然高度减去其余部分」，两页在
 * 5 步这一档就逐像素相等（{@link PANEL_REFERENCE_STEPS}）。
 *
 * 下面把每个加数往来源标了出来，`tests/client/panel-metrics.test.ts` 直接断言
 * `timeBodyHeight() === stepsBodyHeight(5)` —— 以后谁改了行高忘了同步，单测先炸，
 * 而不是等用户在真机上看出跳动。
 *
 * @module dsh-token-tps-stats/src/client/panel-metrics
 */

import { TPS_STEP_DEFAULT } from "./step-history";

/** 竖向 `gap`（两个页签的列容器都是 `gap: 2px`）。 */
export const COLUMN_GAP = 2;

/** 标题行高（12px 字 + `lineHeight: 17px`）。 */
export const TITLE_HEIGHT = 17;

/** 副标题行高（11px 字 + `lineHeight: 16px`）。 */
export const SUBTITLE_HEIGHT = 16;

/** 步数页副标题下方额外留白（`marginBottom: 4px`；时间页没有）。 */
export const SUBTITLE_MARGIN_BOTTOM = 4;

/** 「每步」表头外高（`lineHeight: 16px` + `padding: 0 0 3px`）。 */
export const STEP_HEADER_HEIGHT = 19;

/** 「每步」一行的外高（`lineHeight: 16px` + `padding: 2px 0`）。 */
export const STEP_ROW_HEIGHT = 20;

/** 档位按钮高度（`rangeButtonStyle` 的 `height: 22px`）。 */
export const BUTTON_HEIGHT = 22;

/** 档位按钮那排的上边距（`renderButtonRow` 的 `marginTop: 4px`）。 */
export const BUTTON_MARGIN_TOP = 4;

/** 头部（页签 + 关闭）高度：页签按钮就是 {@link BUTTON_HEIGHT}。 */
export const HEADER_HEIGHT = 22;

/** 头部下方留白（`renderHeader` 的 `marginBottom: 6px`）。 */
export const HEADER_MARGIN_BOTTOM = 6;

/** 弹层上内边距（`padding: 10px 12px 8px`）。 */
export const PANEL_PADDING_TOP = 10;

/** 弹层下内边距。 */
export const PANEL_PADDING_BOTTOM = 8;

/**
 * **两页要对齐的那一档**：用户点名的「5 步」。
 *
 * 10 / 20 步会自然更高 —— 那是行数决定的，不是错位。
 */
export const PANEL_REFERENCE_STEPS = TPS_STEP_DEFAULT;

/**
 * 折线图 SVG 的 viewBox 高（含底部横轴标签）。
 *
 * **125 是算出来的，不是随手取的**：它让 {@link timeBodyHeight} 恰好等于
 * {@link stepsBodyHeight}(5) = 190px。改这个数之前先跑那条对齐单测。
 */
export const CHART_SVG_HEIGHT = 125;

/**
 * 时间页的内容高度（不含弹层内边距与头部）。
 * @param svgHeight - 折线图高度，缺省 {@link CHART_SVG_HEIGHT}。
 * @returns 像素。
 */
export function timeBodyHeight(svgHeight: number = CHART_SVG_HEIGHT): number {
  return (
    TITLE_HEIGHT +
    COLUMN_GAP +
    SUBTITLE_HEIGHT +
    COLUMN_GAP +
    svgHeight +
    COLUMN_GAP +
    BUTTON_MARGIN_TOP +
    BUTTON_HEIGHT
  );
}

/**
 * 步数页的内容高度（不含弹层内边距与头部）。
 * @param rows - 表格行数（等于当前档位的步数）。
 * @returns 像素。
 */
export function stepsBodyHeight(rows: number): number {
  const bodyRows = Math.max(0, Math.floor(rows));
  return (
    TITLE_HEIGHT +
    COLUMN_GAP +
    SUBTITLE_HEIGHT +
    SUBTITLE_MARGIN_BOTTOM +
    COLUMN_GAP +
    STEP_HEADER_HEIGHT +
    COLUMN_GAP +
    bodyRows * STEP_ROW_HEIGHT +
    COLUMN_GAP +
    BUTTON_MARGIN_TOP +
    BUTTON_HEIGHT
  );
}

/**
 * 弹层的最小高度（含内边距与头部）。
 *
 * 挂在面板的 `minHeight` 上：步数页**还没有行**（空态）时不会缩水，
 * 「刚打开、一步都没跑完」那种情况也守得住「两页一样高」。
 * @returns 像素。
 */
export function panelMinHeight(): number {
  return (
    PANEL_PADDING_TOP +
    HEADER_HEIGHT +
    HEADER_MARGIN_BOTTOM +
    stepsBodyHeight(PANEL_REFERENCE_STEPS) +
    PANEL_PADDING_BOTTOM
  );
}
