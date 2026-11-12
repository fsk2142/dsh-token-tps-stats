/**
 * **流式文本的差分**（2026-11-13，为「每个会话各自统计」改数据源）。
 *
 * ## 为什么不再吃 `assistant/live-chunk` 事件
 *
 * 用户原话：「另外应该统计的是每个会话自己的速度，我看怎么是全局的会话速度？」、
 * 「官方的那个轮次胶囊就是显示当前会话任务的信息，这个实时输出速度希望也是显式
 * 当前会话的输出信息，因为每个会话使用的模型可能不一样，所以不能全局统计」。
 *
 * 我先前的实现注册了一个 `uiConversation.events` 的 Definition（kind
 * `dsh-token-tps-stats-meter`），把每一帧流式文本累加进一个**模块级**速度计。
 * 问题在宿主的装配方式：Definition 注册表是**全局**的（键是 kind，重复注册直接抛错），
 * 而每个会话各自有一个装配器，把所有已注册 Definition 拿去匹配**自己那份**事件流。
 * 于是同一个 Definition 会被每一个会话分别调用 —— 我把它们全都加进了同一个累加器，
 * 读数自然是「所有会话合起来的速度」。子代理（subagent）同时跑的时候尤其离谱：
 * 它和父会话的字被算成一份。
 *
 * `assistant/live-chunk` 的载荷里只有 `attemptId / turn / step / chunk`，**没有会话 id**，
 * 从事件回调里根本分不出是哪个会话。所以正确的数据源不是事件，而是**槽位属性里的
 * 会话快照**：dock 是 `scope: "session"` 的槽位，它的使用者拿到的 `useChat` 选择器
 * 只会返回**当前这个会话**的聊天快照（官方那两个胶囊（轮次/步数、用量）正是这么读的）。
 *
 * ## 快照里只有「累计文本」，所以这里做差分
 *
 * `legacy.partial` 是「正在生成的这一步」，形状 `{ turn, step, blocks }`，其中
 * `blocks[i].text` 是**累计**文本（宿主每来一帧就 `text + delta` 拼一次）。拿不到增量，
 * 只能自己减：本文件算出「这一拍新增了哪些字符」。
 *
 * 这一步必须是纯函数：差分写错会直接变成读数翻倍（重复计）或恒为 0（漏计），
 * 只能靠断言钉住。
 *
 * ## 哪些块的文本要计入
 *
 * 只算 `text` 与 `reasoning`：思考也是模型真实产出的字（官方 `outputTokens` 含它），
 * 而 `tool-call` 的参数不算（那部分不在 `outputTokens` 的口径里）。
 *
 * @module dsh-token-tps-stats/src/client/progress
 */

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
 * 1. **没有基线、或流变了（换 turn/step）**：只记基线、**不产出字符**。
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
): ProgressDelta {
  const texts = textOfBlocks(blocks);
  const next: ProgressBaseline = { stream, texts };
  if (baseline === undefined || baseline.stream !== stream) return { pieces: [], baseline: next };
  const pieces: string[] = [];
  const previous = baseline.texts;
  for (let index = 0; index < texts.length; index += 1) {
    const current = texts[index];
    if (current === undefined || current === "") continue;
    const last = previous[index];
    if (last === undefined) {
      // 新出现的块：整段都是这一拍之前没见过的字。
      pieces.push(current);
      continue;
    }
    if (current.length <= last.length) continue;
    if (!current.startsWith(last)) continue;
    pieces.push(current.slice(last.length));
  }
  return { pieces, baseline: next };
}
