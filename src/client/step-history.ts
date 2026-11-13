/**
 * **每一步的账**（2026-11-13）。
 *
 * ## 用户要的是什么
 *
 * > 每步平均这里不用按照折线图显示，直接列出来第一步，输出多少，输入多少，
 * > 命中多少，平均速率多少，这样子
 *
 * 随后又明确了**列的顺序与简称**：
 *
 * > 应该先是缓存读取、未缓存输入、输出、缓存命中、平均速度，
 * > 但是都用简写：读取 / 输入 / 输出 / 命中 / 速度。
 *
 * 所以一行是：步号 · 读取 · 输入 · 输出 · 命中 · 速度。
 *
 * ## 两种数据、两个来源
 *
 * 1. **token 用量**：宿主的助手节点上带 `usage`
 *    （`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` /
 *    `reasoningTokens` / `totalTokens`）。这是**真实数字**，不是估算 ——
 *    列表里显示的就是账单上的数。
 * 2. **速度**：用量里没有时长。两个来源，按可靠程度排：
 *    - 我们自己观察到的「有字在流」时长（`activeMs`，页面在流式期间就挂上时有）；
 *    - 宿主节点上的 `timing`（`completedTime − firstTokenTime` = 这一步真正在生成
 *      的那段时间，含工具参数生成，不含等工具返回）。
 *    两个都没有就显示 `—`，**不拿墙钟凑数** —— 一步里含工具调用，把等待算进
 *    分母会让平均值低得没有意义。
 *
 * ## 为什么单次间隔封顶、时长有下限
 *
 * 主线程被占住几秒后一次交付一大段，不封顶会让那一段被算成很长的流式时间；
 * 而全部字恰好落在同一帧里时长又会接近 0，除出天文数字。封顶 2 秒 + 下限 500
 * 毫秒的结果是**分母只可能偏大、读数只可能偏低** —— 宁可少报，不出假峰值
 * （用户为「偶尔冲到 300 多」专门提过一次）。
 *
 * @module dsh-token-tps-stats/src/client/step-history
 */

/** 弹窗里「每步」视图可选的步数档。 */
export const TPS_STEP_RANGES = [5, 10, 20] as const;

/** 可选步数档的类型。 */
export type TpsStepRange = (typeof TPS_STEP_RANGES)[number];

/** 默认显示几步。 */
export const TPS_STEP_DEFAULT = 5;

/** 最多留多少步（20 步档留一倍余量，便于切档时不丢最近的）。 */
const MAX_STEPS = 40;

/** 单次交付的间隔最多计多久（毫秒）：见文件头。 */
const STEP_GAP_CAP_MS = 2_000;

/** 一步的时长下限（毫秒）：见文件头。 */
const MIN_DURATION_MS = 500;

/** 一步的真实用量（字段名与宿主 `usage` 完全一致，不另外造词）。 */
export interface StepUsage {
  /**
   * **未缓存输入** token（宿主 `inputTokens`）。
   *
   * 注意它**不含**缓存读取：宿主把「命中缓存的部分」单独放在 `cacheReadTokens`。
   * 所以「输入」这一列读它，而不是 `totalTokens − outputTokens`（后者含缓存）。
   */
  readonly inputTokens?: number;
  /** 输出 token。 */
  readonly outputTokens?: number;
  /** 缓存读取（命中）的 token。 */
  readonly cacheReadTokens?: number;
  /** 缓存写入的 token。 */
  readonly cacheWriteTokens?: number;
  /** 推理 token。 */
  readonly reasoningTokens?: number;
  /** 总 token。 */
  readonly totalTokens?: number;
  /**
   * 这一步真正在生成的时长（毫秒），由宿主节点的 `timing` 折算：
   * `completedTime − firstTokenTime`。
   *
   * 不含「等工具返回」那段 —— 所以比墙钟可信。
   */
  readonly generationMs?: number;
}

/** 列表里的一行（按**最新在前**排）。 */
export interface StepRow {
  /** 轮次。 */
  readonly turn: number;
  /** 步数（这一轮里的第几步）。 */
  readonly step: number;
  /** **读取**：缓存读取的 token；没有用量时 `undefined`。 */
  readonly cacheReadTokens: number | undefined;
  /** **输入**：未缓存的输入 token；没有用量时 `undefined`。 */
  readonly inputTokens: number | undefined;
  /** **输出**：输出 token（有真实用量就用它，否则用流式期间的估算）。 */
  readonly outputTokens: number;
  /** **命中**：缓存读取占整个提示（读取 + 输入 + 写入）的比例；算不出时 `undefined`。 */
  readonly hitRatio: number | undefined;
  /** **速度**：平均速率（tok/s）；量不到时长时 `undefined`。 */
  readonly speed: number | undefined;
  /** 是否拿到了真实用量（`false` = 这一行是流式期间估出来的）。 */
  readonly measured: boolean;
  /** 是不是还在进行中的那一步。 */
  readonly running: boolean;
}

