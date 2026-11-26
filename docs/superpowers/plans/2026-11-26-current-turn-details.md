# 当前轮次细则 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 TPS 弹层中增加第三个页签「本轮细则」，只汇总当前轮次的生成速度、响应耗时、token 用量与输出比例。

**Architecture:** 新增一个不依赖 React 的纯聚合模块，从 `legacy.nodes` 与运行中步骤信息计算 `TurnDetails`；`SessionStream` 只负责保存原始 nodes 与运行中 turn/step；渲染层把聚合结果画成第三页，复用现有面板定位、滚动、焦点与主题。

**Tech Stack:** TypeScript、React（宿主提供）、Vitest、现有 CJS 客户端构建。

**Spec:** `docs/superpowers/specs/2026-11-26-current-turn-details-design.md`

## Global Constraints

- 只统计当前轮次；不做会话总计、上下文上限、工具调用次数。
- 运行中 token 沿用现有估算：CJK 1 字/token，其它 4.2 字符/token。
- 速度显示整数；缓存率两位小数；秒数两位小数；token 千分位。
- 数据缺失、时间倒挂或分页缺头时显示 `—`，不编造。
- 现有胶囊实时速度与「每步平均」表行为不变。
- 三个页签共享现有面板宽度与最小高度；复用现有定位、滚动、sticky 表头与焦点管理。
- 不新增网络请求、宿主服务或跨插件 DOM 读取。

## Review Focus

- 当前轮次缺少最早步骤（观测到的最小 `step > 1`）时，总耗时与端到端速度必须为 `undefined`，不能用不完整起点硬算。
- 运行中步骤与已结算节点出现同一 `turn:step` 时，必须忽略运行中估算，不能重复计 token 或步数。
- 有输出但缺少 `firstTokenTime` / `completedTime` 时，生成耗时与流式速度必须为 `undefined`，不能只拿部分步骤硬算。
- 工具-only 的零输出步骤没有首 token 时间时，不能污染生成耗时；但仍应计入步数与端到端总时长。
- 缓存率与思维链比例缺少字段或分母不合法时显示 `undefined`，不能把缺失当 0 或给出半真半假的百分比。

---

### Task 1: 当前轮次纯聚合器

**Files:**
- Create: `src/client/turn-details.ts`
- Test: `tests/client/turn-details.test.ts`

**Interfaces:**
- Produces:
  - `RunningStepRef { turn: number; step: number }`
  - `TurnDetailsInput { nodes: readonly unknown[]; running?: RunningStepRef; runningTokens: number; liveSpeed: number; now: number }`
  - `TurnDetails { turn: number; steps: number; running: boolean; totalMs?: number; ttftMs?: number; generationMs?: number; outputTokens?: number; streamSpeed?: number; endToEndSpeed?: number; cacheHitRatio?: number; reasoningRatio?: number }`
  - `turnDetailsOf(input: TurnDetailsInput): TurnDetails | undefined`

- [ ] **Step 1: 写失败测试**

建立两个助手节点 fixture：第 61 轮步骤 1（600 输出、180 思维链、900 缓存读取、100 输入、1600 总量；`1000/2000/5000`）与步骤 2（400 输出、200 思维链、1800 缓存读取、200 输入、2400 总量；`6000/7000/9000`）。核心断言：

```ts
expect(turnDetailsOf({ nodes, now: 10_000, runningTokens: 0, liveSpeed: 0 })).toMatchObject({
  turn: 61,
  steps: 2,
  running: false,
  totalMs: 8_000,
  ttftMs: 1_000,
  generationMs: 5_000,
  outputTokens: 1_000,
  streamSpeed: 200,
  endToEndSpeed: 125,
  cacheHitRatio: 0.9,
  reasoningRatio: 0.38,
});
```

