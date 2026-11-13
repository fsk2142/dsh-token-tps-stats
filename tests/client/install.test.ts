/**
 * **槽位注册必须走 `slots.inject`** 的单测（2026-11-13）。
 *
 * ## 这条回归是怎么来的
 *
 * 用户重启后胶囊消失，控制台两条：
 *
 * ```
 * Error: slot "conversation.composer.dock" is not declared
 *        (a parent entry's children table must declare it)
 * Error: slot "shell.overlay" is not declared
 * ```
 *
 * 槽位声明由声明方条目在自己的生命周期里建立，窗口形态变化或条目重挂时会撤掉重建。
 * 拿到 `slots` 服务就**立刻** `register`，赌的是「激活这一刻声明已经在了」——
 * 重启后批次顺序一变就常态化失败。
 *
 * 所以这里钉住三件事：
 * 1. 服务可用时**只用** `slots.inject`，不直接 `register`；
 * 2. `inject` 的回调被调用时才真正注册，且两个槽位各自独立；
 * 3. 一格注册失败不带走另一格。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/tps-pill", () => ({ TpsPill: { component: "pill" } }));
vi.mock("../../src/client/tps-chart", () => ({ TpsChart: { component: "chart" } }));

import { installTpsPill } from "../../src/client/install";

/** 一次注册调用的记录。 */
interface Registered {
  readonly name: string;
  readonly id: string;
  readonly component: unknown;
}

/** 造一个假宿主：`ctx.inject` 直接回调，`slots` 由测试安排。 */
function makeContext(slots: unknown, _log: Registered[], injectCalls: string[]): unknown {
  return {
    inject(names: readonly string[], callback: (scoped: unknown) => unknown) {
      injectCalls.push(names.join(","));
      return callback({ slots });
    },
  };
}

describe("槽位注册：先注入声明，再注册", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("**`this` 不能丢**：直接用方法形式的假宿主（取出来再调会拿到 `undefined`）", () => {
    // 真机那次 `TypeError: Cannot read properties of undefined (reading 'effect')`
    // 就是「先把 register 取出来再调」丢了 `this`。这里用一个**依赖 this** 的对象，
    // 一旦实现又写成解构/取引用，这条会立刻红。
    const log: Registered[] = [];
    const host = {
      rows: log,
      register(spec: Registered) {
        if (this !== host) throw new TypeError("Cannot read properties of undefined (reading 'effect')");
        this.rows.push(spec);
      },
      inject(this: { register: unknown }, _key: string, callback: () => unknown) {
        if (this !== host) throw new TypeError("Cannot read properties of undefined (reading 'ctx')");
        return callback();
      },
    };
    installTpsPill(makeContext(host, log, []) as never);
    expect(log.map((row) => row.id)).toEqual(["token-tps-stats", "token-tps-stats-chart"]);
  });

  it("**服务可用时只走 `slots.inject`，不直接 register**（这是那次回归的根因）", () => {
    const log: Registered[] = [];
    const pending = new Map<string, () => unknown>();
    const ctx = makeContext(
      {
        register: (spec: Registered) => {
          log.push(spec);
        },
        inject: (key: string, callback: () => unknown) => {
          pending.set(key, callback);
        },
      },
      log,
      [],
    );
    installTpsPill(ctx as never);
    // 回调挂上了，但还什么都没注册 —— 等声明提交。
    expect(pending.size).toBe(2);
    expect(log).toHaveLength(0);
    // 声明提交：现在才注册。
    for (const callback of pending.values()) callback();
    expect(log.map((row) => row.id)).toEqual(["token-tps-stats", "token-tps-stats-chart"]);
  });

  it("声明早就存在时，`inject` 会立刻回调 → 立刻注册", () => {
    const log: Registered[] = [];
    const ctx = makeContext(
      {
        register: (spec: Registered) => {
          log.push(spec);
        },
        inject: (_key: string, callback: () => unknown) => callback(),
      },
      log,
      [],
    );
    installTpsPill(ctx as never);
    expect(log.map((row) => row.id)).toEqual(["token-tps-stats", "token-tps-stats-chart"]);
  });

  it("胶囊的 order 是 -1（排在官方两个胶囊左边）", () => {
    const log: (Registered & { order?: number })[] = [];
    installTpsPill(
      makeContext(
        {
          register: (spec: Registered & { order?: number }) => {
            log.push(spec);
          },
          inject: (_key: string, callback: () => unknown) => callback(),
        },
        log,
        [],
      ) as never,
    );
    expect(log[0]?.name).toBe("conversation.composer.dock");
    expect(log[0]?.order).toBe(-1);
  });

  it("**一格注册失败不带走另一格**（弹层挂不上时胶囊还得在）", () => {
    const log: Registered[] = [];
    const ctx = makeContext(
      {
        register: (spec: Registered) => {
          if (spec.name === "shell.overlay") throw new Error('slot "shell.overlay" is not declared');
          log.push(spec);
        },
        inject: (_key: string, callback: () => unknown) => callback(),
      },
      log,
      [],
    );
    installTpsPill(ctx as never);
    expect(log.map((row) => row.id)).toEqual(["token-tps-stats"]);
  });

  it("老宿主没有 `slots.inject` → 退回直接注册", () => {
    const log: Registered[] = [];
    installTpsPill(
      makeContext(
        {
          register: (spec: Registered) => {
            log.push(spec);
          },
        },
        log,
        [],
      ) as never,
    );
    expect(log.map((row) => row.id)).toEqual(["token-tps-stats", "token-tps-stats-chart"]);
  });

  it("拿不到 `ctx.inject` 时安静跳过（不抛）", () => {
    expect(() => installTpsPill({} as never)).not.toThrow();
  });

  it("`slots` 根本没服务时安静跳过", () => {
    expect(() => installTpsPill(makeContext(undefined, [], []) as never)).not.toThrow();
  });

  it("**嵌套注入的名字是 slots**（顶层 inject 数组必须留空）", () => {
    const injectCalls: string[] = [];
    installTpsPill(
      makeContext(
        { register: () => {}, inject: (_key: string, callback: () => unknown) => callback() },
        [],
        injectCalls,
      ) as never,
    );
    expect(injectCalls).toEqual(["slots"]);
  });
});
