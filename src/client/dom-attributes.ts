/**
 * **DOM 标记属性**（一个只此一份的地方）。
 *
 * ## 为什么要单开一个模块（2026-11-14）
 *
 * 这两个字符串原来各写了两份：`tps-pill.ts` 渲染胶囊时带 `PILL_ATTRIBUTE`，
 * `tps-chart.ts` 关闭弹层时又用它做「点的**不是**胶囊」的豁免判断 ——
 * 两个模块各自持有一份 `"data-token-tps-pill"` 字面量。
 *
 * 这种重复不会立刻出错，但改一处忘另一处时**很难查**：
 *
 * - `PILL_ATTRIBUTE` 只改一边 → 点胶囊不再 toggle，反而被当「点在外面」而关掉弹层；
 * - `PANEL_ATTRIBUTE` 只改一边 → 点弹层内部会被当「点在外面」而关掉自己。
 *
 * 两者都只在真机上点几下才看得出来，单测很难覆盖。所以收成一份。
 *
 * @module dsh-token-tps-stats/src/client/dom-attributes
 */

/** 胶囊的标记属性（弹层据此判断「点的是不是胶囊」）。 */
export const PILL_ATTRIBUTE = "data-token-tps-pill";

/** 弹层根节点的标记属性（判断「点在弹层里」用）。 */
export const PANEL_ATTRIBUTE = "data-token-tps-chart";
