# 交接文件：dsh-token-tps-stats

> 写于 2026-11-12。上一个会话把它从 `dsh-llm-account` 里拆出来，这一份是给接手者看的。
> **先读这一份，再动代码。**

## 这个插件做什么

在 DSH 输入框底部那一行显示**当前会话的实时输出速度**（tok/s），排在那两个官方胶囊
（轮次/步数、用量）的左边：

```
◷ 实时输出速度（TPS）：42 tok/s   ◷ 93 轮 4047 步 · 148 tok/s   ⛁ 1159M tok · …
```

它**只做这一件事**：不读账号、不读额度、不碰任何厂商配置、不发网络请求。

## 当前状态（接手时先核对这些）

| 项 | 值 |
| --- | --- |
| 仓库 | `C:\Work\dsh-plug-in\dsh-token-tps-stats` |
| 版本 | `1.0.0` |
| 最新提交 | `f96f672`（初始提交）+ 之后一条「槽位 id 改名」 |
| 远端 | **没有**。需要接手者建 GitHub 仓库并推送 |
| `tsc` | 干净 |
| 单测 | 16 条全绿（`tests/client/tps-meter.test.ts`） |
| 构建 | 成功（`lib/client.js` ≈ 27.7 KB、`lib/index.js` 1.6 KB） |
| 装进 profile | **尚未**。见下面「安装」一节 |

## 文件职责（别搞混）

| 文件 | 职责 | 改动风险 |
| --- | --- | --- |
| `src/client/tps-meter.ts` | **计算核心**：字符→token 换算、1 秒×9 窗口、指数衰减。纯函数 + 有状态累加器，**不碰 React、不碰宿主** | 低（有完整单测） |
| `src/client/tps-pill.ts` | **显示**：React 组件 + 官方同款内联样式 + 仪表图标 | 中（样式改动要靠真机看） |
| `src/client/install.ts` | **注册**：嵌套注入 `uiConversation` + `slots`，注册事件定义与胶囊 | **高**（见下面「不能碰的边界」） |
| `src/client/react.d.ts` | react 的最小类型声明（宿主提供，本地不装） | 低 |
| `src/client/index.ts` | 客户端入口，`apply` 只做一次 `installTpsPill` | 低 |
| `src/index.ts` | **host 入口**（空 `apply`）—— 见下面「为什么必须有它」 | 低 |

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

任何 `remote?.xxx` 的写法都要把**属性访问本身**包进 `try/catch` ——
可选链只挡 `null`/`undefined`，挡不住 get 陷阱 throw。
（这条在账号插件里踩过一次，本插件目前不碰 `remote`，但将来加设置项会碰到。）

## 算法说明（改数字前先读）

### 换算（估算，不是精确值）

```
tokens ≈ CJK字符 × 1.0 + 其它字符 ÷ 4.2
```

**来源**：本机真实数据回归 —— 25 个会话 / 19415 条回复 / 69,248,359 字符 →
13,780,630 outputTokens = **5.03 字符/token**，其中 CJK 占 3.1%。

**为什么必须估算**：流式 chunk 里只有字符，没有 token 数。真实 token 要等流结束、
宿主给出 `usage` 才有。

**质量控制**：`代码密集时偏高、纯中文时偏低`。它反映趋势，不是账单。

