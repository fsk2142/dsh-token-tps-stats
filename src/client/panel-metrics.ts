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

/** 步数页副标题下方额外留白（`marginBottom: 4px`）。**当前未使用** —— 那句提示
 * 已被 2026-11-13 删除，常量留着是为了「将来若加回一行说明」时有据可依。 */
export const SUBTITLE_MARGIN_BOTTOM = 4;

/** 头部按钮（`?` 与 `×`）的方形边长：与页签按钮同高，看起来是一组分段控件。 */
export const HEADER_BUTTON_SIZE = 22;

/** 「每步」表头外高（`lineHeight: 16px` + `padding: 0 0 3px`）。 */
export const STEP_HEADER_HEIGHT = 19;

/** 「每步」一行的外高（`lineHeight: 16px` + `padding: 2px 0`）。 */
export const STEP_ROW_HEIGHT = 20;

/** 档位按钮高度（`rangeButtonStyle` 的 `height: 22px`）。 */
export const BUTTON_HEIGHT = 22;

/**
 * 档位按钮的**固定宽度**（像素）：两组按钮统一用它。
 *
 * 用户 2026-11-13 看过真机后提的：
 *
 * > 两边的按钮大小宽度不一样
 * > 统一为 50px
 *
 * 根因是按钮按内容自适应宽度：`1 分钟` 比 `5 步` 宽，于是左组每个约 49px、
 * 右组约 38~44px，两组看起来像两种控件。现在两组**每个按钮都是 50px**：
 * 3 个按钮 + 2 个 6px 间隙 = 162px，左右两排的总宽也一致，右端对齐时整排左右都齐。
 *
 * 50px 装得下最长的文案（`5 分钟` / `10 步` 都是 3 个字符 ≈ 33px + 左右内边距
 * 16px + 边框 2px ≈ 51px）—— 所以内边距收到 6px，文字仍然居中、不贴边。
 */
export const BUTTON_WIDTH = 50;

/**
 * 一整排档位按钮的总宽（3 个按钮 + 2 个 6px 间隙）。
 *
 * 两组都是 3 个按钮，所以总宽也一致 —— 右端对齐时整排左右都齐。
 */
export const BUTTON_ROW_WIDTH = 3 * BUTTON_WIDTH + 2 * 6;

/** 档位按钮那排的上边距（`renderButtonRow` 的 `paddingTop`）。 */
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
 * **125 是算出来的，不是随手取的**：它让 {@link timeBodyHeight} 与
 * {@link stepsBodyHeight}(5) 相近（差 22px，由 `panelContentHeight` 统一）。
 * 改这个数之前先跑那条对齐单测。
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
 *
 * 2026-11-13 用户说「宿主的真实用量 · 口径见右上角 ?」这句**不用加**，那句提示
 * 被删掉了 —— 所以这里比上一版少一行（副标题 16 + 留白 4 + gap 2 = 22px 矮了）。
 * @param rows - 表格行数（等于当前档位的步数）。
 * @returns 像素。
 */
export function stepsBodyHeight(rows: number): number {
  const bodyRows = Math.max(0, Math.floor(rows));
  return (
    TITLE_HEIGHT +
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
 * **面板内容区的高度**：两页取较高那个。
 *
 * 删掉那句提示之后，5 步的步数页比时间页矮 22px。要「方框大小一致」，只有两条路：
 *
 * 1. 把折线图压矮 22px —— 绘图区从 99px 掉到 77px，纵轴能分辨的档位变少；
 * 2. **以高者为基准**，矮的那页留一点底部空白。
 *
 * 选了 2：折线图的分辨率别为了对齐去牺牲。
 *
 * ## 撑高之后还要「按钮对齐」（2026-11-13 用户第二次反馈）
 *
 * > 一个底部对齐，一个上去了，建议你两边对齐一下，不然切换的时候整个页面都是
 * > 跳了一下，不好看
 *
 * 只撑高外框是不够的：矮的那页会把档位按钮留在 22px 之上，切页签时按钮行上下跳。
 * 所以渲染层（`tps-chart.ts`）把面板本身做成 flex 列、页内容 `flex: 1`、
 * 按钮行 `marginTop: auto` —— 两页的按钮压在**同一条底线**上。
 *
 * 注意：那是 CSS 行为，本模块只负责「外框多高」，单测断言的是数字，不是布局。
 * @param rows - 步数页的行数；传 `undefined` 表示按时间页算。
 * @returns 像素。
 */
export function panelContentHeight(rows?: number): number {
  const steps = rows === undefined ? 0 : stepsBodyHeight(rows);
  return Math.max(timeBodyHeight(), steps);
}

/**
 * 弹层的最小高度（含内边距与头部）。
 *
 * **以两页里较高的那一页为准**（删掉那句提示之后是**时间页**更高）：挂在面板的
 * `minHeight` 上，矮的那一页就自动被撑到同一高度 —— 用户要的「方框大小一致」
 * 就是这样落实的，而不是靠两页各自的算式恰好相等（那种巧合一改行高就散）。
 * 顺带兜住空态：黑没有行时面板也不会缩。
 * @returns 像素。
 */
export function panelMinHeight(): number {
  return (
    PANEL_PADDING_TOP +
    HEADER_HEIGHT +
    HEADER_MARGIN_BOTTOM +
    panelContentHeight(PANEL_REFERENCE_STEPS) +
    PANEL_PADDING_BOTTOM
  );
}