/** 步统计的对外面。 */
export interface StepHistory {
  /**
   * 记一次流式交付（由 `session-store.ts` 每拍调用）。
   * @param stream - 流标识（`turn:step`）。
   * @param turn - 轮次。
   * @param step - 步数。
   * @param tokens - 这次交付的估算 token 数。
   * @param gapMs - 距上一次采样的间隔（毫秒）；内部按上限截断。
   */
  add(stream: string, turn: number, step: number, tokens: number, gapMs: number): void;
  /**
   * 记一步的**真实用量**（宿主节点上带 `usage` 时调用）。
   *
   * 幂等：同一 `turn:step` 重复调用只会更新，不会多出一行（宿主每帧都给新数组，
   * 同一步的用量不会变）。
   * @param turn - 轮次。
   * @param step - 步数。
   * @param usage - 真实用量。
   */
  settle(turn: number, step: number, usage: StepUsage): void;
  /** 最近 `count` 步（**最新在前**）。 */
  rows(count: number): StepRow[];
}

/** 一步的累积状态。 */
interface Draft {
  readonly stream: string;
  readonly turn: number;
  readonly step: number;
  /** 流式期间估出来的 token（真实用量到达前的兜底）。 */
  estimatedTokens: number;
  /** 观察到「有字在流」的总时长（毫秒，已截断）。 */
  activeMs: number;
  /** 拿到真实用量后填上。 */
  usage: StepUsage | undefined;
  /** 是否已经结束（拿到过真实用量）。 */
  settled: boolean;
}

/**
 * 造一个步统计器。
 * @returns 步统计器。
 */
export function createStepHistory(): StepHistory {
  /** 按 `turn:step` 收着；Map 的插入顺序就是先后顺序。 */
  const drafts = new Map<string, Draft>();

  /** 当前正在流的那一步（槽位组件每拍告诉它「现在是谁」）。 */
  let current: string | undefined;

  /** 取/建这一步的草稿。 */
  const draftOf = (stream: string, turn: number, step: number): Draft => {
    let draft = drafts.get(stream);
    if (draft === undefined) {
      draft = { stream, turn, step, estimatedTokens: 0, activeMs: 0, usage: undefined, settled: false };
      drafts.set(stream, draft);
      // 超出上限就丢最旧的（Map 保持插入顺序，第一个就是最旧的）。
      while (drafts.size > MAX_STEPS) {
        const oldest = drafts.keys().next();
        if (oldest.done === true) break;
        drafts.delete(oldest.value);
      }
    }
    return draft;
  };

  return {
    add: (stream, turn, step, tokens, gapMs) => {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      current = stream;
      const draft = draftOf(stream, turn, step);
      draft.estimatedTokens += tokens;
      draft.activeMs += Math.min(Math.max(0, Number.isFinite(gapMs) ? gapMs : 0), STEP_GAP_CAP_MS);
    },
    settle: (turn, step, usage) => {
      const stream = `${String(turn)}:${String(step)}`;
      const draft = draftOf(stream, turn, step);
      draft.usage = usage;
      draft.settled = true;
    },
    rows: (count) => {
      const requested = Math.max(1, Math.floor(count));
      const list = [...drafts.values()].slice(-requested).reverse();
      return list.map((draft) => {
        const usage = draft.usage;
        const outputTokens = usage?.outputTokens ?? draft.estimatedTokens;
        /*
         * 提示总量 = 读取 + 未缓存输入 + 写入。用它算命中率，而不是
         * `totalTokens − outputTokens` —— 后者在 `totalTokens` 缺省或有其它
         * 组成项时会对不上，前者的定义是我们自己拼得出来的。
         */
        const prompt =
          (usage?.cacheReadTokens ?? 0) + (usage?.inputTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
        const hitRatio = usage?.cacheReadTokens === undefined || prompt <= 0 ? undefined : usage.cacheReadTokens / prompt;
        /*
         * 时长优先用**我们自己观察到的**流式时间；没观察到（页面在步骤结束后才挂上）
         * 就退回宿主的 `timing`：`completedTime − firstTokenTime`，那才是「在生成」的
         * 那一段，不含等工具返回。
         *
         * 「观察到」的判据是 `estimatedTokens > 0`（见过 delta），不是
         * `activeMs >= 下限`：全部字恰好落在同一毫秒里时 `activeMs` 就是 0，
         * 那仍然是**观察到了**，该按下限兜底而不是判成「未知」。
         */
        const observed = draft.estimatedTokens > 0 ? Math.max(draft.activeMs, MIN_DURATION_MS) : undefined;
        const generation = usage?.generationMs;
        const durationMs = observed ?? (generation !== undefined && generation > 0 ? generation : undefined);
        return {
          turn: draft.turn,
          step: draft.step,
          cacheReadTokens: usage?.cacheReadTokens,
          inputTokens: usage?.inputTokens,
          outputTokens,
          hitRatio,
          speed: durationMs === undefined ? undefined : (outputTokens / durationMs) * 1_000,
          measured: usage !== undefined,
          running: draft.stream === current && !draft.settled,
        };
      });
    },
  };
}

/** **仅供测试**：导出内部常量，方便断言边界。 */
export const STEP_HISTORY_CONSTANTS = {
  maxSteps: MAX_STEPS,
  gapCapMs: STEP_GAP_CAP_MS,
  minDurationMs: MIN_DURATION_MS,
} as const;
