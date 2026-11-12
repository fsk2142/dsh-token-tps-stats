/**
 * **数字格式化**（2026-11-12，第 3 步把它从 `tps-pill.ts` 拆出来）。
 *
 * 为什么单独一个文件：胶囊和折线图弹层都要显示 tok/s，而它们**互相不 import**
 *（弹层挂在 `shell.overlay`、胶囊挂在 `conversation.composer.dock`）。共用一个
 * 格式化函数就不会出现「胶囊显示 4.2、弹层显示 4」这种各说各话的情况，
 * 也避免两个组件文件互相 import 形成环。
 *
 * @module dsh-token-tps-stats/src/client/format
 */

/**
 * 把数值格式化成显示文本。
 *
 * ≥10 取整、<10 保留一位（与官方 `formatTokensPerSecond` 同一口径）。
 * @param value - tok/s。
 * @returns 显示文本。
 */
export function formatRate(value: number): string {
  const clamped = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (clamped === 0) return "0";
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}
