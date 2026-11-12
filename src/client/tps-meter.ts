/**
 * **实时 tok/s 的计数核心**（2026-11-12，第 2 步；第 3 步加 3 秒缓冲与防冲高）。
 *
 * 这个文件**不碰 React、不碰宿主** —— 纯函数 + 一个有状态的累加器，可以完整单测。
 *
 * ## 为什么不直接数 token
 *
 * 流式事件里只有**字符**（`chunk.text`），没有 token 数。所以这里做两件事：
 *
 * 1. 按**字符类型**分别累计（CJK 与其它）；
 * 2. 用**实测系数**换算成 token（见 {@link tokensOf}）。
 *
 * 系数来自用户本机真实数据（2026-11-12 扫 25 个会话 / 19415 条回复）：
 * **69,248,359 字符 → 13,780,630 outputTokens = 5.03 字符/token**，
 * 其中 CJK 占 3.1%、其余是代码与英文。行业经验（英文 ≈ 4 字符/token、
 * 中文 ≈ 1 字/token）与此一致；参考
 * [token-metrics](https://socket.dev/npm/package/token-metrics) 与
 * [Qwen 的 estimate_token_counter](https://github.com/rayrayraykk/CoPaw/blob/86fda39f95d5557b60952c85c1a25923e9c8f918/src/qwenpaw/agents/utils/estimate_token_counter.py)。
 *
 * ## 读数语义：1 秒窗口 × 9 窗口，再套一层 3 秒的低通
 *
 * ```
 * 帧 → 毫秒桶 → 最近 9 秒的平均速度（目标值）→ 3 秒低通 → 显示值
 * ```
 *
 * ### 第一层：最近 9 秒的平均（`TPS_WINDOWS × TPS_WINDOW_MS`）
 *
 * 用户早先明确要求「至少 9 个窗口」：3 个窗口覆盖 3 秒，帧级抖动压不住，
 * 数字会来回跳。9 个窗口覆盖 9 秒，稳得多。
 *
 * ### 第二层：3 秒缓冲（`TPS_FOLLOW_MS`）
 *
 * 用户读数后提的是：「变化速度上升太快了，下降也太快了，能不能做一个 3 秒的缓冲」。
 * 目标值本身仍然可能阶跃（例如宿主一次吐出很大一段），所以再加一层一阶低通：
 *
 * ```
 * 显示值 += (目标值 - 显示值) * (1 - e^(-dt/τ)),  τ = 3s
 * ```
 *
 * 即「瞬时速度很高，但指针要慢慢爬上去、慢慢降下来」。
 *
 * 每次 `reading()` 最多只消化 `TPS_FOLLOW_MAX_STEP_MS`（1 秒）的时间差：
 * 空闲时组件会停表，帧突然回来时 `dt` 可能有好几秒；不设上限的话低通一步就跳到
 * 目标值附近，等于白做缓冲。
 *
 * ### 停机：指针按 3 秒指数衰减
 *
 * 超过 `TPS_IDLE_GRACE_MS` 没有新帧 → 不再用分窗平均，改从**当前显示值**按
 * `TPS_DECAY_MS`（已从 700ms 改成 3s，与用户要的「慢慢降低」对齐）衰减，
 * 低于 `TPS_ZERO_THRESHOLD` 返回 `undefined`（组件据此停表，显示 0）。
 *
 * ## 为什么分母固定是 9（2026-11-12 修「偶尔冲到 300 多」）
 *
 * 旧实现只在「最近 9 个窗口里**已经有数据**」之后才把窗口计入分母
 *（`if (!anyData) continue;`），于是**停顿之后突然来一大段**时，只有最近那 1 个
 * 窗口进分母 —— 一段 1200 字符（≈286 token）就被读成 **286 tok/s**，正是用户看到的
 * 「冲到 300 多，完全不真实」。
 *
 * 现在只要最近 9 秒里有任何数据，**分母固定 9**、空窗口按 0 计入：
 * 那一段 1200 字符读成 286/9 ≈ 32 tok/s，是「最近 9 秒的平均」应有的值。
 *
 * @module dsh-token-tps-stats/src/client/tps-meter
 */

