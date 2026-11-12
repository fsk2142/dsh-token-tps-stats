import { defineConfig, type UserConfig } from "tsdown";

const PACKAGE_NAME = "dsh-token-tps-stats";

/**
 * 宿主通过加载器的 `require` 提供的模块：**必须保持 external**。
 * 把它们 inline 进浏览器产物会得到第二份 React 实例，hooks 立刻失效。
 */
const CLIENT_EXTERNALS = ["react", "react/jsx-runtime"];

/**
 * Host 入口。
 *
 * 这个插件**没有 host 侧逻辑**：速度是靠客户端订阅 `assistant/live-chunk` 算出来的。
 * 但仍然需要一个 `lib/index.js` —— `cordis.patch.yml` 用**裸包名**插一行，宿主会把它
 * 当插件加载，所以根入口必须导出 `apply`（哪怕是个空实现）。
 *
 * `entry` 用对象映射：数组形式会让产物落到 `lib/src/...`，与 `package.json` 的
 * `./lib/index.js` 对不上。
 */
const hostConfig: UserConfig = {
  name: `${PACKAGE_NAME}/host`,
  entry: { index: "src/index.ts" },
  outDir: "lib",
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  // tsdown 在 node 平台默认强制 `.mjs`；本包是 `type: module`，且 patch 按包名
  // 解析 main → `lib/index.js`。
  fixedExtension: false,
  deps: { neverBundle: ["@deepseek-ai/schemastery"] },
};

/**
 * 浏览器入口：那个 tok/s 胶囊。
 *
 * 与 `dsh-llm-account` 同一套包装：宿主 loader 用
 * `window.__ModuleLoader__.load({ id, factory })` 包住产物，`require` 由 loader 注入，
 * 最后读 `module.exports` 上的 `{ apply, inject }`。
 */
const clientConfig: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  // 别漏：否则按 engines.node 编译，浏览器跑不了。
  target: "es2022",
  dts: false,
  // 不能清空 host 产物。
  clean: false,
  outputOptions: {
    entryFileNames: "client.js",
    banner: [
      "window.__ModuleLoader__.load({",
      `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
      "\tfactory: (require) => {",
    ].join("\n"),
    intro: "\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;",
    footer: "\t\treturn module.exports;\n\t}\n});",
  },
  deps: { neverBundle: [...CLIENT_EXTERNALS] },
};

export default defineConfig([hostConfig, clientConfig]);
