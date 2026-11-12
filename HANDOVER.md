# 交接文件：dsh-token-tps-stats

> 写于 2026-11-12。上一个会话把它从 `dsh-llm-account` 里拆出来，这一份是给接手者看的。
> **2026-11-12 第 3 步已加「点击胶囊看折线图」「3 秒缓冲」「防冲高」—— 见下面「第 3 步」一节。**
> **先读这一份，再动代码。**

## 这个插件做什么

在 DSH 输入框底部那一行显示**当前会话的实时输出速度**（tok/s），排在那两个官方胶囊
（轮次/步数、用量）的左边：

```
◷ 实时输出速度（TPS）：42 tok/s   ◷ 93 轮 4047 步 · 148 tok/s   ⛁ 1159M tok · …
```

**点一下胶囊** → 在它正上方弹出最近 1 / 3 分钟的 **TPS 变化折线图**（白底卡片）。

它**只做这一件事**：不读账号、不读额度、不碰任何厂商配置、不发网络请求。

## 当前状态（接手时先核对这些）

| 项 | 值 |
| --- | --- |
| 仓库 | `C:\Work\dsh-plug-in\dsh-token-tps-stats` |
| 远端 | `git@github.com:fsk2142/dsh-token-tps-stats.git`（第 3 步后推送） |
| 版本 | `1.0.0` |
| `tsc` | 干净 |
| 单测 | **54 条全绿**（`tps-meter` 23 / `tps-history` 9 / `chart-geometry` 13 / `chart-store` 9） |
| 构建 | 成功（`lib/client.js` ≈ 62.7 KB、`lib/index.js` 1.7 KB） |
| 装进 profile | **已装**（`desktop` profile，`file:` 链接到本目录；宿主读的就是 `lib/client.js`） |
| 真机槽位 | `conversation.composer.dock` → `token-tps-stats`（order -1）；`shell.overlay` → `token-tps-stats-chart` |

## 文件职责（别搞混）

| 文件 | 职责 | 改动风险 |
| --- | --- | --- |
| `src/client/tps-meter.ts` | **计算核心**：字符→token 换算、1 秒×9 窗口、**3 秒低通**、指针衰减。纯函数 + 有状态累加器，**不碰 React、不碰宿主** | 低（有完整单测） |
| `src/client/tps-history.ts` | **折线图历史**：每秒一个桶，只保留 3 分钟；每点 = 最近 9 秒滑动平均（与胶囊同口径） | 低（有单测） |
| `src/client/chart-geometry.ts` | **折线几何**：niceMax（47→50）、刻度、SVG path。纯函数 | 低（有单测） |
| `src/client/chart-store.ts` | **弹层开关状态**：胶囊与弹层不共享 React 树，靠它交换「开没开 / 锚点 / 时长」；还存胶囊 DOM 元素供读当前矩形 | 低（有单测） |
| `src/client/styles.ts` | **共享排版与表面**：官方胶囊那套字号/行高变量、弹层的白底 + elevation 阴影 | 低 |
| `src/client/format.ts` | `formatRate`（≥10 取整、<10 一位小数，与官方同口径） | 低 |
| `src/client/tps-pill.ts` | **胶囊**：官方同款内联样式 + 仪表图标 + 点击打开弹层 + 帧到达时同时喂速度计与历史 | 中（样式改动要靠真机看） |
| `src/client/tps-chart.ts` | **弹层**：`shell.overlay` + `position: fixed`，折线图 + 时长切换 + Esc/点外面关闭 | 中 |
| `src/client/install.ts` | **注册**：嵌套注入 `uiConversation` + `slots`，注册事件定义、胶囊与弹层 | **高**（见下面「不能碰的边界」） |
| `src/client/dom.d.ts` | `window` 的最小手写声明（**只为它**，不引整套 DOM 类型） | 低 |
| `src/client/react.d.ts` | react 的最小类型声明（宿主提供，本地不装） | 低 |
| `src/client/index.ts` | 客户端入口，`apply` 只做一次 `installTpsPill` | 低 |
| `src/index.ts` | **host 入口**（空 `apply`）—— 见下面「为什么必须有它」 | 低 |

## 第 3 步做了什么（2026-11-12，用户逐条提的）