/** 窗口长度（毫秒）：用户要的「1 秒内平均值」。 */
export const TPS_WINDOW_MS = 1_000;

/**
 * 参与平均的窗口数。
 *
 * ## 为什么从 3 提到 9（2026-11-12 用户实测反馈）
 *
 * 用户看到实际效果后直接说：**「3 个窗口肯定不行，至少 9 个窗口」**。
 *
 * 3 个窗口只覆盖 3 秒，帧级抖动（不同 chunk 大小差很多：一个 `block-start`
 * 是 0 字符、一个正文 delta 可能是 200 字符）压不住，读数会来回跳。
 * 9 个窗口覆盖 9 秒，相当于对「最近 9 秒」做平均 —— 数字稳得多，代价是对
 * 速度**突变**的反应慢约 4~5 秒（模型从慢突然变快时，指针要爬一会儿才到位）。
 *
 * 这是用户明确选的取舍：**平滑优先于灵敏**。
 */
export const TPS_WINDOWS = 9;

/**
 * 「最近一帧」的宽限时间（毫秒）。
 *
 * 流式帧大约每 250ms 一批，但不保证均匀（工具调用、网关抖动都会拉长间隔）。
 * 800ms 内的间隔仍视为「还在流」，用**分窗平均**（平滑）；
 * 超过它才认为「停了」，改用**指数衰减**（指针回落）。
 *
 * 没有这个宽限的话，9 个窗口会把「停下」这件事延迟到 9 秒后才反映出来 ——
 * 指针会先僵在原地，再突然掉下去，那不像速度表。
 */
export const TPS_IDLE_GRACE_MS = 800;

/**
 * 指针回落的**时间常数**（毫秒）。
 *
 * 指数衰减 `e^(-t/τ)`：τ = 3s 时，约 3s 掉到 37%、6s 掉到 14%、10s 掉到 4%。
 *
 * ## 为什么从 700ms 改成 3s（2026-11-12 用户反馈「下降也太快了」）
 *
 * 原值 700ms 是「像汽车松油门」的直觉，但实测读数看起来是**啪一下掉下去**；
 * 用户要求与上升一样有 3 秒缓冲 —— 所以改成 3s，与 {@link TPS_FOLLOW_MS} 同量级。
 */
export const TPS_DECAY_MS = 3_000;

/**
 * 上升/追踪的**时间常数**（毫秒）：用户要的「3 秒缓冲」。
 *
 * 一阶低通：阶跃后 3s 到 63%、6s 到 86%、9s 到 95%。配合 9 秒分窗平均，
 * 从 0 爬到真实速度大约要 6~10 秒 —— 这正是用户要的「慢慢爬上去」。
 */
export const TPS_FOLLOW_MS = 3_000;

/**
 * 单次 `reading()` 最多消化的时间差（毫秒）。
 *
 * 空闲时组件会停表（值归零后没有定时器），帧突然回来时距上次读数可能过了好几秒。
 * 不设上限，低通一步就吃掉整个时间差、直接跳到目标值 —— 缓冲等于没做。
 */
const TPS_FOLLOW_MAX_STEP_MS = 1_000;

/**
 * 低于这个值就认为「已经停了」，返回 `undefined` 让组件隐藏。
 *
 * 0.5 tok/s 已经远低于任何有意义的速度，留着只会显示一个「0」，那是噪音。
 */
const TPS_ZERO_THRESHOLD = 0.5;

/**
 * 每 token 对应的 CJK 字符数。
 *
 * 取 1.0：实测中文里 1 个字基本就是 1 个 token（DeepSeek 系分词器）。
 */
const CJK_CHARS_PER_TOKEN = 1.0;

/**
 * 每 token 对应的**其它**字符数。
 *
 * 4.2 不是拍脑袋：在 CJK 占 3.1% 的前提下，要让总体落在实测的 5.03 字符/token，
 * 解得其它字符约 4.2（英文约 4、代码/JSON/路径压缩率更高，平均下来 4.2 更准）。
 */
