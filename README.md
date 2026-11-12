# dsh-token-tps-stats

在 DSH 输入框底部那一行显示**当前会话的实时输出速度**（tok/s），排在那两个官方胶囊
（轮次/步数、用量）的左边。

## 它长什么样

```
◷ 实时输出速度（TPS）：42 tok/s   ◷ 93 轮 4047 步 · 148 tok/s   ⛁ 1159M tok · …
```

- 模型在流式输出时数字**持续跳动**；
- 停下来后按指数衰减**逐渐降低**，像汽车速度表松油门（τ = 700ms）；
- 完全没有动作时**固定在 `0 tok/s`**（不会消失）。

## 数据从哪来

订阅宿主的 `assistant/live-chunk` 事件（客户端事件，逐帧到达），
统计 `text-delta` 与 `reasoning-delta` 的字符数（思考也是模型真实产出的 token）。

## 为什么是「估算」

流式 chunk 里**只有字符**，没有 token 数 —— 真实 token 数要等这一轮流结束、
宿主给出 `usage` 才有。所以实时速度只能换算：

```
tokens ≈ CJK字符 × 1.0 + 其它字符 ÷ 4.2
```

这两个系数不是拍脑袋的：用本机真实数据回归得出（25 个会话 / 19415 条回复 /
69,248,359 字符 → 13,780,630 outputTokens = **5.03 字符/token**，其中 CJK 占 3.1%）。
业界主流做法也是启发式估算（[token-metrics](https://socket.dev/npm/package/token-metrics)、
[Qwen 的 estimate_token_counter](https://github.com/rayrayraykk/CoPaw/blob/86fda39f95d5557b60952c85c1a25923e9c8f918/src/qwenpaw/agents/utils/estimate_token_counter.py)）。

**代码密集时会偏高，纯中文时会偏低** —— 它反映的是趋势，不是账单。

## 平滑口径

- **1 秒窗口 × 9 个窗口**：对最近约 9 秒做平均，数字稳；
- 代价是对速度突变的反应慢约 4~5 秒；
- 一旦这段时间有过输出，**空窗按 0 计入**（否则「最近 N 秒平均」会系统性高估）；
- 超过 800ms 没有新帧才认为「停了」，改用指数衰减。

## 安装

```bash
pnpm install
pnpm build
```

然后在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加上本包，
或直接让插件管理器按 git 地址安装。

## 门槛

- Node ≥ 22.19.0
- DSH ≥ 0.2.0-rc.2

## 它**不**做什么

- 不读账号、不读额度、不碰任何厂商配置 —— 它只跟「当前会话正在流出多少字」有关；
- 不发任何网络请求；
- 不改任何既有插件的行为。注册失败时只打一行 `console.error`，失败半径只有这一个胶囊。

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsdown
```