| 用户原话 | 怎么做 |
| --- | --- |
| 「这个胶囊可以点击，点击的时候显示一段折线图」 | 胶囊从 `span` 改成 `button`（保留官方 `.pill` 样式 + `cursor: pointer`）；点击把**自己的** `getBoundingClientRect()` 交给 `chart-store`，弹层读它摆位 |
| 折线图画在哪 | **不能**画在 dock 里（那里会滚动/被裁剪，胶囊只有 20px 高）。注册进 `shell.overlay`（宿主的「横贯整帧的浮层」），`position: fixed` |
| 「灰色底，希望能像官方胶囊一样用白色底」 | 之前用的 `--dsw-alias-bg-overlay` 是**半透明**色 → 叠在内容上必然发灰。改成 `--dsw-alias-bg-base`（浅色 = 白），配 `--dsw-elevation-prominent` 阴影 |
| 「字体也要保持一致」 | 新增 `styles.ts`，胶囊与弹层**共用** `--dsh-content-font-size-secondary` / `--dsh-content-font-delta-secondary` 那套变量，不再写死 12px |
| 「折线颜色，还有其他文字的字体颜色，和官方那个保持一致」 | 折线、标题、副标题、刻度、轴标签**全部**改用 `INK` = `--dsw-alias-label-tertiary`（就是官方 `.pill` 那一条 `color:`）；标题去掉 `font-weight: 600`。唯一例外是**选中的时长按钮**用 `label-secondary`（不选就分不出选了哪个） |
| 「变化速度上升太快、下降也太快，做个 3 秒缓冲」 | `tps-meter` 加一层**一阶低通**（τ = `TPS_FOLLOW_MS` = 3s）；衰减常数 `TPS_DECAY_MS` 从 700ms 改成 3s，并且从**显示值**衰减 |
| 「偶尔冲到峰值 300 多，完全不真实」 | 根因：旧实现只把「已经有数据的窗口」计入分母，停顿后突然一大段时相当于单窗口求平均 → 1200 字符≈286 token 直接读成 286。现在**分母固定 9**、空窗按 0，同样一段读成 ≈32 |

`tps-history` 的历史桶**也**改成同一口径（分母固定），否则折线图的点还会顶到天上。

## 为什么 host 入口是空实现

宿主的 `client-modules` 启动图扫描只认两种行名：

- **裸包名**（不含 `/`）→ 识别为包根 → 产生客户端 source，界面显示短名；
- **路径写法**（`./lib/client.js`）→ 也产生 source，但界面会显示成宿主改写后的绝对
  `file:` URL（长且暴露本机路径）。

界面要体面就只能用裸包名；裸包名会解析到 `package.json` 的 `main` → `lib/index.js`，
那个文件**必须导出 `apply`**，否则这一行不算有效插件。

所以 `src/index.ts` 是一个**明确的空实现**，不是占位符 —— 这个插件真的没有 host 侧工作。
**不要删它，也不要往里加逻辑。**

## 不能碰的边界（每一条都是真机踩出来的）

### 1. 顶层 `inject` 必须保持为空数组

`src/client/index.ts` 里 `export const inject = []`。所有需要的服务
（`uiConversation`、`slots`）都走 `ctx.inject([...], cb)` 的**嵌套注入**。

**为什么**：顶层 `inject` 里列出的服务缺失时，cordis 会判定**整个客户端包激活失败** ——
用户的设置页与侧边栏会一起消失。嵌套注入最坏只是「这个功能不显示」。

### 2. `events.register` 必须挂在对象上调用

```ts
// 对
(target.register as ...).call(target, definition())
// 错 —— this 会变成 undefined，抛 "Cannot read properties of undefined (reading 'registerDefinition')"
const register = events.register
register(definition())
```

宿主的 `register` 是 class 方法，内部第一句就是 `this.registerDefinition(...)`。

### 3. 事件定义的 `role` 必须按 turn/step 的 id 变化判 start

```ts
// 对
const isFirstForStream = id !== lastStreamId
// 错 —— 一旦某轮收到过文本，chars 永不为 0，下一轮第一帧会被报成 update
// 而宿主对 update 要求已有 Context，没有就丢弃 → 之后每轮第一帧都丢，速度恒为 0
const role = chars === 0 ? "start" : "update"
```

### 4. 计时一律用本地墙钟（`Date.now()`）

**不要**用 `event.time`。读数侧用的是 `Date.now()`，两个时钟基准不同时
`at - latest` 会算成一个很大的值，直接落进「空闲」分支，读数恒为 `undefined`（显示 0）。

### 5. 窗口边界是**左开右闭**

```ts
if (key > from && key <= to)  // 对
if (key >= from && key < to)  // 错 —— 会把「正好当前时刻的帧」排除，数字闪一下就没
```

### 6. `ctx.remote` 是服务代理，读未注入成员会**抛**

任何 `remote?.xxx` 的写法都要把**属性访问本身**包进 `try/catch` —— 可选链只挡
`null`/`undefined`，挡不住 get 陷阱 throw。（本插件目前不碰 `remote`。）

### 7. 胶囊与弹层是**两个槽位、两棵 React 树**，只能靠 `chart-store` 通信

