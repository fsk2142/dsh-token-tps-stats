/** 对会话快照里的累计正文与思考做差分。 */
/** 一条流（turn/step）的标识。 */
export type StreamKey = string;

/**
 * 把 turn/step 拼成一条流的标识。
 *
 * 用 `turn:step` 而不是 `attemptId`：同一个 step 里可能重试多次（`llm/retry` 会把
 * 累计文本清零重来），那属于**同一条流**的同一个时点，标识不变才对。
 * @param turn - 轮次。
 * @param step - 步数。
 * @returns 标识。
 */
export function streamKeyOf(turn: unknown, step: unknown): StreamKey {
  return `${String(turn)}:${String(step)}`;
}

/** 一次采样的基线：记下每条流当时各块的文本，下一步只取尾部新增的部分。 */
export interface ProgressBaseline {
  /** 这份基线属于哪条流（turn:step）。 */
  readonly stream: StreamKey;
  /** 各块当时的**累计**文本；非 text/reasoning 的块是 `undefined`。 */
  readonly texts: readonly (string | undefined)[];
}

/** 差分结果。 */
export interface ProgressDelta {
  /** 新增的文本片段（通常 0~2 段：正文与思考可能同时在长）。 */
  readonly pieces: readonly string[];
  /** 供下一次采样用的新基线。 */
  readonly baseline: ProgressBaseline;
  /** The previous snapshot is still a prefix, so its token estimate can be reused. */
  readonly appendOnly: boolean;
}

/**
 * 取各块的累计文本（只认 `text` 与 `reasoning`）。
 *
 * 保留**下标对齐**：`blocks` 是按 `chunk.index` 写的，可能中间有空位（`undefined`）。
 * 差分按同一个下标比较，所以这里不压缩数组，空位留 `undefined`。
 * @param blocks - `legacy.partial.blocks` 或任何形状相近的数组。
 * @returns 与输入等长的文本数组。
 */
export function textOfBlocks(blocks: unknown): (string | undefined)[] {
  if (!Array.isArray(blocks)) return [];
  const texts: (string | undefined)[] = [];
  for (const block of blocks as readonly unknown[]) {
    if (typeof block !== "object" || block === null) {
      texts.push(undefined);
      continue;
    }
    const kind = (block as { kind?: unknown }).kind;
    const text = (block as { text?: unknown }).text;
    if ((kind === "text" || kind === "reasoning") && typeof text === "string") texts.push(text);
    else texts.push(undefined);
  }
  return texts;
}

/**
 * 算出这一拍新增的文本。
 *
 * ## 三条规则（都是踩坑后才定的）
 *
 * 1. **没有基线、或流变了（换 turn/step）**：默认只记基线。调用方确认新步骤时可计入首份快照。
 *    插件在流式进行中才挂上是常事（切会话、槽位重挂）；把当时已经累计的几百上千字
 *    一次性算成「刚到的字」，读数会直接冲顶 —— 那正是用户之前报的「冲到 1000 多」。
 * 2. **块变长且旧文本仍是前缀**：新的部分就是尾巴。
 * 3. **块变短、或被换成了另一段文本**（`llm/retry` 清零重来、下标被复用）：
 *    只更新基线、**不产出字符**。宁可少算一拍，也不要吐出一坨负增长。
 * @param baseline - 上一次采样留下的基线；第一次采样时 `undefined`。
 * @param blocks - 当前的 `legacy.partial.blocks`。
 * @param stream - 当前的流标识（见 {@link streamKeyOf}）。
 * @returns 新增片段与下一次的基线。
 */
export function newTextSince(
  baseline: ProgressBaseline | undefined,
  blocks: unknown,
  stream: StreamKey,
  includeFirst = false,
): ProgressDelta {
  const texts = textOfBlocks(blocks);
  const next: ProgressBaseline = { stream, texts };
  if (baseline === undefined || baseline.stream !== stream) {
    return {
      pieces: includeFirst ? texts.filter((text): text is string => Boolean(text)) : [],
      baseline: next,
      appendOnly: false,
    };
  }
  const pieces: string[] = [];
  const previous = baseline.texts;
  // A replacement and an insertion in the same snapshot may be a compacted block moving.
  if (previous.some((text, index) => text && !texts[index]?.startsWith(text))) {
    return { pieces, baseline: next, appendOnly: false };
  }
  for (let index = 0; index < texts.length; index += 1) {
    const current = texts[index];
    if (current === undefined || current === "") continue;
    const last = previous[index];
    const length = last?.length ?? 0;
    if (current.length > length) pieces.push(current.slice(length));
  }
  return { pieces, baseline: next, appendOnly: true };
}
