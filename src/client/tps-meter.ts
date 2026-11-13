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
        const rate = tokens / span;
        const age = span / TAU_SECONDS;
        const weight = Math.exp(-age);
        const gain = -Math.expm1(-age);
        contribution = { first: rate * gain, second: rate * (gain - age * weight) };
      } else {
        // Point input. Chunks with identical timestamps add to the same state.
        contribution = { first: tokens / TAU_SECONDS, second: 0 };
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