不要试图把弹层塞进胶囊组件里（dock 会裁剪浮层）；也不要把开关状态放进胶囊的
`useState`（传不到另一个槽位）。反过来，**关闭时一定要清掉锚点**，否则下次打开的第一帧
会用旧位置。

### 8. 点「外面」用 `pointerdown`，不要用 `click`

胶囊自己也是 `click`。两个都处理会变成「先关再开」，看起来像点不动。
现在 `pointerdown` 捕获阶段只负责「点弹层/胶囊之外就关」，胶囊的 `click` 决定开还是关。

### 9. 弹层位置**每次重画都重读**胶囊矩形

弹层开着时用户会滚动页面、拖窗口。`chart-store.setPillElement` 存的是元素，
`readPillRect()` 每次现读；`ref` 回调必须是**模块级常量**（内联箭头函数每次渲染都换
引用，React 会先 `ref(null)` 再 `ref(node)`，中间一帧读到空）。

### 10. 弹层字符用 `bg-base`，不要 `bg-overlay`

`--dsw-alias-bg-overlay` 是半透明色，叠在聊天内容上会发灰 —— 这正是用户报的「灰色底」。

## 算法说明（改数字前先读）

### 换算（估算，不是精确值）

```
tokens ≈ CJK字符 × 1.0 + 其它字符 ÷ 4.2
```

**来源**：本机真实数据回归 —— 25 个会话 / 19415 条回复 / 69,248,359 字符 →
13,780,630 outputTokens = **5.03 字符/token**，其中 CJK 占 3.1%。
**为什么必须估算**：流式 chunk 里只有字符，真实 token 要等流结束、宿主给出 `usage`。
**质量控制**：`代码密集时偏高、纯中文时偏低`。反映趋势，不是账单。

### 两层平滑

```
帧 → 毫秒桶 → 最近 9 秒平均（目标值）→ 3 秒低通 → 显示值
```

- **9 窗口**（`TPS_WINDOWS`，用户明确要求「至少 9 个」）。**分母固定 9、空窗按 0** ——
  这就是防冲高的核心（改回「只数有数据的窗口」会立刻把 300 多那个 bug 还回来）。
- **3 秒低通**（`TPS_FOLLOW_MS`）：`显示 += (目标 - 显示) × (1 - e^(-dt/τ))`。
  单步最多消化 `TPS_FOLLOW_MAX_STEP_MS`（1s）—— 空闲时组件停表，帧突然回来时 `dt`
  可能好几秒，不设上限就一步跳到目标，缓冲等于没做。
- 首次读数从 **0** 起步（不是直接取目标），所以插件在流式中途挂载也是慢慢爬上去。

### 指针回落

- 超过 `TPS_IDLE_GRACE_MS = 800ms` 没有新帧 → 认为「停了」；
- 从**显示值**（不是目标值）按指数衰减（τ = `TPS_DECAY_MS` = 3s）往下滑；
- 低于 `0.5 tok/s` 视为 0。

**用户明确要求**：空闲时**显示 `0 tok/s`，不要消失**（所以 `readingAt` 返回 0 而不是
`undefined`）。组件的定时器在归零后**停表**，新帧到达再重启 —— 空闲时零开销。

### 计数范围

只认 `text-delta` 与 `reasoning-delta`（思考也是真实产出的 token）。
`usage` / `block-start` / `block-end` 不含文本，忽略。

## 样式要点

胶囊的字体**必须**显式覆盖，否则会继承容器默认值、和旁边官方胶囊差一档。这些值现在
统一在 `styles.ts`（`TYPO` / `SURFACE` / `MUTED` / `HAIRLINE` / `ACCENT`）：

```ts
FONT_SIZE_SECONDARY  = "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)"
LINE_HEIGHT_SECONDARY = "calc(20px + var(--dsh-content-font-delta-secondary, 0px))"
PILL_STYLE: padding "1px 8px", gap "6px", borderRadius "var(--dsw-radius-sm)"
SURFACE: background var(--dsw-alias-bg-base), boxShadow var(--dsw-elevation-prominent)
```

这些是逐条照抄宿主 `StatsPills` 模块的规则（从 `dsh-client-ui-chat` 的 CSS 读出）。
**代价**：宿主改名这些变量时会退回兜底值。**没有**直接用它的 CSS Module 类名
（那更脆弱）。

仪表图标用的是宿主图标集里 `gauge-outline` 的几何（`viewBox 0 0 16 16`、
`stroke-width 1`、三段 path：外弧 + 指针 + 圆心实心点）。自画版本缺圆心点、stroke 偏粗，
用户明确说过「有点小、对比官方不太好看」。

## 安装与验证

