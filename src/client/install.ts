/**
 * **两个槽位的注册**（2026-11-12 第 1 步；2026-11-13 去掉事件探针、改走 `slots.inject`）。
 *
 * ## 这个文件现在只做一件事
 *
 * 把两个 React 组件挂到宿主的两个槽位：
 *
 * - `conversation.composer.dock` → 胶囊（`order: -1`，排在官方两个胶囊左边）；
 * - `shell.overlay` → 折线图弹层（横贯整帧的浮层，不会被输入框那一行裁掉）。
 *
 * ## 为什么必须用 `slots.inject`，而不是直接 `slots.register`（2026-11-13 实测）
 *
 * 用户报「重启后胶囊不见了」，控制台两条：
 *
 * ```
 * Error: slot "conversation.composer.dock" is not declared
 *        (a parent entry's children table must declare it)
 * Error: slot "shell.overlay" is not declared
 * ```
 *
 * 槽位声明**不是**永久的：它由声明方条目在自己的生命周期里建立，窗口形态变化、
 * 条目重挂时还会被撤掉重建。之前拿到 `slots` 服务就**立刻** `register`，赌的是
 * 「激活这一刻声明已经在了」—— 重启后批次顺序一变，这条竞态就常态化了。
 *
 * `slots.inject(key, cb)` 正是为此设计的：
 *
 * - 声明**已存在** → 回调同步执行；
 * - 声明**还没提交** → 回调挂在声明方 `register()` 提交之后执行；
 * - 声明**重建**（新的 declaration epoch）→ 回调再跑一次，上一次的清理先执行。
 *
 * 所以注册要写在 `slots.inject` 的回调里，并把回调返回的注销函数交还给它 ——
 * 声明消失时槽位条目跟着消失，不会留下指向已撤声明的登记。
 *
 * ## 安全边界（每一条都是实测踩出来的）
 *
 * 1. **不把 `slots` 放进顶层 `inject` 数组。**
 *    顶层缺失会让 cordis 判定整个客户端包激活失败 —— 界面直接白掉
 *    （`dsh.client.inject` 同样有这个后果，所以那里也是空数组）。
 *    这里用 `ctx.inject([...], cb)` 的**嵌套注入**：服务不在就只是这个回调不跑。
 * 2. **全部 try/catch**：注册失败只打一行 `console.error`，不外抛。
 * 3. 两个槽位**各自 try/catch**：`shell.overlay` 在某些窗口形态下可能还没声明，
 *    那种时候只该没有弹层，不该连胶囊一起消失。
 * 4. `slots.inject` 不可用（老宿主）时退回直接 `register`，并保留原来的兜底 ——
 *    宁可显示不出来，也不要整包激活失败。
 *
 * @module dsh-token-tps-stats/src/client/install
 */

import { TpsChart } from "./tps-chart";
import { TpsPill } from "./tps-pill";

/** 探针需要的客户端上下文面（只用 `inject`，不碰别的服务）。 */
export interface TpsPluginContext {
  inject?(names: readonly string[], callback: (scoped: TpsPluginContext) => unknown): unknown;
}

/** 宿主 `ctx.slots` 的最小面（只认 `inject` 与 `register`）。 */
interface SlotsLike {
  /**
   * 注册一格。
   *
   * **它是原型方法**：内部要靠 `this.ctx` 给自己的 effect 挂生命周期，
   * 所以必须保持 `slots.register(...)` 属性调用形态 —— 取出来再调会丢 `this`。
   */
  register?(spec: Record<string, unknown>, component: unknown): unknown;
  /** 等声明提交（或重建）后再跑回调；同样必须属性调用。 */
  inject?(key: string, callback: () => unknown): unknown;
}

/**
 * 显示胶囊的注销句柄（**模块级**：它由 `slots.inject` 的回调赋值，回调清理时需要看到它）。
 *
 * 单独存一份而不是塞进闭包，是因为同一个槽位声明会经历多次「建立 → 撤掉 → 再建立」，
 * 每次都要先撤掉上一份。
 */
let pillDispose: (() => void) | undefined;