业界主流也是启发式估算，参考：
- [token-metrics](https://socket.dev/npm/package/token-metrics)
- [Qwen 的 estimate_token_counter](https://github.com/rayrayraykk/CoPaw/blob/86fda39f95d5557b60952c85c1a25923e9c8f918/src/qwenpaw/agents/utils/estimate_token_counter.py)

### 平滑

- **1 秒窗口 × 9 个窗口**（用户明确要求「至少 9 个」，3 个会跳）；
- **空窗按 0 计入平均**（一旦这段时间有过输出）。跳过空窗会系统性高估 ——
  9 窗口下尤其明显，且停机时数字会僵在高位不掉；
- 代价：对速度突变的反应慢约 **4~5 秒**。这是用户接受的取舍（平滑优先）。

### 指针回落

- 超过 `TPS_IDLE_GRACE_MS = 800ms` 没有新帧 → 认为「停了」；
- 从最后一次读数按**指数衰减**（τ = `TPS_DECAY_MS` = 700ms）往下滑；
- 低于 `0.5 tok/s` 视为 0。

**用户明确要求**：空闲时**显示 `0 tok/s`，不要消失**（所以 `readingAt` 返回 0 而不是 `undefined`）。
组件的定时器在归零后**停表**，新帧到达再重启 —— 空闲时零开销。

### 计数范围

只认 `text-delta` 与 `reasoning-delta`（思考也是真实产出的 token）。
`usage` / `block-start` / `block-end` 不含文本，忽略。

## 样式要点

胶囊的字体**必须**显式覆盖，否则会继承容器默认值、和旁边官方胶囊差一档：

```ts
ANCHOR_STYLE.fontSize  = "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)"
ANCHOR_STYLE.lineHeight = "calc(20px + var(--dsh-content-font-delta-secondary, 0px))"
PILL_STYLE.padding = "1px 8px", gap = "6px", borderRadius = "var(--dsw-radius-sm)"
```

这些是逐条照抄宿主 `StatsPills` 模块的规则（从 `dsh-client-ui-chat` 的 CSS 读出）。
**代价**：宿主改名这些变量时，会退回兜底值 13px，可能又对不上 —— 抄私有样式的固有风险。
**没有**直接用它的 CSS Module 类名（那更脆弱）。

仪表图标用的是宿主图标集里 `gauge-outline` 的几何（`viewBox 0 0 16 16`、
`stroke-width 1`、三段 path：外弧 + 指针 + 圆心实心点）。自画版本缺圆心点、stroke 偏粗，
用户明确说过「有点小、对比官方不太好看」。

## 安装

### 方式 A：本地路径（最快）

profile 的 `package.json` 里加：

```json
"dsh-token-tps-stats": "file:C:/Work/dsh-plug-in/dsh-token-tps-stats"
```

### 方式 B：推 GitHub 后按 commit 安装

先建仓库并推送，然后让插件管理器按
`https://codeload.github.com/fsk2142/dsh-token-tps-stats/tar.gz/<commit>` 安装。

**两种都需要重启 DSH。**

## 接手后第一件该做的事

1. **确认和账号插件的胶囊不重复**：`dsh-llm-account`（现在 2.1.31）里**还带着**同一份
   tok/s 胶囊，槽位 id 是 `llm-account-tps`、`order: -1`。两个都装会看到**两个 tok/s**。

   要从账号插件里摘掉的部分：
   - `src/client/tps-meter.ts`、`tps-pill.ts`、`tps-probe.ts`（三个文件都可删）
   - `src/client/index.ts` 第 17 行 import 与第 137 行 `guarded(...)` 调用
   - `tests/client/tps-meter.test.ts`、`tps-probe.test.ts`
   - `tests/client/registry.test.ts` 里那条断言（早期版本是 4 条注入，
     当前账号插件里已经写成 `["uiConversation", "slots"]`，摘除后要改回 4 条）
   - `tests/client/bundle-smoke.test.ts` 里放宽过的那条（摘除后可恢复严格）

2. **核对产物**：`lib/client.js` 里应有 `conversation.composer.dock`、`order: -1`、
   `id: "token-tps-stats"`、`实时输出速度（TPS）`、`dsh-content-font-size-secondary`。

3. **重启后在控制台确认**：`[dsh-token-tps-stats] tps pill: registered into conversation.composer.dock (order -1)`

## 已知的未完成项

| 项 | 说明 |
| --- | --- |
| **没有设置开关** | 当前默认常开。用户曾说「设置里加个开关」，但**没确认**开关放哪（厂商 schema 还是独立设置）。注意：它**不该**进任何 vendor schema —— 与厂商无关 |
| **没有 push 到 GitHub** | 仓库刚 `git init`，无远端 |
| **没做真实的 tok/s 对照** | 没有拿官方那个 `148 tok/s` 与我们的估算做过同一时刻的并排对比。若用户报「数字偏high/low」，先做这件事再调 4.2 |
| **`estimates` 的服务端验证** | 换算系数来自本机数据，换模型族（比如纯中文场景）可能需要重新标定 |

## 排查清单

| 症状 | 先看 |
| --- | --- |
| 胶囊完全不出现 | 控制台有没有 `tps pill: registered`；没有就是槽位或注入问题 |
| 数字始终 0 | 检查 `arrivalTime` 是否被改回 `event.time`；检查 `role` 判定是否被改回 `chars===0` |
| 数字闪一下就没 | 检查窗口边界是否写成 `>= from && < to` |
| 数字跳得太乱 | 窗口数（`TPS_WINDOWS`，现 9）或衰减时间 |
| 数字偏高/偏低 | 先和官方胶囊并排对比，再考虑调 `OTHER_CHARS_PER_TOKEN`（现 4.2） |
| 控制台 `Forced reflow` 警告 | 组件的定时器是否在归零后仍然跑（应该在归零时 `stop()`） |

## 纪律（这个仓库沿用的）

- **先写失败回归，再改代码**；不要改断言去迁就新行为；
- 注释里写「为什么」而不是「做什么」，尤其是踩过的坑；
- **不要**为了减少行数把 `tps-meter.ts` 拆成多个小文件；
- 新增任何「每 tick 都跑」的定时器前，先想清楚空闲时它会不会空转。