### 改完源码

```bash
pnpm typecheck && pnpm test && pnpm build
```

**必须 `pnpm build`**：profile 用 `file:` 链接到本目录，宿主读 `lib/client.js`，
只改 `src/` 不会生效。

### 装进 profile

```bash
# 通过插件管理器（写 profile 的 package.json + bundles）
#   install_bundle target = C:\Work\dsh-plug-in\dsh-token-tps-stats
# 或者手工在 profile 的 package.json 里加：
"dsh-token-tps-stats": "file:C:/Work/dsh-plug-in/dsh-token-tps-stats"
```

**需要重启 DSH 才会加载新 bundle。**

### 重启后在控制台确认

```
[dsh-token-tps-stats] tps pill: registered into conversation.composer.dock (order -1)
[dsh-token-tps-stats] tps chart: registered into shell.overlay
```

两条都在 = 槽位与注入都正常。只有第一条 = 弹层没挂上（dock 里的胶囊仍然可用）。

### 免刷新的布局核对

`cordis_inspect_query` → Client `Slots.listSubTree`：
- `conversation.composer.dock` 的 occupants 里应有 `token-tps-stats`（order -1）；
- `shell.overlay` 的 occupants 里应有 `token-tps-stats-chart`。

## 已知的未完成项

| 项 | 说明 |
| --- | --- |
| **没有设置开关** | 当前默认常开。用户曾说「设置里加个开关」，但**没确认**开关放哪（厂商 schema 还是独立设置）。注意：它**不该**进任何 vendor schema —— 与厂商无关 |
| **没做真实的 tok/s 对照** | 没有拿官方那个 `148 tok/s` 与我们的估算做过同一时刻的并排对比。若用户报「数字偏 high/low」，先做这件事再调 4.2 |
| **没在真机上肉眼验收过弹层** | 本会话没有浏览器控制能力（Web GUI 需要登录令牌），只验证了 slot 注册与产物内容。白底/字号/位置都需要用户看一眼确认 |
| **`estimates` 的服务端验证** | 换算系数来自本机数据，换模型族（比如纯中文场景）可能需要重新标定 |

## 排查清单

| 症状 | 先看 |
| --- | --- |
| 胶囊完全不出现 | 控制台有没有 `tps pill: registered`；没有就是槽位或注入问题 |
| 点了没反应 | 控制台有没有 `tps chart: registered`；没有就是 `shell.overlay` 没挂上 |
| 弹层灰色底 | `SURFACE.background` 是不是又被改回 `--dsw-alias-bg-overlay` |
| **折线图区域是灰的，但卡片是白的** | 曲线下方是不是又铺了面积填充（`color-mix(brand-primary 12%)`）—— 本主题的 brand-primary 是**近黑色**，12% 近黑叠在白卡片上就是一片灰。2026-11-12 已去掉该填充，只画线 |
| 弹层字与胶囊不一致 | 弹层是不是又写死了 `fontSize: 12px` 或 `fontWeight: 600`（应走 `TYPO` / `INK`，标题与正文同级） |
| 折线比旁边胶囊黑一档 | 折线是不是又用了 `ACCENT`/`brand-primary`（应为 `INK` = `label-tertiary`） |
| 点胶囊后弹层闪烁/开不动 | `pointerdown` 里是不是漏了放过 `PILL_ATTRIBUTE` |
| 弹层位置飘 | `readPillRect()` 是否仍在每次重画时调用；`ref` 回调是否仍是模块级常量 |
| 数字始终 0 | 检查 `arrivalTime` 是否被改回 `event.time`；检查 `role` 判定是否被改回 `chars===0` |
| 数字闪一下就没 | 检查窗口边界是否写成 `>= from && < to` |
| **偶尔冲到 300 多** | `windowedRate` 的分母是不是又变回「只数有数据的窗口」 |
| 数字升太快/降太快 | `TPS_FOLLOW_MS` / `TPS_DECAY_MS`（现都是 3000） |
| 数字偏高/偏低 | 先和官方胶囊并排对比，再考虑调 `OTHER_CHARS_PER_TOKEN`（现 4.2） |
| 控制台 `Forced reflow` 警告 | 组件的定时器是否在归零后仍然跑（应该在归零时 `stop()`） |

## 纪律（这个仓库沿用的）

- **先写失败回归，再改代码**；不要改断言去迁就新行为；
- 注释里写「为什么」而不是「做什么」，尤其是踩过的坑；
- **不要**为了减少行数把 `tps-meter.ts` 拆成多个小文件；
- 新增任何「每 tick 都跑」的定时器前，先想清楚空闲时它会不会空转；
  弹层已经遵守这条：**只有打开时**才有 500ms 的定时器。
