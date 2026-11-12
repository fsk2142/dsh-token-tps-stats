window.__ModuleLoader__.load({
	id: "dsh-token-tps-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		/**
		* 低于这个值就认为「已经停了」，返回 `undefined` 让组件隐藏。
		*
		* 0.5 tok/s 已经远低于任何有意义的速度，留着只会显示一个「0」，那是噪音。
		*/
		const TPS_ZERO_THRESHOLD = .5;
		/**
		* 每 token 对应的 CJK 字符数。
		*
		* 取 1.0：实测中文里 1 个字基本就是 1 个 token（DeepSeek 系分词器）。
		*/
		const CJK_CHARS_PER_TOKEN = 1;
		/**
		* 每 token 对应的**其它**字符数。
		*
		* 4.2 不是拍脑袋：在 CJK 占 3.1% 的前提下，要让总体落在实测的 5.03 字符/token，
		* 解得其它字符约 4.2（英文约 4、代码/JSON/路径压缩率更高，平均下来 4.2 更准）。
		*/
		const OTHER_CHARS_PER_TOKEN = 4.2;
		/** 判断一个字符是否属于 CJK（含全角标点，它们同样 1 字 1 token）。 */
		function isCjk(codePoint) {
			return codePoint >= 11904 && codePoint <= 40959 || codePoint >= 44032 && codePoint <= 55215 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65280 && codePoint <= 65519;
		}
		/**
		* 把一段文本分成 CJK 与其它字符的数量。
		*
		* 用**码位**而不是 `length`：`length` 会把 emoji 与部分汉字算成两个（UTF-16 代理对），
		* 而按码位循环更接近分词器看到的东西。
		* @param text - 增量文本。
		* @returns 两类字符的计数。
		*/
		function countChars(text) {
			let cjk = 0;
			let other = 0;
			for (const char of text) if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
			else other += 1;
			return {
				cjk,
				other
			};
		}
		/**
		* 把字符计数换算成估算 token 数。
		* @param counts - CJK 与其它字符数。
		* @returns 估算 token 数（非负浮点）。
		*/
		function tokensOf(counts) {
			return counts.cjk / CJK_CHARS_PER_TOKEN + counts.other / OTHER_CHARS_PER_TOKEN;
		}
		/**
		* 指针回落后的显示值。
		*
		* 纯函数，便于单测：给定最后一次读数、经过的时间与阈值，算出应显示的数字。
		* @param last - 最后一次有效读数。
		* @param elapsedMs - 距那次读数过了多久。
		* @param decayMs - 时间常数。
		* @param threshold - 低于它视为 0。
		* @returns 应显示的 tok/s；已归零时 `undefined`。
		*/
		function decayed(last, elapsedMs, decayMs, threshold) {
			if (elapsedMs <= 0) return last;
			if (decayMs <= 0) return void 0;
			const value = last * Math.exp(-elapsedMs / decayMs);
			return value < threshold ? void 0 : value;
		}
		/**
		* 造一个速度计。
		* @param options - `windowMs` / `windows` / `decayMs` 可注入（测试用），缺省见常量。
		* @returns 速度计。
		*/
		function createTpsMeter(options = {}) {
			const windowMs = options.windowMs ?? 1e3;
			const windows = options.windows ?? 9;
			const decayMs = options.decayMs ?? 700;
			/**
			* 空闲宽限（毫秒）：超过它才认为「已经停了」，改走指针衰减。
			*
			* 不设上限就把它绑到 `windows × windowMs`：9 窗口时那会是 9 秒，
			* 而指针僵在高位 9 秒不像仪表 —— 所以保持一个固定的、与窗口数无关的短值。
			*/
			const idleGraceMs = options.idleGraceMs ?? 800;
			/** 保留这么长时间的数据：`windows × windowMs`。 */
			const spanMs = windowMs * windows;
			/** 按**毫秒桶**聚合：同一毫秒内的帧合并，避免逐帧存一个对象。 */
			const buckets = /* @__PURE__ */ new Map();
			/** 本轮是否已结束（结束后不再计入新帧，但读数仍可用）。 */
			let settled = false;
			/** 最后一次算出来的有效读数（指针回落的起点）。 */
			let lastRate;
			/** 丢掉落出保留期的桶。 */
			const prune = (at) => {
				const floor = at - spanMs;
				for (const key of buckets.keys()) if (key < floor) buckets.delete(key);
			};
			/**
			* 按窗口算分窗平均。
			*
			* ## 空窗要不要参与平均（2026-11-12 改）
			*
			* 第一版是「**空窗不参与**」：只要有窗口收到字就只对非空窗口求平均。
			* 那样在「稳定输出」时很准，但在**9 个窗口**下会出问题 ——
			* 用户明确说 3 个不够、要 9 个，而 9 窗口的意义就是「对最近 9 秒做平均」。
			* 如果仍然跳过空窗，那么**停顿 5 秒后重启输出**时，读数会拿「2 个非空窗口」求平均，
			* 得到接近瞬时速度的高值 —— 那等于把 9 窗口的平滑作用抵消掉了。
			*
			* 现在：**一旦窗口里还有数据，就把空窗按 0 计入平均**。
			* 这正是「最近 9 秒的平均速度」，停下来时数字会自然往下走，
			* 与用户要的「像速度表一样逐渐降低」是同一件事的两面。
			*
			* 唯一的例外是**完全空闲**（用 {@link TPS_IDLE_GRACE_MS} 判断）：
			* 那时不再用分窗平均（它会僵在高位好几种钟），改由指针衰减。
			* @param at - 现在（毫秒）。
			* @returns 估算 tok/s；窗口里完全没有数据时 `undefined`。
			*/
			const windowedRate = (at) => {
				/** 最近一次收到帧的时刻（判断是否还在流）。 */
				let latest;
				for (const key of buckets.keys()) if (latest === void 0 || key > latest) latest = key;
				if (settled || latest === void 0 || at - latest > idleGraceMs) return void 0;
				let sum = 0;
				let used = 0;
				let anyData = false;
				for (let index = 0; index < windows; index += 1) {
					const from = at - (index + 1) * windowMs;
					const to = at - index * windowMs;
					let cjk = 0;
					let other = 0;
					for (const [key, slice] of buckets) if (key > from && key <= to) {
						cjk += slice.cjk;
						other += slice.other;
					}
					const windowed = tokensOf({
						cjk,
						other
					});
					if (windowed > 0) anyData = true;
					if (!anyData) continue;
					sum += windowed / windowMs * 1e3;
					used += 1;
				}
				if (!anyData || used === 0) return void 0;
				return sum / used;
			};
			return {
				push: (text, at) => {
					if (settled) return;
					if (text === "") return;
					const counts = countChars(text);
					if (counts.cjk === 0 && counts.other === 0) return;
					const bucket = buckets.get(at);
					if (bucket === void 0) buckets.set(at, counts);
					else {
						bucket.cjk += counts.cjk;
						bucket.other += counts.other;
					}
					prune(at);
				},
				reading: (at) => {
					prune(at);
					const rate = windowedRate(at);
					if (rate !== void 0) {
						lastRate = {
							value: rate,
							at
						};
						return rate;
					}
					if (lastRate === void 0) return void 0;
					return decayed(lastRate.value, at - lastRate.at, decayMs, TPS_ZERO_THRESHOLD);
				},
				settle: () => {
					settled = true;
				}
			};
		}
		// src/client/tps-pill.ts
		/**
		* **实时 tok/s 的显示**（2026-11-12，第 2 步）。
		*
		* ## 放在哪
		*
		* 注册进 `conversation.composer.dock`，`order: -1` —— 官方那两个胶囊
		* （轮次/步数 = order 0、用量 = order 1）排在右边，所以它出现在输入框底部
		* 那一行「92 轮 4018 步 · …」的**左边**。
		*
		* ## 样式为什么写成一串 CSS 变量的 calc（2026-11-12 用户实测反馈）
		*
		* 用户第一版看到的效果：**「字体和官方的不一致」**。根因是我只写了
		* `display/color/tabular-nums` 三个内联属性，**没有覆盖字号与行高** —— 于是它继承
		* 容器默认值，和旁边官方胶囊差一档。
		*
		* 官方胶囊的真实规则（`@deepseek-ai/dsh-client-ui-chat` 的 `StatsPills` 模块）：
		*
		* ```
		* .anchor { min-width:0; font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
		*           line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px)); display:inline-flex }
		* .pill   { border-radius:var(--dsw-radius-sm); color:var(--dsw-alias-label-tertiary);
		*           font:inherit; font-variant-numeric:tabular-nums; white-space:nowrap;
		*           background:0 0; border:none; align-items:center; gap:6px; padding:1px 8px; display:inline-flex }
		* .pill svg { flex:none; width:14px; height:14px }
		* ```
		*
		* 这里逐条照抄成内联样式（不引它的 CSS Module —— 那是宿主私有类名，换版本会变）。
		*
		* ## 为什么空闲时显示 0 而不是消失（用户明确要求）
		*
		* 用户原话：「完全没有会话动作的时候直接显示 0 tok/s 吧，不要消失」。
		*
		* 上一版归零就 `return null`，于是模型一停组件就没了 —— 用户看到的正是「好像又没了」。
		* 现在**始终渲染**：有速度显示速度，没有就显示 `0`。
		*
		* ## 为什么定时器要能停也能重启
		*
		* 「指针回落」需要即使没有新事件也重算（每 100ms 一次）。但值已经是 0 之后就没必要
		* 再算了 —— 所以归零时**停表**，等下一帧到达（`notify()`）再重启。
		* 这样空闲时不会留一个每秒唤醒 10 次的主线程定时器（上一版就是那样，还伴随
		* 控制台的 `Forced reflow` 警告）。
		*
		* @module dsh-token-tps-stats/src/client/tps-pill
		*/
		/** 重渲染间隔（毫秒）：100ms 足够顺滑，又不至于像 60fps 那样白烧。 */
		const TICK_MS = 100;
		/**
		* 模块级速度计（**全会话一个**）。
		*
		* 为什么放模块级而不是组件里：事件定义在插件生命周期内注册一次，必须把帧推进
		* **同一个**累加器；而组件可能因槽位重注册反复挂载，状态不能跟着丢。
		*/
		let meter;
		/**
		* 确保速度计存在（幂等）。
		* @returns 当前实例。
		*/
		function ensureMeter() {
			if (meter === void 0) meter = createTpsMeter();
			return meter;
		}
		/** 订阅者（组件挂载时登记；帧到达时被通知）。 */
		const listeners = /* @__PURE__ */ new Set();
		/** 通知所有订阅者「数据变了」。 */
		function notify() {
			for (const listener of listeners) listener();
		}
		/**
		* 推进一帧（由事件定义调用）。
		* @param chunk - 流式 chunk（含 `type` 与 `text`）。
		* @param meta - 该帧所属的 turn/step（当前不参与计算，见下）。
		* @param at - 帧到达时刻（毫秒）。
		*/
		function pushLiveChunk(chunk, meta, at) {
			if (typeof chunk !== "object" || chunk === null) return;
			const type = chunk.type;
			if (type !== "text-delta" && type !== "reasoning-delta") return;
			const text = chunk.text;
			if (typeof text !== "string" || text === "") return;
			ensureMeter().push(text, at);
			notify();
		}
		/**
		* 读当前速度。**空闲时返回 0，而不是 `undefined`**（用户要求始终显示）。
		* @param at - 现在（毫秒）。
		* @returns 估算 tok/s（非负）。
		*/
		function readingAt(at) {
			const reading = meter?.reading(at);
			return typeof reading === "number" && Number.isFinite(reading) && reading > 0 ? reading : 0;
		}
		/**
		* 把数值格式化成显示文本。
		*
		* ≥10 取整、<10 保留一位（与官方 `formatTokensPerSecond` 同一口径）。
		* @param value - tok/s。
		* @returns 显示文本。
		*/
		function formatRate(value) {
			const clamped = Math.max(0, value);
			if (clamped === 0) return "0";
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/** 与官方 `.pill` 逐条对齐的内联样式（理由见文件头）。 */
		const PILL_STYLE = {
			boxSizing: "border-box",
			borderRadius: "var(--dsw-radius-sm)",
			maxWidth: "100%",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontVariantNumeric: "tabular-nums",
			lineHeight: "inherit",
			whiteSpace: "nowrap",
			background: "0 0",
			border: "none",
			alignItems: "center",
			gap: "6px",
			padding: "1px 8px",
			display: "inline-flex"
		};
		/** 与官方 `.anchor` 对齐的外壳样式（字号与行高在这里）。 */
		const ANCHOR_STYLE = {
			minWidth: "0",
			fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
			lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
			display: "inline-flex"
		};
		/**
		* 仪表盘图标。
		*
		* ## 为什么用官方的路径数据（2026-11-12 用户反馈「有点小、对比官方不太好看」）
		*
		* 第一版我自己画了「一条上弧 + 一枚指针」，但：
		* - 缺了圆心那个**实心点**，少了辨识度；
		* - `strokeWidth: 1.4` 比官方粗，小尺寸下糊成一团。
		*
		* 现在逐字采用宿主图标集里 `gauge-outline` 的几何（从 `dsh-web-frontend` 的
		* 图标表读出）：`viewBox 0 0 16 16`、`stroke-width: 1`（官方 regular 档）、
		* 三段 path（外弧 + 指针 + 圆心实心点）。
		*
		* 尺寸仍由外层样式决定（官方 `.pill svg { width:14px; height:14px }`）。
		* @returns SVG 元素。
		*/
		function GaugeIcon() {
			return (0, react.createElement)("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false",
				style: {
					flex: "none",
					width: "14px",
					height: "14px"
				}
			}, (0, react.createElement)("path", {
				d: "M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096",
				stroke: "currentColor",
				strokeWidth: 1
			}), (0, react.createElement)("path", {
				d: "M8 8.49994L11.6114 4.88855",
				stroke: "currentColor",
				strokeWidth: 1
			}), (0, react.createElement)("path", {
				d: "M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z",
				fill: "currentColor"
			}));
		}
		/**
		* 实时速度胶囊。**始终渲染**（空闲时显示 `0 tok/s`）。
		* @returns 元素。
		*/
		function TpsPill() {
			const [value, setValue] = (0, react.useState)(() => readingAt(Date.now()));
			(0, react.useEffect)(() => {
				/** 当前运行中的定时器（归零后停、新帧到达再启）。 */
				let timer;
				const stop = () => {
					if (timer === void 0) return;
					clearInterval(timer);
					timer = void 0;
				};
				const start = () => {
					if (timer !== void 0) return;
					timer = setInterval(() => {
						const next = readingAt(Date.now());
						setValue(next);
						if (next === 0) stop();
					}, TICK_MS);
				};
				const listener = () => {
					const next = readingAt(Date.now());
					setValue(next);
					if (next > 0) start();
				};
				listeners.add(listener);
				if (readingAt(Date.now()) > 0) start();
				return () => {
					listeners.delete(listener);
					stop();
				};
			}, []);
			return (0, react.createElement)("span", {
				"data-composer-stat": "llm-account-tps",
				style: ANCHOR_STYLE
			}, (0, react.createElement)("span", {
				style: PILL_STYLE,
				"aria-label": `实时输出速度（TPS）：${formatRate(value)} tok/s`
			}, GaugeIcon(), (0, react.createElement)("span", { style: {
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis"
			} }, `实时输出速度（TPS）：${formatRate(value)} tok/s`)));
		}
		// src/client/install.ts
		/**
		* **实时 tok/s 的探针**（2026-11-12，第 1 步）。
		*
		* ## 这个文件是干什么的
		*
		* 验证一件事：**我们的客户端插件能不能吃到 `assistant/live-chunk` 事件**。
		*
		* - 能 → 第 2 步才值得写「1 秒滑动窗口 + token 换算 + 输入框右侧显示」；
		* - 不能 → 完整版写出来也没有数据源，等于白写。
		*
		* 现在它**只打控制台日志，不渲染任何 UI**，也**不写任何设置**。
		*
		* ## 为什么单独一个文件、而不塞进 `seams.ts`
		*
		* `seams.ts` 是 3900 行、几十处注册的共享文件。往那里加东西，一旦写错就会伤到
		* 设置页/侧边栏 —— 用户报过好几次「升级后功能坏掉 / DSH 起不来」。新开一个文件、
		* 只在 `index.ts` 末尾加一道 guarded 调用，失败半径就只有这一个功能。
		*
		* ## 为什么**不**把 `uiConversation` 放进 `inject` 数组
		*
		* `inject` 数组里的服务缺失会让 cordis 判定**整个客户端包激活失败** —— 那时设置页
		* 和侧边栏会一起消失。所以这里走 `ctx.inject([...], cb)` 的**嵌套注入**：服务不在
		* 就只是这个回调不跑，其余一切照常。插件里 `remote.credentials` 已有同样的用法。
		*
		* ## 为什么定义里**不写** `target` / `buildViewNode`
		*
		* 宿主的 `assertDefinitionTarget` 把这个条件写死了：
		*
		* ```
		* if (definition.target === undefined !== (definition.buildViewNode === undefined)) throw
		* ```
		*
		* 也就是说这两者**必须同时存在或同时缺席**。探针不产出任何可见节点，所以两个都
		* 不写 —— 这样既通过校验，又不会往会话视图里塞空节点。
		*
		* @module dsh-token-tps-stats/src/client/tps-probe
		*/
		/**
		* 显示胶囊的注销句柄（**模块级**：它由嵌套注入的回调赋值，回调清理时需要看到它）。
		*
		* 单独存一份而不是塞进闭包，是因为同一个 `installTpsProbe` 可能被多次触发
		* （槽位声明变化时宿主会重跑回调），每次都要先撤掉上一份。
		*/
		let pillDispose;
		/**
		* 撤销显示胶囊。
		*
		* 只在**注册成功过**时才需要调；拿不到句柄时是空操作。
		*/
		function disposePill() {
			const off = pillDispose;
			pillDispose = void 0;
			if (typeof off !== "function") return;
			try {
				off();
			} catch (error) {
				console.error("[dsh-token-tps-stats] tps pill: dispose failed:", error);
			}
		}
		/**
		* 释放本次注册产生的一切（事件定义 + 显示胶囊）。
		*
		* 各个早退分支都返回它 —— 否则「事件拿到了但显示没挂上」那种半成品状态会留下
		* 一个没有人喂数据的胶囊。
		* @returns 注销函数（可重复调用）。
		*/
		function releaseAll() {
			disposePill();
		}
		/** 探针用的 Definition kind（必须全局唯一；与插件 id 同前缀，避免撞宿主内置的名字）。 */
		const METER_KIND = "dsh-token-tps-stats-meter";
		/**
/**
		* 帧到达时刻：**一律用本地墙钟**（2026-11-12 修「速度恒为 0」）。
		*
		* ## 之前错在哪
		*
		* 第一版用 `event.time`（宿主事件的时刻）作为 `meter.push` 的时间轴，而读数时用
		* `Date.now()`。**两个时钟互相比较**，只要基准不同，`at - latest` 就会算成一个
		* 很大的值 —— 直接命中「空闲超过 800ms」那条分支，读数恒为 `undefined`（显示 0）。
		*
		* 症状正是用户报的两条：**数字一直是 0**，以及「运行一段时间后就不行了」
		* （组件的「归零就停表」逻辑让它再也不会重启）。
		*
		* ## 为什么本地墙钟才是对的
		*
		* 这个仪表测的是「**字到达我这台机器的真实速率**」—— 本来就该用本地时钟。
		* 当初选 `event.time` 的理由（历史重放能落回正确位置）属于回放/审计场景，
		* 不属于一个实时速度表。
		*
		* @param event - 流式事件（仅用于时钟漂移诊断，不参与计时）。
		* @returns 本地墙钟毫秒。
		*/
		function arrivalTime(event) {
			const now = Date.now();
			if (typeof event.time === "number" && Number.isFinite(event.time)) {
				const drift = now - event.time;
				if (Math.abs(drift) > DIAGNOSTIC_DRIFT_MS && !driftLogged) {
					driftLogged = true;
					console.debug(`[dsh-token-tps-stats] tps: event.time differs from local clock by ${drift}ms; using the local clock`);
				}
			}
			return now;
		}
		/** 超过这个差值才打一次时钟漂移诊断（避免每帧刷屏）。 */
		const DIAGNOSTIC_DRIFT_MS = 5e3;
		/** 时钟漂移诊断是否已经打过（只打一次，够定位就行）。 */
		let driftLogged = false;
		/** 两次 `console.debug` 之间至少隔多久（毫秒）：流式帧很密，逐帧打会淹没控制台。 */
		const LOG_INTERVAL_MS = 250;
		/**
		* 注册探针。
		*
		* 所有失败都在这里兜住：探针注册不上，只是看不到日志，**不允许**影响插件的其余部分。
		* @param ctx - 客户端上下文。
		*/
		function installTpsPill(ctx) {
			const inject = ctx.inject;
			if (typeof inject !== "function") {
				console.debug("[dsh-token-tps-stats] tps: ctx.inject is unavailable, skipped");
				return;
			}
			try {
				inject(["uiConversation", "slots"], (scoped) => {
					try {
						const slots = scoped.slots;
						if (typeof slots === "object" && slots !== null && typeof slots.register === "function") try {
							const off = slots.register({
								name: "conversation.composer.dock",
								id: "llm-account-tps",
								order: -1
							}, TpsPill);
							pillDispose = typeof off === "function" ? off : void 0;
							console.debug("[dsh-token-tps-stats] tps pill: registered into conversation.composer.dock (order -1)");
						} catch (error) {
							console.error("[dsh-token-tps-stats] tps pill: slot registration failed:", error);
						}
						else console.debug("[dsh-token-tps-stats] tps pill: slots.register is unavailable, skipped");
						const service = scoped.uiConversation;
						if (typeof service !== "object" || service === null) {
							console.debug("[dsh-token-tps-stats] tps: uiConversation is not an object, skipped");
							return releaseAll;
						}
						const events = service.events;
						if (typeof events !== "object" || events === null) {
							console.debug("[dsh-token-tps-stats] tps: uiConversation.events is unavailable, skipped");
							return releaseAll;
						}
						const target = events;
						const methods = Object.keys(target).filter((key) => typeof target[key] === "function");
						if (typeof target.register !== "function") {
							console.debug(`[dsh-token-tps-stats] tps: events.register is unavailable; available methods=[${methods.join(", ")}]`);
							return releaseAll;
						}
						const off = target.register.call(target, definition());
						console.debug(`[dsh-token-tps-stats] tps: registered (waiting for assistant/live-chunk); events methods=[${methods.join(", ")}]`);
						return () => {
							try {
								if (typeof off === "function") off();
							} catch (error) {
								console.error("[dsh-token-tps-stats] tps: dispose failed:", error);
							}
							disposePill();
						};
					} catch (error) {
						console.error("[dsh-token-tps-stats] tps: registration failed:", error);
						return releaseAll;
					}
				});
			} catch (error) {
				console.error("[dsh-token-tps-stats] tps: nested inject failed:", error);
			}
		}
		/**
		* 把一次 chunk 折算成字符数（探针只关心「有多少内容进来了」）。
		* @param chunk - 事件里的 `chunk`。
		* @returns 字符数；认不出的形状为 0。
		*/
		function charsOf(chunk) {
			if (typeof chunk !== "object" || chunk === null) return 0;
			const text = chunk.text;
			if (typeof text === "string") return text.length;
			const args = chunk.argumentsDelta;
			if (typeof args === "string") return args.length;
			return 0;
		}
		/**
		* 造事件定义。
		*
		* 三条分工（照宿主 `uiConversation` 的 Definition 约定）：
		* - `match`：只认 `assistant/live-chunk`，首帧给 `start`、其余给 `update`；
		* - `start`：第一帧到达时复位计数并打日志；
		* - `update`：后续帧累加并节流打日志。
		*
		* @returns 事件定义。
		*/
		function definition() {
			/** 上一次打日志的时刻。 */
			let lastLogAt = 0;
			/** 本次流累计收到的字符数。 */
			let chars = 0;
			/** 本次流累计的帧数。 */
			/** 本次流累计的帧数。 */
			let frames = 0;
			/**
			* 最近一次见过的 turn/step 拼成的流 id。
			*
			* ## 为什么不能用 `chars === 0` 判 start（2026-11-12 修「运行一段时间后就不行了」）
			*
			* 第一版写的是 `role: chars === 0 ? "start" : "update"` —— 判据基于**可变计数器**。
			* 一旦某一轮真正收到过文本，`chars` 就不再是 0；于是**下一轮的第一个帧**也会被
			* 报成 `"update"`，而宿主对 `"update"` 要求已有对应 Context —— 没有就直接丢弃。
			*
			* 结果：之后每一轮的第一帧都被丢，计数再也起不来 —— 用户看到的正是
			* 「运行一段时间后就不行了，速度始终 0」。
			*
			* 现在看 **id 有没有变**：id 由 turn/step 拼成，换了流就是 `start`。
			*/
			let lastStreamId;
			/** 打一条节流后的日志。 */
			const log = (event, label) => {
				const now = Date.now();
				if (now - lastLogAt < LOG_INTERVAL_MS) return;
				lastLogAt = now;
				console.debug(`[dsh-token-tps-stats] live-chunk ${label}: frames=${frames} chars=${chars} type=${String(event.data?.chunk?.type)} turn=${String(event.data?.turn)} step=${String(event.data?.step)}`);
			};
			return {
				kind: METER_KIND,
				match: (event) => {
					if (event.type !== "assistant/live-chunk") return null;
					const id = `${METER_KIND}:${String(event.data?.turn)}:${String(event.data?.step)}`;
					const isFirstForStream = id !== lastStreamId;
					lastStreamId = id;
					return {
						id,
						role: isFirstForStream ? "start" : "update"
					};
				},
				start: (_context, match) => {
					chars = 0;
					frames = 0;
					lastLogAt = 0;
					const add = charsOf(match.event.data?.chunk);
					if (add > 0) {
						chars += add;
						frames += 1;
					}
					pushLiveChunk(match.event.data?.chunk, {
						turn: match.event.data?.turn,
						step: match.event.data?.step
					}, arrivalTime(match.event));
					log(match.event, "start");
					return {
						chars,
						frames
					};
				},
				update: (_context, match) => {
					const add = charsOf(match.event.data?.chunk);
					if (add > 0) {
						chars += add;
						frames += 1;
					}
					pushLiveChunk(match.event.data?.chunk, {
						turn: match.event.data?.turn,
						step: match.event.data?.step
					}, arrivalTime(match.event));
					log(match.event, "update");
					return {
						chars,
						frames
					};
				}
			};
		}
		// src/client/index.ts
		/**
		* 客户端入口：把实时 tok/s 胶囊挂进输入框底部那一行。
		*
		* ## 这个插件只做一件事
		*
		* 订阅 `assistant/live-chunk`，按 1 秒 × 9 窗口算出「当前会话的输出速度」，
		* 显示在 `conversation.composer.dock` 里、排在那两个官方胶囊（轮次/步数、用量）的左边。
		*
		* ## 安全边界（每一条都是实测踩出来的）
		*
		* 1. **不把 `uiConversation` / `slots` 放进顶层 `inject` 数组。**
		*    顶层缺失会让 cordis 判定整个客户端包激活失败 —— 界面直接白掉。
		*    这里用 `ctx.inject([...], cb)` 的**嵌套注入**：服务不在就只是这个回调不跑。
		* 2. **全部 try/catch**：注册失败只打一行 `console.error`，不外抛。
		* 3. **空的 `apply` 不会让插件看起来「没做事」**：注册成功会打一行 debug 日志
		*    （`tps pill: registered …`），排查时一眼能确认。
		*
		* @module dsh-token-tps-stats/src/client/index
		*/
		/**
		* 本插件**不列**任何 cordis 服务。
		*
		* 需要的一切（`slots`、`uiConversation`）都走嵌套注入，因此这里刻意为空 ——
		* 一旦有人把服务名加进这个数组，缺失时就会从「这个功能不显示」升级成
		* 「整个客户端包激活失败」，那是完全不同量级的故障。
		*/
		const inject = [];
		/**
		* 客户端插件入口。
		* @param ctx - 宿主注入的客户端上下文。
		*/
		function apply(ctx) {
			try {
				installTpsPill(ctx);
			} catch (error) {
				console.error("[dsh-token-tps-stats] client activation failed:", error);
			}
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
