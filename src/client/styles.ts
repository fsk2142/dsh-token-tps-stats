/**
 * **共享的排版与表面样式**（2026-11-12，第 3 步）。
 *
 * ## 为什么单独一个模块
 *
 * 胶囊（`conversation.composer.dock`）和折线图弹层（`shell.overlay`）挂在两个不同的
 * 槽位，不能共享 React 树 —— 但它们**必须看起来像同一套东西**。用户为此提过两条：
 *
 * 1. 「字体和官方的不一致」→ 字号与行高必须用宿主那套 `--dsh-content-font-*` 变量；
 * 2. 「灰色底，希望能像官方那个胶囊一样用白色底」→ 弹层不能自己挑灰度，
 *    要用宿主的**基础表面色**（浅色主题下就是白色）。
 *
 * 把这两组值抽到这里，两个组件都从这里取，就不会再出现「胶囊对、弹层差一档」。
 *
 * ## 弹层为什么用 `bg-base` 而不是 `bg-overlay`
 *
 * `--dsw-alias-bg-overlay` 是**半透明**的浮层色（叠在内容上必然发灰，正是用户看到的
 * 「灰色底」）。弹层是一个要盖在聊天内容上的卡片，用不透明的
 * `--dsw-alias-bg-base`（浅色 = 白、深色 = 深灰黑）才对，再配宿主的 elevation 阴影
 * 把它和背景分开。
 *
 * @module dsh-token-tps-stats/src/client/styles
 */

/**
 * 与官方 `StatsPills` 的 `.anchor` 完全一致的字号。
 *
 * 宿主定义：`--dsh-content-font-size-secondary = min(size-1, max(13, size-2))`。
 * 直接引用变量，用户调大「会话内容字号」时这里会跟着变 —— 抄死 12px 不会。
 */
export const FONT_SIZE_SECONDARY = "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)";

/** 官方 `.anchor` 的 `line-height`（含字号增量，保证大字号时不挤）。 */
export const LINE_HEIGHT_SECONDARY = "calc(20px + var(--dsh-content-font-delta-secondary, 0px))";

/**
 * 文字的完整排版：字体族继承宿主（`--dsw-font-family` 已在 `body` 上设好）、
 * 字号/行高同官方胶囊、数字等宽（速度跳动时宽度不变，不抖）。
 */
export const TYPO = {
  fontFamily: "inherit",
  fontSize: FONT_SIZE_SECONDARY,
  lineHeight: LINE_HEIGHT_SECONDARY,
  fontVariantNumeric: "tabular-nums",
} as const;

/** 弹层的表面：不透明白底（浅色主题）+ 宿主 elevation 阴影。 */
export const SURFACE = {
  background: "var(--dsw-alias-bg-base, #fff)",
  border: "none",
  /**
   * 用宿主菜单/浮层的 elevation 令牌：自带 .5px 描边 + 两级投影。
   * 不自己拼 `0 8px 24px rgba(0,0,0,.18)` —— 那比宿主重一档，看起来像另一个应用的浮窗。
   */
  boxShadow: "var(--dsw-elevation-prominent, 0 0 0 .5px var(--dsw-alias-border-l4, #d1d5db), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d)",
  color: "var(--dsw-alias-label-primary, #1f2328)",
} as const;

/** 弹层里的次级文字色（刻度、副标题）。 */
export const MUTED = "var(--dsw-alias-label-secondary, #6b7280)";

/** 弹层里的分割线/网格色。 */
export const HAIRLINE = "var(--dsw-alias-border-l1, #e5e7eb)";

/** 品牌色（折线与选中态）。 */
export const ACCENT = "var(--dsw-alias-brand-primary, #2563eb)";
