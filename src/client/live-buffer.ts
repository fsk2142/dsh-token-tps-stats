/**
 * **流式 chunk 的排队与重排**（2026-11-13，修「峰值偶尔冲到 1000 多」）。
 *
 * ## 为什么要排队
 *
 * 重排（{@link module:./pacing} 的 `retimeBatch`）需要**先知道这一批的最后一帧**，
 * 才能把整批按宿主时间铺回它真正跨越的那段时间。流式事件是逐条回调的，
 * 所以要攒一小会儿再一起处理。
 *
 * ## 攒多久
 *
 * 一个**宏任务**（`setTimeout(0)`）。理由：
 *
 * - 正常流式下，宿主每批 chunk 都发生在同一个任务里，攒完立刻排空 —— 延迟 ~0~4ms，
 *   读数与「逐帧立即推送」没有区别；
 * - **积压 flush** 时（主线程被占住后一次收到几千帧），它们也都在同一个任务里，
 *   排空时 `Date.now()` 已经不再前进，`retimeBatch` 正好能把它们摊回那几十秒。
 *
 * 不用 `requestAnimationFrame`：标签页在后台时它会被节流，积压反而更严重。
 *
 * ## 为什么不用模块级定时器常驻
 *
 * 定时器**只在有帧排队时**存在，排空后立刻清掉 —— 与胶囊「归零停表」同一条纪律。
 *
 * @module dsh-token-tps-stats/src/client/live-buffer
 */

import { retimeBatch, type TimedChunk } from "./pacing";

/** 一帧待处理的流式文本。 */
export interface PendingFrame extends TimedChunk {
  /** 增量文本（已确认非空）。 */
  readonly text: string;
}

/** 排空的回调收到的东西。 */
export interface FlushedFrame {
  /** 这一帧应该记到哪个本地时刻（毫秒）。 */
  readonly at: number;
  /** 增量文本。 */
  readonly text: string;
}

/**
 * 造一个帧缓冲。
 * @param flush - 排空时按**已算好的时刻**逐帧回调（顺序 = 到达顺序）。
 * @param schedule - 安排一次排空（生产是 `setTimeout(fn, 0)`；测试可同步调用）。
 * @param cancel - 取消已安排但未执行的排空。
 * @returns 推送入口与清理函数。
 */
export function createLiveBuffer(
  flush: (frames: readonly FlushedFrame[]) => void,
  schedule: (run: () => void) => unknown = (run) => setTimeout(run, 0),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): { push(frame: PendingFrame): void; dispose(): void } {
  /** 待排空的帧。 */
  let pending: PendingFrame[] = [];
  /** 已安排的排空（`undefined` 表示没有）。 */
  let scheduled: unknown;
  /** 是否已经清理（清理后到的帧直接丢弃，避免在卸载时继续算）。 */
  let disposed = false;

  /** 排空队列：先重排时间，再逐帧回调。 */
  const drain = (): void => {
    scheduled = undefined;
    if (disposed) return;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    /*
     * 批尾对齐到**现在**：这一批字是我们等到此刻才处理的，最新那一帧就落在此刻，
     * 其余按宿主时间差往前推。`Date.now()` 只读一次，整批用同一个基准。
     */
    const times = retimeBatch(batch, Date.now());
    const frames: FlushedFrame[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const at = times[index];
      // `null` = 比折线图能画的最长历史还旧（重排时会被丢弃，见 `pacing.ts`）。
      if (at === null || at === undefined) continue;
      frames.push({ at, text: batch[index]!.text });
    }
    if (frames.length > 0) flush(frames);
  };

  return {
    push: (frame) => {
      if (disposed) return;
      pending.push(frame);
      if (scheduled !== undefined) return;
      scheduled = schedule(drain);
    },
    dispose: () => {
      disposed = true;
      if (scheduled !== undefined) {
        cancel(scheduled);
        scheduled = undefined;
      }
      pending = [];
    },
  };
}