/**
 * 折线图弹层的注销句柄。
 *
 * 弹层挂在**另一个槽位**（`shell.overlay`），它的声明周期与 dock 不一定同步
 * （例如窗口宽度变化时 dock 可能重注册）—— 所以两份句柄分开存，各自可撤、
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
 */
function releaseAll(): void {
  disposeChart();
  disposePill();
}

/** 一格槽位要注册什么。 */
interface SlotPlan {
  /** 槽位名。 */
  readonly name: string;
  /** 注册选项（`id` / `order` 等）。 */
  readonly spec: Record<string, unknown>;
  /** 组件。 */
  readonly component: unknown;
  /** 记账：把注销句柄交给模块级变量（`undefined` = 撤销/清空）。 */
  readonly remember: (dispose: (() => void) | undefined) => void;
  /** 日志前缀（`tps pill` / `tps chart`）。 */
  readonly label: string;
}

/**
 * 挂一格槽位（声明在就现在挂，没声明就等它）。
 *
 * 关键是把 `register` 的返回值**原样交给** `slots.inject`：那是「这次声明活着期间」
 * 的清理函数，声明撤掉时槽位系统会调用它。
 * @param slots - 宿主 `ctx.slots` 面。
 * @param plan - 要注册的内容。
 */
function mountSlot(slots: SlotsLike, plan: SlotPlan): void {
  const register = (): (() => void) => {
    /*
     * **必须写成 `slots.register(...)` 属性调用，不能先取出来再调**（2026-11-13 真机）。
     *
     * 宿主的 `slots.register` 是**原型方法**，内部要靠 `this.ctx` 挂 effect
     * （`dsh-client-ui-slots` 的注释原话：「SlotRegistry.register must stay a prototype
     * method for exactly that reason」）。写成 `const raw = slots.register; raw(...)`
     * 会把 `this` 丢掉 —— 真机报的就是
     * `TypeError: Cannot read properties of undefined (reading 'effect')`。
     */
    const off = slots.register?.(plan.spec, plan.component);
    const dispose = typeof off === "function" ? (off as () => void) : undefined;
    plan.remember(dispose);
    console.debug(`[dsh-token-tps-stats] ${plan.label}: registered into ${plan.name}`);
    return () => {
      plan.remember(undefined);
      try {
        dispose?.();
      } catch (error: unknown) {
        console.error(`[dsh-token-tps-stats] ${plan.label}: dispose failed:`, error);
      }
    };
  };
  if (typeof slots.inject === "function") {
    // 声明在 → 立刻跑；声明没提交 → 等它提交后跑；声明重建 → 再跑一次。
    // 同样保持属性调用：`slots.inject` 内部也要 `this.ctx`。
    slots.inject(plan.name, register);
    return;
  }
  // 老宿主没有 `slots.inject`：退回直接注册，失败只损失这一格。
  register();
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
     * 拿到服务之后**不要**直接 `register` —— 见文件头「为什么必须用 slots.inject」。
     */
    inject(["slots"], (scoped) => {
      try {
        const slots = (scoped as { slots?: SlotsLike }).slots;
        if (typeof slots !== "object" || slots === null || typeof slots.register !== "function") {
          console.debug("[dsh-token-tps-stats] tps: slots.register is unavailable, skipped");
          return releaseAll;
        }
        const plans: readonly SlotPlan[] = [
          {
            name: "conversation.composer.dock",
            // 负 order → 排在官方两个胶囊（轮次/步数 = 0、用量 = 1）的**左边**。
            spec: { name: "conversation.composer.dock", id: "token-tps-stats", order: -1 },
            component: TpsPill,
            remember: (dispose) => {
              pillDispose = dispose;
            },
            label: "tps pill",
          },
          {
            name: "shell.overlay",
            spec: { name: "shell.overlay", id: "token-tps-stats-chart" },
            component: TpsChart,
            remember: (dispose) => {
              chartDispose = dispose;
            },
            label: "tps chart",
          },
        ];
        for (const plan of plans) {
          // 每格独立兜底：一格挂不上不该带走另一格。
          try {
            mountSlot(slots, plan);
          } catch (error: unknown) {
            console.error(`[dsh-token-tps-stats] ${plan.label}: slot registration failed:`, error);
          }
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
