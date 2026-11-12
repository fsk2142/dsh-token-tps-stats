/**
 * 测试专用的 React 替身。
 *
 * 只在 vitest 里生效（`vitest.config.ts` 把 `react` 别名到这里）；生产产物仍然
 * `require("react")` 拿宿主的那一份 —— 别名不会进 bundle。
 *
 * ## 两条自我约束
 *
 * 1. **只实现 `createElement` 与 `Fragment`**：纯「props → 元素树」的组件可以直接调用；
 * 2. **Hook 一律抛错**：任何需要状态机的组件一旦被测试直接调用就立刻失败，而不是靠
 *    假的 Hook 实现「假装通过」。状态机住在 `tps-meter.ts`（纯函数、完整单测），
 *    React 只负责渲染 —— 这条纪律由这个替身机械地保证。
 *
 * 这与 `dsh-token-tps-stats` 的同一份纪律一致。
 */

/** 元素形状：与真实 React 元素在测试里需要的那几个字段一致。 */
export interface StubElement {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly key: string | null;
}

/**
 * 造一个元素。子节点收进 `props.children`（与 React 的约定一致）。
 * @param type - 组件或宿主标签。
 * @param properties - 属性。
 * @param children - 子节点。
 * @returns 元素描述。
 */
export function createElement(
  type: unknown,
  properties?: object | null,
  ...children: readonly unknown[]
): StubElement {
  const props: Record<string, unknown> = { ...((properties ?? {}) as Record<string, unknown>) };
  if (children.length === 1) props.children = children[0];
  else if (children.length > 1) props.children = children;
  return { type, props, key: typeof props.key === "string" ? props.key : null };
}

/** 组合片段：与真实 React 一样「不产生节点」，替身里就是一个标记。 */
export const Fragment = Symbol.for("dsh-token-tps-stats.test-react-fragment");

/** 契约违规：被测组件不该直接使用状态。 */
function hooksAreNotAvailable(name: string): never {
  throw new Error(
    `${name}() is not available in the React stand-in used by the tests: components under test must be pure functions of their props, with the state machine kept in tps-meter.ts`,
  );
}

/** 见 {@link hooksAreNotAvailable}。 */
export function useState(): never {
  return hooksAreNotAvailable("useState");
}

/** 见 {@link hooksAreNotAvailable}。 */
export function useEffect(): never {
  return hooksAreNotAvailable("useEffect");
}

/** 见 {@link hooksAreNotAvailable}。 */
export function useRef(): never {
  return hooksAreNotAvailable("useRef");
}
