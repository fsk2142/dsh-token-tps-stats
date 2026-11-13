/**
 * 客户端入口：把实时 tok/s 胶囊挂进输入框底部那一行。
 *
 * ## 这个插件只做一件事
 *
 * 从当前会话的流式输出估算速度，
 * 显示在 `conversation.composer.dock` 里、排在那两个官方胶囊（轮次/步数、用量）的左边。
 *
 * ## 安全边界（每一条都是实测踩出来的）
 *
 * 1. **不把 `uiConversation` / `slots` 放进顶层 `inject` 数组。**
 *    顶层缺失会让 cordis 判定整个客户端包激活失败 —— 界面直接白掉。
 *    这里用 `ctx.inject([...], cb)` 的**嵌套注入**：服务不在就只是这个回调不跑。
 * 2. **全部 try/catch**：注册失败只打一行 `console.error`，不外抛。
 * 3. **空的 `apply` 不会让插件看起来「没做事」**：注册成功会打一行 debug 日志
 *    （`tps pill: registered …`），排查时一眼能确认。
 *
 * @module dsh-token-tps-stats/src/client/index
 */

import { installTpsPill, type TpsPluginContext } from "./install";

/**
 * 本插件**不列**任何 cordis 服务。
 *
 * 需要的一切（`slots`、`uiConversation`）都走嵌套注入，因此这里刻意为空 ——
 * 一旦有人把服务名加进这个数组，缺失时就会从「这个功能不显示」升级成
 * 「整个客户端包激活失败」，那是完全不同量级的故障。
 */
export const inject: readonly string[] = [];

/**
 * 客户端插件入口。
 * @param ctx - 宿主注入的客户端上下文。
 */
export function apply(ctx: TpsPluginContext): void {
  try {
    installTpsPill(ctx);
  } catch (error: unknown) {
    // 最外层再兜一次：任何漏网异常都不该让宿主把整包判为激活失败。
    console.error("[dsh-token-tps-stats] client activation failed:", error);
  }
}
