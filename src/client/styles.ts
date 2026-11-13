/**
 * **共享的排版与表面样式**（2026-11-12，第 3 步；同日按用户反馈改成「与官方胶囊同色」）。
 *
 * ## 为什么单独一个模块
 *
 * 胶囊（`conversation.composer.dock`）和折线图弹层（`shell.overlay`）挂在两个不同的
 * 槽位，不能共享 React 树 —— 但它们**必须看起来像同一套东西**。用户为此提过三条：
 *
 * 1. 「字体和官方的不一致」→ 字号与行高必须用宿主那套 `--dsh-content-font-*` 变量；
 * 2. 「灰色底，希望能像官方那个胶囊一样用白色底」→ 弹层用**基础表面色**（浅色 = 白）；
 * 3. 「折线颜色，还有其他文字的字体颜色，和官方那个保持一致」→ 见下面 {@link INK}。
 *
 * ## 为什么弹层用 `bg-base` 而不是 `bg-overlay`
 *
 * `--dsw-alias-bg-overlay` 是**半透明**的浮层色（叠在内容上必然发灰，正是用户看到的
 * 「灰色底」）。弹层是一个要盖在聊天内容上的卡片，用不透明的
 * `--dsw-alias-bg-base`（浅色 = 白、深色 = 深灰黑）才对，再配宿主的 elevation 阴影
 * 把它和背景分开。
 *
 * ## 为什么文字与折线都用 `label-tertiary`（2026-11-12 用户看截图后的要求）
 *
 * 官方 `StatsPills` 的 `.pill` 只有一条配色规则：
 *
 * ```
 * color: var(--dsw-alias-label-tertiary);
 * ```
 *
 * 之前弹层用了 `label-primary`（近黑）画标题和折线 —— 于是弹层比旁边的官方胶囊
 * **黑一档**，看起来像两个不同来源的控件。现在标题、副标题、刻度、折线、端点全部走
 * 同一条 `label-tertiary`，与胶囊严格同色。
 *
 * 唯一的例外是**选中态的时长按钮**：它需要一点视觉重量才看得出「当前选的是哪个」，
 * 用 `label-secondary`（比 tertiary 深一档，仍在正文色之下）。
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
 * 文字的完整排版。
 *
 * 字体族走宿主的 `--dsw-font-family`（`body` 上已经按用户的「正文字体」设置落好），
 * 字号/行高同官方胶囊，数字等宽（速度跳动时宽度不变，不抖）。
 */
export const TYPO = {
  fontFamily: "var(--dsw-font-family, inherit)",
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
  color: "var(--dsw-alias-label-tertiary, #8a8f98)",
  /**
   * 浮层容器（`shell.overlay`）对「只是显示、不接收点击」的条目通常会关掉指针事件
   *（toast、徽标都属于这类）。我们的卡片要能点（关掉按钮、时长切换），所以**显式**
   * 打开。显式比依赖容器默认值稳 —— 宿主改默认值时这里不会跟着失灵。
   */
  pointerEvents: "auto",
} as const;

/**
 * 弹层里所有文字与折线的颜色。
 *
 * 与官方胶囊 `.pill` 的那一条 `color: var(--dsw-alias-label-tertiary)` **完全相同** ——
 * 这正是用户第 3 条反馈要的东西：折线与文字都跟官方保持一致。
 */
export const INK = "var(--dsw-alias-label-tertiary, #8a8f98)";

/** 弹层里比正文深一档的颜色：只用于**选中态**（当前时长按钮），让它看得出被选中。 */
export const INK_STRONG = "var(--dsw-alias-label-secondary, #6b7280)";

/** 弹层里的分割线/网格色（比正文更淡，不抢折线）。 */
export const HAIRLINE = "var(--dsw-alias-border-l1, #e5e7eb)";
