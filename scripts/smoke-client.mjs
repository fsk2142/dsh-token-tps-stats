/**
 * **产物冒烟测试**：用带 `this` 语义的假宿主跑一遍构建后的 `lib/client.js`。
 *
 * 这里为什么不用 vitest 的源码测试：要验证的正是「构建产物在真实调用形态下会不会
 * 丢 `this`」。宿主的 `slots.register` / `slots.inject` 都是**原型方法**，内部靠
 * `this.ctx` 挂 effect（`dsh-client-ui-slots` 原文：「SlotRegistry.register must
 * stay a prototype method for exactly that reason」）。2026-11-13 真机那次
 * `TypeError: Cannot read properties of undefined (reading 'effect')` 就是取引用
 * 再调用的后果。
 *
 * 用法：`node scripts/smoke-client.mjs`（构建之后跑）。
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** 宿主那两个槽位（按它们是否被注册过来判定插件是否真的挂上了）。 */
const registered = [];
const errors = [];

const slots = {
  register(spec) {
    if (this !== slots) throw new TypeError("Cannot read properties of undefined (reading 'effect')");
    registered.push(spec.id);
    return () => {};
  },
  inject(key, callback) {
    if (this !== slots) throw new TypeError("Cannot read properties of undefined (reading 'ctx')");
    callback();
    return () => {};
  },
};

let captured;
const window = { __ModuleLoader__: { load: (registration) => {
  captured = registration;
} } };

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  Component: class {},
};

const context = {
  window,
  require: (id) => {
    if (id === "react") return react;
    throw new Error(`unexpected require("${id}")`);
  },
  console: {
    debug: () => {},
    error: (...args) => errors.push(args.map(String).join(" ")),
  },
  setTimeout, clearTimeout, setInterval, clearInterval, Date,
  inject: (_names, callback) => {
    callback({ slots });
    return () => {};
  },
};
context.globalThis = context;
createContext(context);
runInContext(code, context);

const exports = captured.factory(context.require);
exports.apply(context);

console.log("registered:", registered.join(", ") || "(none)");
console.log("errors:", errors.length === 0 ? "(none)" : errors.join(" | "));

const ok = registered.join(",") === "token-tps-stats,token-tps-stats-chart" && errors.length === 0;
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exitCode = ok ? 0 : 1;