const OTHER_CHARS_PER_TOKEN = 4.2;

/** 判断一个字符是否属于 CJK（含全角标点，它们同样 1 字 1 token）。 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) || // CJK 部首、假名、汉字
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 韩文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容汉字
    (codePoint >= 0xff00 && codePoint <= 0xffef) // 全角标点
  );
}

/**
 * 把一段文本分成 CJK 与其它字符的数量。
 *
 * 用**码位**而不是 `length`：`length` 会把 emoji 与部分汉字算成两个（UTF-16 代理对），
 * 而按码位循环更接近分词器看到的东西。
 * @param text - 增量文本。
 * @returns 两类字符的计数。
 */
export function countChars(text: string): { cjk: number; other: number } {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isCjk(codePoint)) cjk += 1;
    else other += 1;
  }
  return { cjk, other };
}

/**
 * 把字符计数换算成估算 token 数。
 * @param counts - CJK 与其它字符数。
 * @returns 估算 token 数（非负浮点）。
 */
export function tokensOf(counts: { cjk: number; other: number }): number {
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
export function decayed(last: number, elapsedMs: number, decayMs: number, threshold: number): number | undefined {
  if (elapsedMs <= 0) return last;
  if (decayMs <= 0) return undefined;
  const value = last * Math.exp(-elapsedMs / decayMs);
  return value < threshold ? undefined : value;
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
function followToward(
  previous: { value: number; at: number } | undefined,
  target: number,
  at: number,
  followMs: number,
  maxStepMs: number,
): { value: number; at: number } {
  if (previous === undefined) return { value: 0, at };
  const elapsed = at - previous.at;
  if (elapsed <= 0) return { value: previous.value, at: previous.at };
  const step = Math.min(elapsed, maxStepMs);
  const factor = followMs > 0 ? 1 - Math.exp(-step / followMs) : 1;
  return { value: previous.value + (target - previous.value) * factor, at };
}

/**
 * 实时速度计。
 *
 * 用法：每收到一帧就 `push(text, now)`，需要显示时调 `reading(now)`。
 * 内部保留最近 `TPS_WINDOWS × TPS_WINDOW_MS` 的切片，超出自动丢弃 —— 内存恒定。
 */
export interface TpsMeter {
  /** 记一帧（帧里可能同时有正文与思考，调用方各推一次即可）。 */
  push(text: string, at: number): void;
  /**
   * 读当前速度。
   * @param at - 现在（毫秒）。
   * @returns 估算 tok/s；窗口无数据且已回落到 0 时 `undefined`。
   */
  reading(at: number): number | undefined;
  /** 本轮结束：停止计入新帧，但保留窗口供指针回落。 */
  settle(at: number): void;
}

/**
 * 造一个速度计。
 * @param options - `windowMs` / `windows` / `decayMs` / `idleGraceMs` / `followMs` 可注入（测试用）。
 * @returns 速度计。
 */
export function createTpsMeter(
  options: {
    windowMs?: number;
    windows?: number;
    decayMs?: number;
    idleGraceMs?: number;
    followMs?: number;
  } = {},
): TpsMeter {
  const windowMs = options.windowMs ?? TPS_WINDOW_MS;
  const windows = options.windows ?? TPS_WINDOWS;
  const decayMs = options.decayMs ?? TPS_DECAY_MS;
  const followMs = options.followMs ?? TPS_FOLLOW_MS;
  /**
   * 空闲宽限（毫秒）：超过它才认为「已经停了」，改走指针衰减。
   *
   * 不设上限就把它绑到 `windows × windowMs`：9 窗口时那会是 9 秒，
   * 而指针僵在高位 9 秒不像仪表 —— 所以保持一个固定的、与窗口数无关的短值。
   */
  const idleGraceMs = options.idleGraceMs ?? TPS_IDLE_GRACE_MS;
  /** 保留这么长时间的数据：`windows × windowMs`。 */
  const spanMs = windowMs * windows;
  /** 按**毫秒桶**聚合：同一毫秒内的帧合并，避免逐帧存一个对象。 */
  const buckets = new Map<number, { cjk: number; other: number }>();
  /** 本轮是否已结束（结束后不再计入新帧，但读数仍可用）。 */
  let settled = false;
  /** 最后一次算出来的**目标**读数（指针回落的起点兜底）。 */
  let lastRate: { value: number; at: number } | undefined;
  /**
   * 3 秒低通之后的**显示值**（用户真正看到的数字）。
   *
   * 与 `lastRate` 分开：`lastRate` 是「最近 9 秒的平均」，是低通的输入；
   * 显示值是低通的输出。停机衰减从显示值开始，否则指针会先跳回目标值再衰减。
   */
  let displayed: { value: number; at: number } | undefined;

  /** 丢掉落出保留期的桶。 */
  const prune = (at: number): void => {
    const floor = at - spanMs;
    for (const key of buckets.keys()) {
      if (key < floor) buckets.delete(key);
    }
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
  const windowedRate = (at: number): number | undefined => {
    /** 最近一次收到帧的时刻（判断是否还在流）。 */
    let latest: number | undefined;
    for (const key of buckets.keys()) {
      if (latest === undefined || key > latest) latest = key;
    }
    /*
     * **空闲判断**：`settle` 之后，或最后一批帧距今超过宽限时间 → 交给指针衰减，
     * 不要让 9 个窗口把「已经停了」这件事拖成「还显示高位」。
     */
    if (settled || latest === undefined || at - latest > idleGraceMs) return undefined;

    let sum = 0;
    let anyData = false;
    for (let index = 0; index < windows; index += 1) {
      const from = at - (index + 1) * windowMs;
      const to = at - index * windowMs;
      let cjk = 0;
      let other = 0;
      for (const [key, slice] of buckets) {
        /*
         * **右闭左开**：`from < key <= to`。
         *
         * 第一版写成 `key >= from && key < to`，于是「帧时间正好等于 now」的那一帧
         * 落在所有窗口之外 —— 读数直接变成 undefined。这在真机上就是
         * 「刚打完字数字闪一下又没了」。窗口必须把当前时刻包含进去。
         */
        if (key > from && key <= to) {
          cjk += slice.cjk;
          other += slice.other;
        }
      }
      const windowed = tokensOf({ cjk, other });
      if (windowed > 0) anyData = true;
      // **空窗按 0 计入**（累加 0 只是为了让分母保持固定）。
      sum += (windowed / windowMs) * 1_000;
    }
    if (!anyData) return undefined;
    return sum / windows;
  };

  return {
    push: (text, at) => {
      if (settled) return;
      if (text === "") return;
      const counts = countChars(text);
      if (counts.cjk === 0 && counts.other === 0) return;
      const bucket = buckets.get(at);
      if (bucket === undefined) buckets.set(at, counts);
      else {
        bucket.cjk += counts.cjk;
        bucket.other += counts.other;
      }
      prune(at);
    },
    reading: (at) => {
      prune(at);
      const target = windowedRate(at);
      if (target !== undefined) {
        lastRate = { value: target, at };
        displayed = followToward(displayed, target, at, followMs, TPS_FOLLOW_MAX_STEP_MS);
        return displayed.value;
      }
      /*
       * 窗口里没数据：**指针回落**而不是立刻归零/立刻消失。
       *
       * 用户的说法是「像汽车速度表一样逐渐降低为 0」；后来又要求下降也别太快
       *（3 秒缓冲），所以时间常数已从 700ms 改成 3s。这里从**显示值**衰减，
       * 而不是从目标值 —— 否则指针会先跳回目标再慢慢掉，看起来更奇怪。
       */
      if (displayed === undefined) {
        if (lastRate === undefined) return undefined;
        displayed = { value: lastRate.value, at: lastRate.at };
      }
      const remaining = decayed(displayed.value, at - displayed.at, decayMs, TPS_ZERO_THRESHOLD);
      displayed = { value: remaining ?? 0, at };
      return remaining;
    },
    settle: () => {
      settled = true;
    },
  };
}
