/**
 * 浏览器环境里本仓库**用得到的那一点点全局声明**。
 *
 * 为什么不是加 `"lib": ["DOM", "DOM.Iterable"]`：那会一次性引入整套 DOM 类型，
 * 让「这个客户端包到底碰了浏览器什么」变得看不出来，而宿主侧的 `src/index.ts`
 * 也会跟着拿到一批它根本不该用的全局名字。
 *
 * 这里只声明真正用到的：`window`（视口尺寸与事件）。DOM 节点一律**鸭子类型**处理
 *（`parentNode` 链 + `hasAttribute` + `getBoundingClientRect`），见 `tps-chart.ts` 的
 * `insideAttribute` 与 `tps-pill.ts` 的 `anchorOf` —— 这样连 `Node` / `Element`
 * 这两个全局名字都不需要，也不会和 `@types/node` 里的同名声明抢位置。
 *
 * 与 `react.d.ts` 同一套纪律：**手写的窄声明**，不做标准之外的扩展。
 */

/** 一个最小的事件对象（键盘要 `key`，指针要 `target`，都要 `stopPropagation`）。 */
export interface DshEvent {
  readonly key?: string;
  readonly target?: unknown;
  stopPropagation?(): void;
}

/** 视口尺寸与窗口事件（只列用到的成员）。 */
export interface DshWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: string, listener: (event: DshEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: DshEvent) => void, capture?: boolean): void;
}

declare global {
  /** 浏览器里的 window（宿主侧 `platform: node` 的产物里不会执行到这些代码）。 */
  // eslint-disable-next-line no-var
  var window: DshWindow;
}
