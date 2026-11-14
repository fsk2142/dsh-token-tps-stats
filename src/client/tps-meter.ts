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

const TAU_SECONDS = 0.65;
const ZERO_THRESHOLD = 0.5;

/**
 * **一次到达的隐含速率上限**（tok/s）。
 *
 * ## 为什么需要它（2026-11-14 用户截图：一个 3925 tok/s 的假峰）
 *
 * 点冲激（`span <= 0`）那一支没有时长作分母，`first += tokens / τ`；
 * 而 `second` 在 100ms 后的读数 ≈ **0.566 × tokens**。于是 3925 反推出
 * **约 19300 token 在一次到达里出现** —— 没有任何模型能在一次 delta 里吐 19000
 * token，那必然是「宿主把已累计的整段文本重新 append」（重新订阅 / 重新基线 /
 * 页面从后台回来）。同一段文字被再算一次，就成了那个尖峰。
 *
 * ## 为什么按**速率**钳而不是按 token 数钳
 *
 * 按 token 数钳（例如 600）会误伤：真实的高速输出（主线程卡 6 秒后补发 600 token）
 * 和「重放 19300 token」在 token 数上分不开。而**速率**分得开 ——
 * 任何模型的输出速度都有物理上界（当前实测最高约 1500 tok/s，
 * `docs/tps-algorithm-review-gpt.md` 里 180 步的真实数据也在这个量级）。
 *
 * 取 {@link MAX_INTERVAL_RATE}：给 4 倍余量，同时把 19000 token 的重放钳到几百。
 * 两种分支都钳（点冲激钳「tokens / τ」，区间积分钳「tokens / span」），
 * 因为**两种分支都可能被重放喂爆** —— 实测 19300 token 跨 3 秒也读出了 6071。
 */
const MAX_INTERVAL_RATE = 3_000;

interface FilterState {
  readonly first: number;
  readonly second: number;
}

function afterSilence(state: FilterState, seconds: number): FilterState {
  if (seconds <= 0) return state;
  const age = seconds / TAU_SECONDS;
  const weight = Math.exp(-age);
  return {
    first: weight * state.first,
    second: weight * (state.second + age * state.first),
  };
}

export interface TpsMeter {
  /** Add a token count at its source time, when it becomes observable locally. */
  push(tokens: number, at: number, receivedAt?: number, from?: number): boolean;
  reading(at: number): number;
  active(at: number): boolean;
}

/** Two cascaded exponential filters. Reads do not advance the committed state. */
export function createTpsMeter(): TpsMeter {
  let state: FilterState = { first: 0, second: 0 };
  let updatedAt = -Infinity;

  const readingAt = (at: number): FilterState =>
    updatedAt === -Infinity ? state : afterSilence(state, (at - updatedAt) / 1_000);

  return {
    push(tokens, at, receivedAt = at, from = at) {
      if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(at) || !Number.isFinite(receivedAt)) return false;
      const now = Math.max(receivedAt, updatedAt);
      const end = Math.min(at, now);
      const span = (end - from) / 1_000;
      const previous = readingAt(now);
      let contribution: FilterState;
      if (span > 0) {
        // Integrate a constant input over the observed snapshot interval.
        /*
         * 区间积分：分母是真实跨过的时长。**仍然要钳速率** —— 实测「19300 token
         * 跨 3 秒」也读出了 6071 tok/s，那同样是重放，只是被摊到了 3 秒里。
         */
        const rate = Math.min(tokens / span, MAX_INTERVAL_RATE);
        const age = span / TAU_SECONDS;
        const weight = Math.exp(-age);
        const gain = -Math.expm1(-age);
        contribution = { first: rate * gain, second: rate * (gain - age * weight) };
      } else {
        // Point input. Chunks with identical timestamps add to the same state.
        /*
         * 点冲激：没有时长作分母，用 `tokens / τ` 当等效速率，同样钳住。
         */
        contribution = { first: Math.min(tokens / TAU_SECONDS, MAX_INTERVAL_RATE), second: 0 };
      }
      const arriving = afterSilence(contribution, (now - end) / 1_000);
      state = { first: previous.first + arriving.first, second: previous.second + arriving.second };
      updatedAt = now;
      return Math.max(state.first, state.second) >= ZERO_THRESHOLD;
    },
    reading(at) {
      const { second } = readingAt(at);
      return second < ZERO_THRESHOLD ? 0 : second;
    },
    active(at) {
      const { first, second } = readingAt(at);
      return Math.max(first, second) >= ZERO_THRESHOLD;
    },
  };
}

/** **仅供测试**：导出上限，便于断言边界。 */
export const TPS_METER_CONSTANTS = { maxIntervalRate: MAX_INTERVAL_RATE } as const;