同一文件再覆盖：旧轮次忽略、重复步骤采用最新节点、工具-only 零输出步骤、缺头步骤、输出步骤缺时间、运行中步骤合并、运行中与已结算步骤去重、缓存/思维链字段缺失、非法 nodes。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/client/turn-details.test.ts`
Expected: FAIL，`turn-details` 模块或 `turnDetailsOf` 尚不存在。

- [ ] **Step 3: 实现纯聚合器**

在 `src/client/turn-details.ts` 实现上述接口。规则：

- 当前轮次取有效 running.turn 与 assistant nodes 最大 turn 的较大者。
- 节点按 `turn:step` 去重，后出现的覆盖先出现的。
- 步数取当前轮次去重步骤与未结算 running.step 的并集。
- 总时长要求当前轮次最小观测步骤为 1，且最早步骤有有效 `stepStartTime`；否则 `totalMs` / `endToEndSpeed` 为 `undefined`。
- 生成耗时只汇总 `outputTokens > 0` 且 `completedTime > firstTokenTime >= stepStartTime` 的步骤；任一有输出步骤缺有效时间则整个 `generationMs` / 结算流式速度为 `undefined`。
- 运行中流式速度取 `liveSpeed`；运行中输出在已结算真实输出上加 `runningTokens`。
- 缓存率沿用现有提示总量校验；思维链比例只汇总字段齐全的已结算步骤。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/client/turn-details.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/turn-details.ts tests/client/turn-details.test.ts
git commit -m "feat(client): 汇总当前轮次明细数据"
```

---

### Task 2: 把 nodes 与运行中步骤接进 SessionStream，并扩展页签状态

**Files:**
- Modify: `src/client/session-store.ts`
- Modify: `src/client/chart-store.ts`
- Test: `tests/client/session-store.test.ts`
- Test: `tests/client/chart-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RunningStepRef` / `TurnDetailsInput` 只作为后续渲染输入类型。
- Produces:
  - `SessionStream.nodes?: readonly unknown[]`
  - `SessionStream.runningTurn?: number`
  - `SessionStream.runningStep?: number`
  - `ChartTab = "time" | "steps" | "details"`

- [ ] **Step 1: 写失败测试**

`session-store.test.ts` 增加：`pushSnapshot` 记录 running turn/step；`pushNodes` 保存 nodes 引用；`resetSnapshotBaseline` 清运行中字段但保留 nodes。

`chart-store.test.ts` 增加：`setChartTab("details")` 不关窗、同页签不通知、关闭重开后仍记住 details。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/client/session-store.test.ts tests/client/chart-store.test.ts`
Expected: FAIL，新字段/新页签尚不存在。

- [ ] **Step 3: 实现状态接线**

- `SessionStream` 增加 `nodes`、`runningTurn`、`runningStep`。
- `pushSnapshot` 在合法 partial 下记录 turn/step；非法 partial 清空运行中字段。
- `pushNodes` 保存 `nodes` 引用。
- `resetSnapshotBaseline` 清 running turn/step 与 runningTokens，保留 nodes。
- `ChartTab` 联合类型增加 `details`；现有 `setChartTab` 与状态持久化逻辑自然支持。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/client/session-store.test.ts tests/client/chart-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/session-store.ts src/client/chart-store.ts tests/client/session-store.test.ts tests/client/chart-store.test.ts
git commit -m "feat(client): 保存轮次明细数据并扩展页签状态"
```

---

### Task 3: 明细页格式化、面板高度与帮助文案

**Files:**
- Modify: `src/client/format.ts`
- Modify: `src/client/panel-metrics.ts`
- Modify: `src/client/help.ts`
- Test: `tests/client/format.test.ts`
- Test: `tests/client/panel-metrics.test.ts`
- Test: `tests/client/panel-help-placement.test.ts`
- Test: `tests/client/help.test.ts`

**Interfaces:**
- Produces:
  - `formatDuration(ms: number | undefined): string`，非法/缺失返回 `—`，否则 `${(ms / 1000).toFixed(2)}s`。
  - `detailsBodyHeight(): number`，固定 `190`，与现有时间页内容区同高。
  - `panelOuterHeight(tab: "time" | "steps" | "details", steps, helpOpen)` 支持 details。
  - `HELP_SECTIONS` 增加标题「本轮细则」。

- [ ] **Step 1: 写失败测试**

```ts
expect(formatDuration(4_960)).toBe("4.96s");
expect(formatDuration(0)).toBe("0.00s");
expect(formatDuration(undefined)).toBe("—");
expect(formatDuration(Number.NaN)).toBe("—");
expect(detailsBodyHeight()).toBe(190);
expect(panelOuterHeight("details", 5)).toBe(panelMinHeight());
expect(HELP_SECTIONS.map((section) => section.title)).toEqual(["实时速度", "每步平均", "本轮细则"]);
```

