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
 *
 * ## 为什么开 `minify`（2026-11-13 用户要求「优化加载速度」）
 *
 * 这个产物的注释很多（设计决策都写在源码里，源码注释会被完整搬进 `.js`）——
 * 不压缩时 72.6 KB 里有约 20 KB 是注释。注释不影响正确性，但**要浏览器解析**，
 * 而这段代码是页面启动链路里的一环。压缩后只剩可执行语义，解析量直接少三成。
 *
 * `minify: true`（而不是默认的 `"dce-only"`）才是真正去掉注释 / 缩短标识符的那档。
 * banner / intro / footer 是**addon**（在压缩之后拼接），所以 `module` 与 `exports`
 * 那两个名字不会被改名或删掉 —— 压缩完仍要能跑 `require` 注入那套协议。
 *
 * ## 为什么没有 `immediately`
 *
 * `dsh.client.immediately` 会让这个包在启动阶段**立刻**变成真实模块。我们只是往两个
 * 槽位注册组件，不需要抢跑道；不设它，宿主按需物化（第一次 `require` 时才执行工厂），
 * 首屏更轻。
 */
const clientConfig: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  // 别漏：否则按 engines.node 编译，浏览器跑不了。
  target: "es2022",
  minify: true,
  dts: false,
  // 不能清空 host 产物。
  clean: false,
  // `format: cjs` 时 rolldown 会忽略 `platform: 'browser'`；这里显式指定，
  // 免得它按 Node 的假设做替换（浏览器里没有 `process` / `node:` 模块）。
  inputOptions: { platform: "browser" },
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
