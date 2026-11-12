/**
 * **两个槽位的注册**（2026-11-12 第 1 步；2026-11-13 去掉事件探针）。
 *
 * ## 这个文件现在只做一件事
 *
 * 把两个 React 组件挂到宿主的两个槽位：
 *
 * - `conversation.composer.dock` → 胶囊（`order: -1`，排在官方两个胶囊左边）；
 * - `shell.overlay` → 折线图弹层（横贯整帧的浮层，不会被输入框那一行裁掉）。
 *
 * ## 为什么**不再**注册 `uiConversation.events` 的 Definition（2026-11-13）
 *
 * 用户报「怎么是全局的会话速度」。根因是那张注册表**全局共享**（键是 kind），
 * 而每个会话各自有一个装配器，把同一个 Definition 拿去匹配**自己那份**事件流 ——
 * 同一个回调被所有会话分别调用，累加器只能混在一起（子代理同时跑时尤其离谱）。
 *
 * 数据源因此换成**槽位标准属性**：dock 是 `scope: "session"`，宿主发下来的 `useChat`
 * 只返回当前会话的快照（官方那两个胶囊正是这么读的）。于是这个文件不再需要
 * 任何事件监听，也就没有「跨会话串味」的可能。
 *
 * ## 安全边界（每一条都是实测踩出来的）
 *
 * 1. **不把 `uiConversation` / `slots` 放进顶层 `inject` 数组。**
 *    顶层缺失会让 cordis 判定整个客户端包激活失败 —— 界面直接白掉。
 *    这里用 `ctx.inject([...], cb)` 的**嵌套注入**：服务不在就只是这个回调不跑。
 * 2. **全部 try/catch**：注册失败只打一行 `console.error`，不外抛。
 * 3. 两个槽位**各自 try/catch**：`shell.overlay` 在某些窗口形态下可能不声明，
 *    那种时候只该没有弹层，不该连胶囊一起消失。
 *
 * @module dsh-token-tps-stats/src/client/install
 */

import { TpsChart } from "./tps-chart";
import { TpsPill } from "./tps-pill";

/** 探针需要的客户端上下文面（只用 `inject`，不碰别的服务）。 */
export interface TpsPluginContext {
  inject?(names: readonly string[], callback: (scoped: TpsPluginContext) => unknown): unknown;
}

/** 宿主 `ctx.slots` 的最小面（只认 `register`）。 */
interface SlotsLike {
  register?: (spec: Record<string, unknown>, component: unknown) => unknown;
}

/**
 * 显示胶囊的注销句柄（**模块级**：它由嵌套注入的回调赋值，回调清理时需要看到它）。
 *
 * 单独存一份而不是塞进闭包，是因为同一个 `installTpsProbe` 可能被多次触发
 * （槽位声明变化时宿主会重跑回调），每次都要先撤掉上一份。
 */
let pillDispose: (() => void) | undefined;

/**
 * 折线图弹层的注销句柄。
 *
 * 弹层挂在**另一个槽位**（`shell.overlay`），它的声明与 dock 的生命周期不一定
 * 同步（例如窗口宽度变化时 dock 可能重注册）—— 所以两份句柄分开存，各自可撤、
 * 互不牵连。
 */
let chartDispose: (() => void) | undefined;

/**
 * 撤销显示胶囊。
 *
 * 只在**注册成功过**时才需要调；拿不到句柄时是空操作。
 */
function disposePill(): void {
  const off = pillDispose;
  pillDispose = undefined;
  if (typeof off !== "function") return;
  try {
    off();
  } catch (error: unknown) {
    console.error("[dsh-token-tps-stats] tps pill: dispose failed:", error);
  }
}

/**
 * 撤销折线图弹层。
 *
 * 与 {@link disposePill} 同一套「拿不到句柄就是空操作」的处理：弹层注册失败
 * 只该损失弹层，**不该**连带把胶囊也撤掉。
 */
function disposeChart(): void {
  const off = chartDispose;
  chartDispose = undefined;
  if (typeof off !== "function") return;
  try {
    off();
  } catch (error: unknown) {
    console.error("[dsh-token-tps-stats] tps chart: dispose failed:", error);
  }
}

/**
 * 释放本次注册产生的一切（两个槽位）。
 * @returns 注销函数（可重复调用）。
 */
function releaseAll(): void {
  disposeChart();
  disposePill();
}

/**
 * 注册胶囊与弹层。
 *
 * 所有失败都在这里兜住：注册不上只是看不到这个胶囊，**不允许**影响插件的其余部分。
 * @param ctx - 客户端上下文。
 */
export function installTpsPill(ctx: TpsPluginContext): void {
  const inject = ctx.inject;
  if (typeof inject !== "function") {
    console.debug("[dsh-token-tps-stats] tps: ctx.inject is unavailable, skipped");
    return;
  }
  try {
    /*
     * 嵌套注入 `slots`：服务缺失时只有这个回调不跑，不会让整个客户端包激活失败。
     *
     * 不再注入 `uiConversation`：数据来自槽位属性，不需要事件注册表。
     */
    inject(["slots"], (scoped) => {
      try {
        const slots = (scoped as { slots?: SlotsLike }).slots;
        if (typeof slots !== "object" || slots === null || typeof slots.register !== "function") {
          console.debug("[dsh-token-tps-stats] tps pill: slots.register is unavailable, skipped");
          return releaseAll;
        }
        try {
          const off = slots.register(
            {
              name: "conversation.composer.dock",
              id: "token-tps-stats",
              // 负 order → 排在官方两个胶囊（轮次/步数 = 0、用量 = 1）的**左边**。
              order: -1,
            },
            TpsPill,
          );
          pillDispose = typeof off === "function" ? (off as () => void) : undefined;
          console.debug("[dsh-token-tps-stats] tps pill: registered into conversation.composer.dock (order -1)");
        } catch (error: unknown) {
          console.error("[dsh-token-tps-stats] tps pill: slot registration failed:", error);
        }
        try {
          const off = slots.register(
            { name: "shell.overlay", id: "token-tps-stats-chart" },
            TpsChart,
          );
          chartDispose = typeof off === "function" ? (off as () => void) : undefined;
          console.debug("[dsh-token-tps-stats] tps chart: registered into shell.overlay");
        } catch (error: unknown) {
          console.error("[dsh-token-tps-stats] tps chart: slot registration failed:", error);
        }
        return releaseAll;
      } catch (error: unknown) {
        console.error("[dsh-token-tps-stats] tps: registration failed:", error);
        return releaseAll;
      }
    });
  } catch (error: unknown) {
    console.error("[dsh-token-tps-stats] tps: nested inject failed:", error);
  }
}
