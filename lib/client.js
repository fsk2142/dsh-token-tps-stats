window.__ModuleLoader__.load({
	id: "dsh-token-tps-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/client/chart-geometry.ts
		/**
		* 把最大值「向上取整」到一眼能读的数（1 / 2 / 2.5 / 5 / 10 × 10^n）。
		*
		* 为什么不能直接用峰值当最大值：峰值 47 时纵轴顶端会标成 47，刻度只能标 0/12/23/35
		* 这种读不顺的数。取整到 50 之后，刻度就是 0/25/50。
		* @param value - 峰值（tok/s）。
		* @returns 不小于 `value` 的「整齐」数；`value <= 0` 时给一个最小量程。
		*/
		function niceMax(value) {
			if (!Number.isFinite(value) || value <= 0) return 10;
			const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
			const normalized = value / magnitude;
			for (const step of [
				1,
				2,
				2.5,
				5,
				10
			]) if (normalized <= step) return step * magnitude;
			return 10 * magnitude;
		}
		/**
		* 造纵轴刻度（从 0 到 `max`，含两端）。
		* @param max - 纵轴最大值（建议先过 {@link niceMax}）。
		* @param count - 段数（刻度数 = count + 1）。
		* @returns 从 0 到 `max` 的刻度值。
		*/
		function axisTicks(max, count = 2) {
			const safeMax = Number.isFinite(max) && max > 0 ? max : 10;
			const safeCount = Math.max(1, Math.floor(count));
			const ticks = [];
			for (let index = 0; index <= safeCount; index += 1) ticks.push(safeMax / safeCount * index);
			return ticks;
		}
		/**
		* 把序列映射成绘图区内的坐标。
		*
		* - 横轴按**点序**等分（每秒一个点，间距天然相等）；
		* - 只有 1 个点时放在正中（否则会画在 x=0 的左边缘上，像被截断）；
		* - 纵轴按 `max` 归一，越界值被夹到 0..max（浮点误差不该画出格）。
		* @param values - 序列值（最旧 → 最新）。
		* @param options - 绘图区尺寸与纵轴最大值。
		* @returns 折线 / 填充 / 点的几何。
		*/
		function buildGeometry(values, options) {
			const width = Math.max(1, options.width);
			const height = Math.max(1, options.height);
			const max = Number.isFinite(options.max) && options.max > 0 ? options.max : 10;
			const count = values.length;
			const points = [];
			for (let index = 0; index < count; index += 1) {
				const x = count === 1 ? width / 2 : index / (count - 1) * width;
				const raw = Number.isFinite(values[index]) ? values[index] : 0;
				const y = height - Math.min(max, Math.max(0, raw)) / max * height;
				points.push({
					x: round(x),
					y: round(y)
				});
			}
			if (points.length === 0) return {
				line: "",
				area: "",
				points: [],
				max
			};
			const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
			const first = points[0];
			return {
				line,
				area: `${line} L${points[points.length - 1].x} ${round(height)} L${first.x} ${round(height)} Z`,
				points,
				max
			};
		}
		/**
		* 保留两位小数。
		*
		* SVG path 里带一长串浮点尾数会让产物变丑、也让断言难以书写；
		* 两位小数对像素坐标已经远超够用精度。
		* @param value - 原始值。
		* @returns 两位小数的值。
		*/
		function round(value) {
			return Math.round(value * 100) / 100;
		}
		/**
		* 单次 `reading()` 最多消化的时间差（毫秒）。
		*
		* 空闲时组件会停表（值归零后没有定时器），帧突然回来时距上次读数可能过了好几秒。
		* 不设上限，低通一步就吃掉整个时间差、直接跳到目标值 —— 缓冲等于没做。
		*/
		const TPS_FOLLOW_MAX_STEP_MS = 1e3;
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
		* 一阶低通的**一步**（纯函数）。
		*
		* `previous === undefined` 表示「还没有显示值」：从 **0** 起步，而不是直接取目标值。
		* 这样插件在流式进行中挂载时，指针也是从 0 慢慢爬上去 —— 与用户要的观感一致。
		* @param previous - 上一步的显示值与它的时刻。
		* @param target - 目标值（最近 9 秒的平均）。
		* @param at - 现在（毫秒）。
		* @param followMs - 时间常数（毫秒）。
		* @param maxStepMs - 单步最多消化的时间差（毫秒）。
		* @returns 新的显示值与时刻。
		*/
		function followToward(previous, target, at, followMs, maxStepMs) {
			if (previous === void 0) return {
				value: 0,
				at
			};
			const elapsed = at - previous.at;
			if (elapsed <= 0) return {
				value: previous.value,
				at: previous.at
			};
			const factor = followMs > 0 ? 1 - Math.exp(-Math.min(elapsed, maxStepMs) / followMs) : 1;
			return {
				value: previous.value + (target - previous.value) * factor,
				at
			};
		}
		/**
		* 造一个速度计。
		* @param options - `windowMs` / `windows` / `decayMs` / `idleGraceMs` / `followMs` 可注入（测试用）。
		* @returns 速度计。
		*/
		function createTpsMeter(options = {}) {
			const windowMs = options.windowMs ?? 1e3;
			const windows = options.windows ?? 9;
			const decayMs = options.decayMs ?? 3e3;
			const followMs = options.followMs ?? 3e3;
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
			/** 最后一次算出来的**目标**读数（指针回落的起点兜底）。 */
			let lastRate;
			/**
			* 3 秒低通之后的**显示值**（用户真正看到的数字）。
			*
			* 与 `lastRate` 分开：`lastRate` 是「最近 9 秒的平均」，是低通的输入；
			* 显示值是低通的输出。停机衰减从显示值开始，否则指针会先跳回目标值再衰减。
			*/
			let displayed;
			/** 丢掉落出保留期的桶。 */
			const prune = (at) => {
				const floor = at - spanMs;
				for (const key of buckets.keys()) if (key < floor) buckets.delete(key);
			};
			/**
			* 最近 `windows` 个窗口的平均速度（**分母固定为 `windows`**）。
			*
			* ## 空窗要不要参与平均（2026-11-12 改过两次）
			*
			* 第一版「空窗不参与」：只对非空窗口求平均。9 窗口下这会把「停顿后重启」读成
			* 接近瞬时速度的高值 —— 等于把平滑抵消掉。
			*
			* 第二版「一旦有过数据就把空窗按 0 计入，但分母只数**已经有数据之后**的窗口」：
			* 稳定输出时正确，但**停顿后突然来一大段**时，分母只剩最近那 1 个窗口 ——
			* 1200 字符（≈286 token）被读成 286 tok/s，就是用户报的「冲到 300 多」。
			*
			* 现在第三版：**只要最近 9 秒里有任何数据，分母固定 `windows`**，空窗按 0。
			* 那一段 1200 字符读成 286/9 ≈ 32 tok/s，这才是「最近 9 秒的平均」。
			* @param at - 现在（毫秒）。
			* @returns 估算 tok/s；最近一帧已超出宽限（判定为停）或完全没有数据时 `undefined`。
			*/
			const windowedRate = (at) => {
				/** 最近一次收到帧的时刻（判断是否还在流）。 */
				let latest;
				for (const key of buckets.keys()) if (latest === void 0 || key > latest) latest = key;
				if (settled || latest === void 0 || at - latest > idleGraceMs) return void 0;
				let sum = 0;
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
					sum += windowed / windowMs * 1e3;
				}
				if (!anyData) return void 0;
				return sum / windows;
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
					const target = windowedRate(at);
					if (target !== void 0) {
						lastRate = {
							value: target,
							at
						};
						displayed = followToward(displayed, target, at, followMs, TPS_FOLLOW_MAX_STEP_MS);
						return displayed.value;
					}
					if (displayed === void 0) {
						if (lastRate === void 0) return void 0;
						displayed = {
							value: lastRate.value,
							at: lastRate.at
						};
					}
					const remaining = decayed(displayed.value, at - displayed.at, decayMs, TPS_ZERO_THRESHOLD);
					displayed = {
						value: remaining ?? 0,
						at
					};
					return remaining;
				},
				settle: () => {
					settled = true;
				}
			};
		}
		// src/client/tps-history.ts
		/**
		* **折线图用的历史记录**（2026-11-12，第 3 步）。
		*
		* ## 为什么单独一个模块
		*
		* `tps-meter.ts` 只保留最近 9 秒（那是胶囊读数需要的跨度）；折线图要的是
		* 「一段时间内的变化」，需要更长的历史。两件事放进同一个累加器会让那个已经
		* 稳定的计算核心变复杂，所以这里是**另一个**累加器：纯函数 + 一个模块级单例，
		* 不碰 React、不碰宿主，可以完整单测。
		*
		* ## 为什么是「每秒一个桶」而不是定时采样
		*
		* 定时采样（每 500ms 读一次胶囊）需要在**空闲时也继续跑定时器**，而且采到的是
		* 已经平滑过的读数 —— 折线图等于把 9 秒平滑又叠加一次，看不出真实起伏。
		*
		* 这里改成**按秒聚合原始字符**：只有帧到达时才写桶，**空闲时零开销**（没有定时器）。
		* 画图时再对每个秒点做一次「最近 9 秒」的滑动平均 —— 与胶囊读数**同一口径**
		*（`TPS_WINDOWS × TPS_WINDOW_MS`），所以折线图和胶囊不会各说各话。
		*
		* ## 为什么最后一点落在「整秒边界」
		*
		* 当前这一秒只过了 300ms 时，桶里只有 300ms 的字；直接按整秒画，最后一点会
		* 塌下去一个坑（每次都塌），看起来像抖动。所以时间轴只画**已走完的秒**：
		* 最后一点是「上一个整秒边界」，最多晚 1 秒，但形状是诚实的。
		*
		* ## 复用哪个换算
		*
		* 直接复用 `tps-meter.ts` 的 `countChars` 与 `tokensOf` —— 折线图和胶囊必须用
		* 同一套系数，任何一处改动都自动同步，不给自己留「两个模块各算一套」的机会。
		*
		* @module dsh-token-tps-stats/src/client/tps-history
		*/
		/** 桶宽（毫秒）：1 秒一个桶，与胶囊的窗口同宽。 */
		const BIN_MS = 1e3;
		/** 平滑窗口数：与胶囊一致（9 × 1 秒）。 */
		const SMOOTH_WINDOWS = 9;
		/** 折线图可选的时长（秒）：上限受 {@link TPS_HISTORY_SECONDS} 限制。 */
		const TPS_CHART_RANGES = [60, 180];
		/**
		* 造一个历史记录器。
		* @param options - `seconds` / `binMs` / `smoothWindows` 可注入（测试用）。
		* @returns 历史记录器。
		*/
		function createTpsHistory(options = {}) {
			const keepSeconds = options.seconds ?? 180;
			const binMs = options.binMs ?? BIN_MS;
			const smoothWindows = options.smoothWindows ?? SMOOTH_WINDOWS;
			/** key = 桶序号 `floor(at / binMs)`；只有收到过字的桶才存在（空桶即 0）。 */
			const bins = /* @__PURE__ */ new Map();
			/** 当前时刻所属的桶序号。 */
			const binIndexOf = (at) => Math.floor(at / binMs);
			/** 丢掉落出保留期的桶（保留期 = 历史长度 + 平滑窗口）。 */
			const prune = (binIndex) => {
				const floor = binIndex - keepSeconds - smoothWindows;
				for (const key of bins.keys()) if (key < floor) bins.delete(key);
			};
			/**
			* 某一整秒边界上的滑动平均速度（最近 `smoothWindows × binMs` 内的平均）。
			*
			* **分母固定**为窗口长度：空桶按 0 计入。这与 `tps-meter.ts` 的第三版口径一致 ——
			* 折线图和胶囊用同一套「最近 N 秒的平均」，否则两处会各说各话
			*（旧实现只在有过数据的桶进分母，停顿后突然一段会把点顶到天上去）。
			* @param boundary - 桶序号。
			* @returns tok/s。
			*/
			const rateAt = (boundary) => {
				let tokens = 0;
				for (let step = 0; step < smoothWindows; step += 1) {
					const bin = bins.get(boundary - step);
					if (bin !== void 0) tokens += tokensOf(bin);
				}
				const windowMs = smoothWindows * binMs;
				return windowMs > 0 ? tokens / windowMs * 1e3 : 0;
			};
			/** 造「最旧 → 最新」的点列（结尾落在最后一个已走完的整秒）。 */
			const pointsAt = (at, seconds) => {
				const end = binIndexOf(at);
				prune(end);
				const requested = Math.max(1, Math.floor(seconds));
				const points = [];
				for (let ago = requested - 1; ago >= 0; ago -= 1) points.push({
					secondsAgo: ago,
					value: rateAt(end - ago)
				});
				return points;
			};
			return {
				push: (text, at) => {
					if (typeof text !== "string" || text === "") return;
					const counts = countChars(text);
					if (counts.cjk === 0 && counts.other === 0) return;
					const index = binIndexOf(at);
					const bin = bins.get(index);
					if (bin === void 0) bins.set(index, {
						cjk: counts.cjk,
						other: counts.other
					});
					else {
						bin.cjk += counts.cjk;
						bin.other += counts.other;
					}
					prune(index);
				},
				series: (at, seconds) => pointsAt(at, seconds),
				summary: (at, seconds) => {
					const points = pointsAt(at, seconds);
					let sum = 0;
					let peak = 0;
					for (const point of points) {
						sum += point.value;
						if (point.value > peak) peak = point.value;
					}
					const latest = points.length > 0 ? points[points.length - 1].value : 0;
					return {
						average: points.length > 0 ? sum / points.length : 0,
						peak,
						latest
					};
				}
			};
		}
		/**
		* 模块级单例（**全会话一个**；与速度计同一个生命周期理由：事件定义只注册一次，
		* 而组件可能因槽位重注册反复挂载，历史不能跟着丢）。
		*/
		let history;
		/** 确保历史记录器存在（幂等）。 */
		function ensureHistory() {
			if (history === void 0) history = createTpsHistory();
			return history;
		}
		/**
		* 推进一帧历史（由显示层与速度计吃同一批文本）。
		* @param text - 增量文本。
		* @param at - 帧到达时刻（本地墙钟毫秒）。
		*/
		function pushHistory(text, at) {
			ensureHistory().push(text, at);
		}
		/**
		* 读折线序列。
		* @param at - 现在（毫秒）。
		* @param seconds - 时长（秒），缺省取 {@link TPS_CHART_DEFAULT_SECONDS}。
		* @returns 最旧 → 最新的点。
		*/
		function historySeries(at, seconds = 60) {
			return ensureHistory().series(at, seconds);
		}
		/**
		* 读序列统计值。
		* @param at - 现在（毫秒）。
		* @param seconds - 时长（秒），缺省取 {@link TPS_CHART_DEFAULT_SECONDS}。
		* @returns 平均值 / 峰值 / 最新一点。
		*/
		function historySummary(at, seconds = 60) {
			return ensureHistory().summary(at, seconds);
		}
		/** 当前状态（模块级单例）。 */
		let state = {
			open: false,
			anchor: void 0,
			seconds: 60
		};
		/**
		* 胶囊的 DOM 元素（由胶囊挂载时登记）。
		*
		* 为什么存元素而不只存打开那一刻的矩形：用户可能在弹层开着时**滚动**或拖动窗口，
		* 胶囊的位置会变。存着元素就能在每次重画时读一次**当前**矩形（读自己的元素是允许的），
		* 弹层跟着胶囊走，而不是钉在打开时的旧位置上。
		*/
		let pillElement;
		/**
		* 登记/注销胶囊元素。
		* @param element - 胶囊的 DOM 元素；`undefined` 表示卸载。
		*/
		function setPillElement(element) {
			pillElement = element;
		}
		/**
		* 读胶囊**当前**的屏幕矩形。
		* @returns 矩形；胶囊还没挂上或已卸载时 `undefined`。
		*/
		function readPillRect() {
			const element = pillElement;
			if (element === void 0) return void 0;
			try {
				return element.getBoundingClientRect();
			} catch {
				return;
			}
		}
		/** 订阅者（弹层组件挂载时登记）。 */
		const listeners$1 = /* @__PURE__ */ new Set();
		/**
		* 读当前状态（弹层每次渲染都读它）。
		* @returns 状态快照。
		*/
		function getChartState() {
			return state;
		}
		/** 通知订阅者状态变了。 */
		function emit() {
			for (const listener of listeners$1) listener();
		}
		/**
		* 订阅状态变化。
		* @param listener - 回调。
		* @returns 取消订阅。
		*/
		function subscribeChart(listener) {
			listeners$1.add(listener);
			return () => {
				listeners$1.delete(listener);
			};
		}
		/**
		* 开/关弹层（点胶囊）。
		*
		* 关的时候顺手把锚点丢掉 —— 留着会让下次打开前的一帧（如果正好在渲染）用旧位置。
		* @param anchor - 胶囊当前的屏幕矩形；`undefined` 表示这次是关。
		*/
		function toggleChart(anchor) {
			state = state.open ? {
				open: false,
				anchor: void 0,
				seconds: state.seconds
			} : {
				open: true,
				anchor,
				seconds: state.seconds
			};
			emit();
		}
		/**
		* 关掉弹层（Esc、点外面、点关闭按钮）。
		*/
		function closeChart() {
			if (!state.open) return;
			state = {
				open: false,
				anchor: void 0,
				seconds: state.seconds
			};
			emit();
		}
		/**
		* 换展示时长（弹层底部的分段按钮）。
		* @param seconds - 60 或 180（受历史长度限制）。
		*/
		function setChartSeconds(seconds) {
			if (state.seconds === seconds) return;
			state = {
				...state,
				seconds
			};
			emit();
		}
		// src/client/format.ts
		/**
		* **数字格式化**（2026-11-12，第 3 步把它从 `tps-pill.ts` 拆出来）。
		*
		* 为什么单独一个文件：胶囊和折线图弹层都要显示 tok/s，而它们**互相不 import**
		*（弹层挂在 `shell.overlay`、胶囊挂在 `conversation.composer.dock`）。共用一个
		* 格式化函数就不会出现「胶囊显示 4.2、弹层显示 4」这种各说各话的情况，
		* 也避免两个组件文件互相 import 形成环。
		*
		* @module dsh-token-tps-stats/src/client/format
		*/
		/**
		* 把数值格式化成显示文本。
		*
		* ≥10 取整、<10 保留一位（与官方 `formatTokensPerSecond` 同一口径）。
		* @param value - tok/s。
		* @returns 显示文本。
		*/
		function formatRate(value) {
			const clamped = Number.isFinite(value) ? Math.max(0, value) : 0;
			if (clamped === 0) return "0";
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/**
		* 文字的完整排版：字体族继承宿主（`--dsw-font-family` 已在 `body` 上设好）、
		* 字号/行高同官方胶囊、数字等宽（速度跳动时宽度不变，不抖）。
		*/
		const TYPO = {
			fontFamily: "inherit",
			fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
			lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
			fontVariantNumeric: "tabular-nums"
		};
		/** 弹层的表面：不透明白底（浅色主题）+ 宿主 elevation 阴影。 */
		const SURFACE = {
			background: "var(--dsw-alias-bg-base, #fff)",
			border: "none",
			/**
			* 用宿主菜单/浮层的 elevation 令牌：自带 .5px 描边 + 两级投影。
			* 不自己拼 `0 8px 24px rgba(0,0,0,.18)` —— 那比宿主重一档，看起来像另一个应用的浮窗。
			*/
			boxShadow: "var(--dsw-elevation-prominent, 0 0 0 .5px var(--dsw-alias-border-l4, #d1d5db), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d)",
			color: "var(--dsw-alias-label-primary, #1f2328)",
			/**
			* 浮层容器（`shell.overlay`）对「只是显示、不接收点击」的条目通常会关掉指针事件
			*（toast、徽标都属于这类）。我们的卡片要能点（关掉按钮、时长切换），所以**显式**
			* 打开。显式比依赖容器默认值稳 —— 宿主改默认值时这里不会跟着失灵。
			*/
			pointerEvents: "auto"
		};
		/** 弹层里的次级文字色（刻度、副标题）。 */
		const MUTED = "var(--dsw-alias-label-secondary, #6b7280)";
		/** 弹层里的分割线/网格色。 */
		const HAIRLINE = "var(--dsw-alias-border-l1, #e5e7eb)";
		/** 品牌色（折线与选中态）。 */
		const ACCENT = "var(--dsw-alias-brand-primary, #2563eb)";
		// src/client/tps-chart.ts
		/**
		* **折线图弹层**（2026-11-12，第 3 步）。
		*
		* ## 挂在哪、为什么不挂在胶囊里面
		*
		* 胶囊在 `conversation.composer.dock` —— 输入框下方、处在会滚动/被裁剪的容器里。
		* 把弹层画在那里，浮层会被那一行切掉（胶囊自己只有 20px 高）。所以弹层注册进
		* `shell.overlay`：宿主对它的描述是「横贯整帧的浮层，在所有列之上，也不在它们的
		* 滚动容器里」，正是浮层该待的地方。
		*
		* 两者不共享 React 树，只通过 {@link module:./chart-store} 交换「开没开 / 锚点 /
		* 时长」三个纯数据。
		*
		* ## 为什么弹层是 `position: fixed` + 每次重画都重算坐标
		*
		* `shell.overlay` 本身是个不占位的层。弹层摆在胶囊**正上方**（上方空间不够时摆到
		* 下方），坐标来自胶囊自己的 `getBoundingClientRect()`。弹层开着时用户可能滚动
		* 页面或拖动窗口，所以**每次重画都重新读一次**（读自己的元素是允许的；不是去读
		* 别人的 DOM 来「猜」排版）。
		*
		* ## 底色与字体（2026-11-12 用户实测反馈）
		*
		* 用户两条原话：「看到一个灰色底，希望能像官方那个胶囊一样用白色底」、
		* 「字体也要保持一致」。
		*
		* - **底色**：之前用的是 `--dsw-alias-bg-overlay` —— 那是**半透明**的浮层色，
		*   叠在聊天内容上必然发灰。现在用 `--dsw-alias-bg-base`（浅色主题就是纯白），
		*   再用宿主的 `--dsw-elevation-prominent` 阴影把卡片和背景分开，与宿主自己的
		*   菜单/浮窗同一套料。
		* - **字体**：字号/行高/字体族全部走 `styles.ts` 里那份与官方胶囊相同的排版
		*   （`--dsh-content-font-size-secondary` 等变量），不再写死 12px。
		*
		* ## 为什么空闲时也不留常驻定时器
		*
		* 弹层**只在打开时**注册 500ms 的刷新定时器（时间轴要随时间右移，即使没有新帧）。
		* 关掉立刻清掉 —— 与胶囊「归零停表」同一条纪律：不在用户看不见的地方空转。
		*
		* @module dsh-token-tps-stats/src/client/tps-chart
		*/
		/** 弹层宽度（像素）。 */
		const PANEL_WIDTH = 344;
		/** 弹层内边距（像素）：左右各 12px → 内容宽 320px。 */
		const PANEL_PADDING_X = 12;
		/** 绘图区宽度（SVG 单位，等于内容宽减去左边距）。 */
		const PLOT_WIDTH = 284;
		/** 绘图区高度（SVG 单位）。 */
		const PLOT_HEIGHT = 92;
		/** 绘图区左边距：给纵轴刻度标签留位。 */
		const PLOT_LEFT = 32;
		/** 绘图区上边距。 */
		const PLOT_TOP = 8;
		/** 整个 SVG 的 viewBox 宽（= 弹层内容宽，所以横向不会拉伸变形）。 */
		const SVG_WIDTH = 320;
		/** 整个 SVG 的 viewBox 高（含底部横轴标签）。 */
		const SVG_HEIGHT = 118;
		/** 弹层与胶囊之间的间距（像素）。 */
		const PANEL_GAP = 8;
		/** 弹层与视口边缘的最小距离（像素）。 */
		const VIEWPORT_MARGIN = 8;
		/** 弹层的大致高度（像素）：用于判断「上方放不下就放下面」。 */
		const PANEL_ESTIMATED_HEIGHT = 190;
		/** 弹层打开时的刷新间隔（毫秒）：时间轴在走，即使没有新帧也要重画。 */
		const OPEN_TICK_MS = 500;
		/** 胶囊的标记属性（与 `tps-pill.ts` 里的同名常量对应，见那里的说明）。 */
		const PILL_ATTRIBUTE$1 = "data-token-tps-pill";
		/** 弹层根节点的标记属性（判断「点在弹层里」用）。 */
		const PANEL_ATTRIBUTE = "data-token-tps-chart";
		/**
		* 计算弹层位置：优先胶囊正上方；上方空间不够就放到下方；最后夹在视口内。
		* @param anchor - 胶囊的屏幕矩形（打开那一刻取得）。
		* @returns 视口坐标下的位置。
		*/
		function panelPlacement(anchor) {
			const innerWidth = typeof window === "undefined" ? 0 : window.innerWidth;
			const innerHeight = typeof window === "undefined" ? 0 : window.innerHeight;
			if (anchor === void 0 || innerWidth <= 0) return {
				left: VIEWPORT_MARGIN,
				top: Math.max(VIEWPORT_MARGIN, innerHeight - PANEL_ESTIMATED_HEIGHT),
				below: false
			};
			const left = Math.min(Math.max(VIEWPORT_MARGIN, anchor.left), Math.max(VIEWPORT_MARGIN, innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN));
			const below = anchor.top < 198;
			return {
				left,
				top: below ? anchor.bottom + PANEL_GAP : anchor.top - PANEL_GAP,
				below
			};
		}
		/**
		* 事件目标是否落在带某个标记属性的元素内。
		*
		* 用**鸭子类型**而不是 `instanceof Element`：`Element` 是全局名字，为它单开一份
		* 类型声明会连 `@types/node` 的同名声明一起搅进来（见 `dom.d.ts` 的说明）。
		* 这里只走 `parentNode` 链 + `hasAttribute`，宿主页面里的真实元素都满足。
		* @param target - 事件目标。
		* @param attribute - 标记属性名。
		* @returns 是则 `true`。
		*/
		function insideAttribute(target, attribute) {
			let current = target;
			let guard = 0;
			while (current !== null && typeof current === "object" && guard < 64) {
				guard += 1;
				if (typeof current.hasAttribute === "function" && current.hasAttribute(attribute)) return true;
				current = current.parentNode;
			}
			return false;
		}
		/** 分段按钮的样式（选中态用品牌色，与宿主的 segmented control 同观感）。 */
		function rangeButtonStyle(active) {
			return {
				border: `1px solid ${active ? ACCENT : HAIRLINE}`,
				background: "transparent",
				color: active ? ACCENT : MUTED,
				borderRadius: "6px",
				padding: "0 8px",
				height: "22px",
				fontFamily: "inherit",
				fontSize: "11px",
				lineHeight: "20px",
				cursor: "pointer"
			};
		}
		/**
		* 时长按钮的显示文案。
		* @param seconds - 时长（秒）。
		* @returns 文案。
		*/
		function rangeLabel(seconds) {
			return seconds >= 180 ? "3 分钟" : "1 分钟";
		}
		/**
		* 折线图弹层本体。
		*
		* 关闭时返回 `null`（不占位、不注册任何监听）。
		* @returns 元素或 `null`。
		*/
		function TpsChart() {
			const [state, setState] = (0, react.useState)(() => getChartState());
			/** 每次重画的触发器；读数据时再取最新的 `Date.now()`。 */
			const [, setTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => subscribeChart(() => setState(getChartState())), []);
			(0, react.useEffect)(() => {
				if (!state.open) return;
				const timer = setInterval(() => setTick((tick) => tick + 1), OPEN_TICK_MS);
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation?.();
					closeChart();
				};
				const onPointerDown = (event) => {
					if (insideAttribute(event.target, PANEL_ATTRIBUTE)) return;
					if (insideAttribute(event.target, PILL_ATTRIBUTE$1)) return;
					closeChart();
				};
				const onResize = () => closeChart();
				window.addEventListener("keydown", onKey, true);
				window.addEventListener("pointerdown", onPointerDown, true);
				window.addEventListener("resize", onResize);
				return () => {
					clearInterval(timer);
					window.removeEventListener("keydown", onKey, true);
					window.removeEventListener("pointerdown", onPointerDown, true);
					window.removeEventListener("resize", onResize);
				};
			}, [state.open]);
			if (!state.open) return null;
			return renderPanel(state.seconds, readPillRect() ?? state.anchor);
		}
		/**
		* 渲染弹层内容。
		* @param seconds - 展示时长。
		* @param anchor - 胶囊矩形。
		* @returns 元素。
		*/
		function renderPanel(seconds, anchor) {
			const now = Date.now();
			const points = historySeries(now, seconds);
			const summary = historySummary(now, seconds);
			const max = niceMax(summary.peak);
			const geometry = buildGeometry(points.map((point) => point.value), {
				width: PLOT_WIDTH,
				height: PLOT_HEIGHT,
				max
			});
			const placement = panelPlacement(anchor);
			const quiet = summary.peak < .5;
			return (0, react.createElement)("div", {
				[PANEL_ATTRIBUTE]: "",
				role: "dialog",
				"aria-label": `实时输出速度（TPS）折线图，最近 ${rangeLabel(seconds)}`,
				style: {
					position: "fixed",
					left: `${placement.left}px`,
					top: `${placement.top}px`,
					transform: placement.below ? "none" : "translateY(-100%)",
					width: `${PANEL_WIDTH}px`,
					boxSizing: "border-box",
					padding: `10px ${PANEL_PADDING_X}px 8px`,
					...SURFACE,
					borderRadius: "12px",
					fontFamily: TYPO.fontFamily,
					fontSize: TYPO.fontSize,
					lineHeight: TYPO.lineHeight,
					fontVariantNumeric: TYPO.fontVariantNumeric,
					zIndex: 1
				}
			}, renderHeader(seconds, summary.latest, summary.average, summary.peak), renderChart({
				geometry,
				max,
				quiet,
				seconds
			}), renderFooter(seconds));
		}
		/**
		* 头部：标题 + 当前值 + 副标题（均值/峰值）+ 关闭按钮。
		* @param seconds - 展示时长。
		* @param latest - 最新一点。
		* @param average - 区间平均。
		* @param peak - 区间峰值。
		* @returns 元素。
		*/
		function renderHeader(seconds, latest, average, peak) {
			return (0, react.createElement)("div", { style: {
				display: "flex",
				alignItems: "flex-start",
				gap: "8px",
				marginBottom: "6px"
			} }, (0, react.createElement)("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				minWidth: "0",
				flex: "1"
			} }, (0, react.createElement)("span", { style: {
				fontWeight: 600,
				fontSize: "13px",
				lineHeight: "18px",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			} }, `实时输出速度（TPS）· 最近 ${rangeLabel(seconds)}`), (0, react.createElement)("span", { style: {
				color: MUTED,
				fontSize: "11px",
				lineHeight: "16px",
				whiteSpace: "nowrap"
			} }, `当前 ${formatRate(latest)} tok/s · 平均 ${formatRate(average)} · 峰值 ${formatRate(peak)}`)), (0, react.createElement)("button", {
				type: "button",
				"aria-label": "关闭折线图",
				onClick: () => closeChart(),
				style: {
					flex: "none",
					border: "none",
					background: "transparent",
					color: MUTED,
					fontFamily: "inherit",
					fontSize: "15px",
					lineHeight: "18px",
					padding: "0 2px",
					cursor: "pointer"
				}
			}, "×"));
		}
		/**
		* 折线图本体（SVG + 空态提示）。
		* @param options - 几何 + 状态。
		* @returns 元素。
		*/
		function renderChart(options) {
			const { geometry, max, quiet, seconds } = options;
			const ticks = axisTicks(max, 2);
			const gridlines = ticks.map((tick, index) => {
				const y = PLOT_TOP + (PLOT_HEIGHT - tick / max * PLOT_HEIGHT);
				return (0, react.createElement)("line", {
					key: `grid-${index}`,
					x1: PLOT_LEFT,
					x2: 316,
					y1: y,
					y2: y,
					stroke: HAIRLINE,
					strokeWidth: 1,
					strokeDasharray: index === 0 || index === ticks.length - 1 ? void 0 : "3 3"
				});
			});
			const tickLabels = ticks.map((tick, index) => {
				const y = PLOT_TOP + (PLOT_HEIGHT - tick / max * PLOT_HEIGHT) + 3;
				return (0, react.createElement)("text", {
					key: `tick-${index}`,
					x: 26,
					y,
					textAnchor: "end",
					fontSize: 10,
					fill: MUTED,
					style: { fontVariantNumeric: "tabular-nums" }
				}, formatRate(tick));
			});
			const last = geometry.points.length > 0 ? geometry.points[geometry.points.length - 1] : void 0;
			return (0, react.createElement)("div", { style: { position: "relative" } }, (0, react.createElement)("svg", {
				viewBox: `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`,
				preserveAspectRatio: "xMidYMid meet",
				width: "100%",
				height: `${SVG_HEIGHT}px`,
				"aria-hidden": "true",
				focusable: "false",
				style: {
					display: "block",
					width: "100%",
					height: `${SVG_HEIGHT}px`
				}
			}, ...gridlines, ...tickLabels, geometry.line === "" ? null : (0, react.createElement)("g", { transform: `translate(${PLOT_LEFT} ${PLOT_TOP})` }, (0, react.createElement)("path", {
				d: geometry.line,
				fill: "none",
				stroke: ACCENT,
				strokeWidth: 1.5,
				strokeLinejoin: "round"
			}), last === void 0 ? null : (0, react.createElement)("circle", {
				cx: last.x,
				cy: last.y,
				r: 2.5,
				fill: ACCENT
			})), (0, react.createElement)("text", {
				x: PLOT_LEFT,
				y: 116,
				fontSize: 10,
				textAnchor: "start",
				fill: MUTED
			}, `${seconds} 秒前`), (0, react.createElement)("text", {
				x: 316,
				y: 116,
				fontSize: 10,
				textAnchor: "end",
				fill: MUTED
			}, "现在")), quiet ? (0, react.createElement)("div", { style: {
				position: "absolute",
				left: `${174 / SVG_WIDTH * 100}%`,
				top: `${54 / SVG_HEIGHT * 100}%`,
				transform: "translate(-50%, -50%)",
				color: MUTED,
				fontSize: "11px",
				whiteSpace: "nowrap",
				pointerEvents: "none"
			} }, "这段时间还没有输出") : null);
		}
		/**
		* 底部：时长切换（分段按钮）。
		* @param seconds - 当前时长。
		* @returns 元素。
		*/
		function renderFooter(seconds) {
			const buttons = TPS_CHART_RANGES.map((range) => (0, react.createElement)("button", {
				key: `range-${range}`,
				type: "button",
				"aria-pressed": range === seconds,
				onClick: () => setChartSeconds(range),
				style: rangeButtonStyle(range === seconds)
			}, rangeLabel(range)));
			return (0, react.createElement)("div", { style: {
				display: "flex",
				alignItems: "center",
				justifyContent: "flex-end",
				gap: "6px",
				marginTop: "6px"
			} }, ...buttons);
		}
		// src/client/tps-pill.ts
		/**
		* **实时 tok/s 的显示**（2026-11-12，第 2 步；第 3 步加「可点击」）。
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
		* ## 第 3 步：点击打开折线图
		*
		* 用户新要求：「这个胶囊可以点击，点击的时候显示一段折线图，反映一段时间内 tps 的变化」。
		*
		* 实现上分三块，各自独立可测：
		* - 本文件：胶囊本体（按钮语义 + 点击时把**自己的屏幕矩形**交给状态仓库）；
		* - `chart-store.ts`：模块级开关（胶囊和弹层不共享 React 树，只能这样交换数据）；
		* - `tps-chart.ts`：画在 `shell.overlay` 上的弹层（折线图 + 时长切换）。
		*
		* 点胶囊时读的是**自己**的 `getBoundingClientRect()` —— 不是去读旁边官方胶囊的 DOM
		* 来「猜」排版。宿主允许读自己元素的矩形，弹层据此摆在胶囊正上方。
		*
		* @module dsh-token-tps-stats/src/client/tps-pill
		*/
		/** 重渲染间隔（毫秒）：100ms 足够顺滑，又不至于像 60fps 那样白烧。 */
		const TICK_MS = 100;
		/** 胶囊的标记属性（弹层用它判断「点的是不是胶囊」）。 */
		const PILL_ATTRIBUTE = "data-token-tps-pill";
		/**
		* 登记胶囊元素进状态仓库（`ref` 回调）。
		*
		* 必须是**模块级常量**：写在内联箭头函数里，每次渲染都是新引用，
		* React 会先 `ref(null)` 再 `ref(node)` —— 中间那一瞬仓库里是空引用，
		* 弹层若正好在这一帧重画，位置就丢了。
		* @param element - React 给的 DOM 元素；卸载时是 `null`。
		*/
		function registerPillElement(element) {
			if (element === null || element === void 0) {
				setPillElement(void 0);
				return;
			}
			const candidate = element;
			setPillElement(typeof candidate.getBoundingClientRect === "function" ? candidate : void 0);
		}
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
			pushHistory(text, at);
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
			display: "inline-flex",
			cursor: "pointer"
		};
		/** 与官方 `.anchor` 对齐的外壳样式（字号与行高来自共享排版，理由见 `styles.ts`）。 */
		const ANCHOR_STYLE = {
			minWidth: "0",
			fontFamily: TYPO.fontFamily,
			fontSize: TYPO.fontSize,
			lineHeight: TYPO.lineHeight,
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
		* 实时速度胶囊。**始终渲染**（空闲时显示 `0 tok/s`），点击打开折线图。
		* @returns 元素。
		*/
		function TpsPill() {
			const [value, setValue] = (0, react.useState)(() => readingAt(Date.now()));
			const [expanded, setExpanded] = (0, react.useState)(() => getChartState().open);
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
				const offChart = subscribeChart(() => setExpanded(getChartState().open));
				return () => {
					listeners.delete(listener);
					offChart();
					stop();
				};
			}, []);
			/**
			* 胶囊自己的屏幕矩形（作为弹层的锚点）。
			*
			* 鸭子类型而不是 `instanceof Element`：理由见 `dom.d.ts` —— 只为一次取值引入
			* 一整套 DOM 类型不划算。宿主页面里的真实元素一定带 `getBoundingClientRect`。
			* @param event - 点击事件。
			* @returns 矩形；拿不到时 `undefined`（弹层退回贴左下角）。
			*/
			const anchorOf = (event) => {
				const element = event.currentTarget;
				if (typeof element?.getBoundingClientRect !== "function") return void 0;
				const rect = element.getBoundingClientRect();
				return {
					left: rect.left,
					top: rect.top,
					right: rect.right,
					bottom: rect.bottom
				};
			};
			return (0, react.createElement)("span", {
				"data-composer-stat": "llm-account-tps",
				style: ANCHOR_STYLE
			}, (0, react.createElement)("button", {
				type: "button",
				[PILL_ATTRIBUTE]: "",
				ref: registerPillElement,
				style: PILL_STYLE,
				title: expanded ? "点击收起 TPS 变化曲线" : "点击查看 TPS 变化曲线",
				"aria-expanded": expanded,
				"aria-haspopup": "dialog",
				"aria-label": `实时输出速度（TPS）：${formatRate(value)} tok/s，点击查看变化曲线`,
				onClick: (event) => toggleChart(anchorOf(event))
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
		* 折线图弹层的注销句柄。
		*
		* 弹层挂在**另一个槽位**（`shell.overlay`），它的声明与 dock 的生命周期不一定
		* 同步（例如窗口宽度变化时 dock 可能重注册）—— 所以两份句柄分开存，各自可撤、
		* 互不牵连。
		*/
		let chartDispose;
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
		* 撤销折线图弹层。
		*
		* 与 {@link disposePill} 同一套「拿不到句柄就是空操作」的处理：弹层注册失败
		* 只该损失弹层，**不该**连带把胶囊也撤掉。
		*/
		function disposeChart() {
			const off = chartDispose;
			chartDispose = void 0;
			if (typeof off !== "function") return;
			try {
				off();
			} catch (error) {
				console.error("[dsh-token-tps-stats] tps chart: dispose failed:", error);
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
			disposeChart();
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
						if (typeof slots === "object" && slots !== null && typeof slots.register === "function") {
							try {
								const off = slots.register({
									name: "conversation.composer.dock",
									id: "token-tps-stats",
									order: -1
								}, TpsPill);
								pillDispose = typeof off === "function" ? off : void 0;
								console.debug("[dsh-token-tps-stats] tps pill: registered into conversation.composer.dock (order -1)");
							} catch (error) {
								console.error("[dsh-token-tps-stats] tps pill: slot registration failed:", error);
							}
							try {
								const off = slots.register({
									name: "shell.overlay",
									id: "token-tps-stats-chart"
								}, TpsChart);
								chartDispose = typeof off === "function" ? off : void 0;
								console.debug("[dsh-token-tps-stats] tps chart: registered into shell.overlay");
							} catch (error) {
								console.error("[dsh-token-tps-stats] tps chart: slot registration failed:", error);
							}
						} else console.debug("[dsh-token-tps-stats] tps pill: slots.register is unavailable, skipped");
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