把 `panel-help-placement.test.ts` 里写死的 `250px` 改成从 `HELP_SIZE` 与 `helpBodyHeight()` 推导，避免以后帮助文案变化时误报。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/client/format.test.ts tests/client/panel-metrics.test.ts tests/client/panel-help-placement.test.ts tests/client/help.test.ts`
Expected: FAIL，新格式化/高度/帮助小节尚不存在。

- [ ] **Step 3: 实现格式化、高度与说明**

- `formatDuration` 加到 `format.ts`。
- `detailsBodyHeight()` 加到 `panel-metrics.ts`，`panelOuterHeight` 的 tab 联合类型与内容选择支持 details；details 仍取 `max(detailsBodyHeight(), timeBodyHeight())`，外高保持 236。
- `help.ts` 增加「本轮细则」小节，逐条写清：流式/端到端、TTFT/生成/总计、本轮输出、缓存率、输出比例、运行中为估算、缺失显示 `—`。每条不超过 40 字。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/client/format.test.ts tests/client/panel-metrics.test.ts tests/client/panel-help-placement.test.ts tests/client/help.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/format.ts src/client/panel-metrics.ts src/client/help.ts tests/client/format.test.ts tests/client/panel-metrics.test.ts tests/client/panel-help-placement.test.ts tests/client/help.test.ts
git commit -m "feat(client): 增加轮次明细格式化与版面"
```

---

### Task 4: 渲染第三个页签「本轮细则」

**Files:**
- Modify: `src/client/tps-chart.ts`

**Interfaces:**
- Consumes: Task 1 的 `turnDetailsOf` / `TurnDetails`，Task 2 的 `SessionStream.nodes` / running 字段，Task 3 的 `formatDuration` / `detailsBodyHeight`。
- Produces: 用户可见的第三页与第三个页签按钮。

- [ ] **Step 1: 写渲染层失败检查**

先运行现有测试作为基线，确认当前全绿；然后添加 `details` 分支会让 TypeScript 在 `ChartTab` 新成员下报未处理分支，作为失败信号。

Run: `pnpm test`
Expected: 基线全绿。

- [ ] **Step 2: 实现明细页渲染**

- `renderHeader` 增加 `renderTabButton("details", "本轮细则", tab)`。
- `renderPanel` 的 `aria-label` 增加 details 分支。
- details 页打开时与 time 页一样每 500ms 重画，更新运行中速度与耗时。
- 新增 `renderTurnDetails(details)`：
  - 标题：`第 N 轮 · M 步 · 总计`，running 时追加「估算」。
  - 四行：生成速度、响应耗时、本轮输出/缓存率、输出比例。
  - 速度用 `formatRateWithUnit`，耗时用 `formatDuration`，token 用 `formatTokens`，比例用 `formatRatio`。
  - 比例条用现有 `INK` / `HAIRLINE`，并同时显示文字百分比。
- 面板宽度、最小高度、定位、滚动、sticky 表头、焦点逻辑不变。

- [ ] **Step 3: 运行类型检查与测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS。

- [ ] **Step 4: 构建并跑产物冒烟**

Run: `pnpm build && pnpm test:bundle`
Expected: 构建无错误，两个槽位仍注册成功。

- [ ] **Step 5: 提交**

```bash
git add src/client/tps-chart.ts
git commit -m "feat(client): 增加本轮细则页签"
```

---

### Task 5: 文档、最终验证与推送

**Files:**
- Modify: `docs/superpowers/specs/2026-11-26-current-turn-details-design.md`
- Modify: `README.md`
- Modify: `HANDOVER.md`

- [ ] **Step 1: 更新文档**

- 设计稿状态改为「已确认」。
- README 增加第三个页签与当前轮次口径，明确不做会话总计。
- HANDOVER 文件职责增加 `turn-details.ts`，更新测试数量与构建产物大小。

- [ ] **Step 2: 完整验证**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:bundle
```

Expected: 全部通过；测试数在原有 195 条基础上增加；`git status` 仅包含本功能文件。

- [ ] **Step 3: 隐私与临时文件检查**

扫描新增 diff：PAT / token / 私钥 / 本机用户路径 / 会话正文；确认 `.tmp` 无新增一次性脚本，真实回放数据仍被 gitignore。

- [ ] **Step 4: 提交并推送**

```bash
git add README.md HANDOVER.md docs/superpowers/specs/2026-11-26-current-turn-details-design.md
git commit -m "docs: 同步本轮细则设计与验证结果"
git push origin master:main
```

- [ ] **Step 5: 同步本地安装**

确认 `desktop` profile 仍是 `link:<repo>`；重建后核对宿主服务的 `lib/client.js` 与本地构建一致，并提示用户刷新页面。
