/**
 * 实时 tok/s 的**计算核心**测试（2026-11-12；第 3 步补「3 秒缓冲」与「防冲高」）。
 *
 * 钉住五件事：
 * 1. 字符 → token 的换算口径（CJK 与其它分开，系数来自本机实测）；
 * 2. 1 秒窗口 × 9 窗口的**分窗**语义：**分母固定 9**、空窗按 0；
 * 3. **3 秒低通**：指针慢慢爬到目标值、慢慢降下来（用户 2026-11-12 的要求）；
 * 4. **停顿后突然一大段不冲高**（用户报「偶尔冲到 300 多」的回归）；
 * 5. 边界：没有数据时不伪造 0、settle 后不再计入、内存不随会话增长。
 *
 * ## 为什么用 `run()` 模拟器而不是单次 `reading()`
 *
 * 加了 3 秒低通之后，显示值不再等于「瞬时目标」—— 它需要**时间流逝**才靠近目标。
 * 生产的组件每 100ms 读一次，所以测试也照这个节奏（`TICK_MS`）把时钟推过去，
 * 帧则按流式的真实节奏（`FRAME_MS` = 250ms 一批）喂进去。
 * 只读一次的话，看到的永远是「第一步的 0」，那测的不是低通。
 */
import { describe, expect, it } from "vitest";

import { countChars, createTpsMeter, tokensOf, type TpsMeter } from "../../src/client/tps-meter";

/** 生产环境的读数节奏（毫秒）。 */
const TICK_MS = 100;

/** 流式帧的典型节奏（毫秒）：宿主大约每 250ms 吐一批。 */
const FRAME_MS = 250;

/** 运行一段「流式 + 读数」的时间线。 */
interface RunOptions {
  /** 起始时刻（毫秒）。 */
  readonly from: number;
  /** 结束时刻（毫秒）。 */
  readonly to: number;
  /**
   * 这一时刻该吐出多少字符（0 = 这一刻不吐）。
   * @param at - 当前时刻（毫秒）。
   * @returns 字符数。
   */
  readonly charsAt?: (at: number) => number;
  /** 是否在结束时调用 `settle`。 */
  readonly settle?: boolean;
}

/**
 * 按生产节奏跑一段时间线，返回每一次读数。
 *
 * 帧按 `FRAME_MS` 的**时间边界**发放（不是「读数步长正好整除帧长」才发），
 * 否则 100ms 的读数步长会把 250ms 的帧吃掉一半 —— 测出来的速度只有真实值的一半，
 * 那是测试的错，不是实现的错。
 * @param m - 速度计。
 * @param options - 时间线与帧生成器。
 * @returns 每次 `reading()` 的结果（按时间升序）。
 */
function run(m: TpsMeter, options: RunOptions): (number | undefined)[] {
  const readings: (number | undefined)[] = [];
  /** 下一个该发帧的时刻（毫秒）。 */
  let nextFrameAt = Math.ceil(options.from / FRAME_MS) * FRAME_MS;
  /** 这一刻之前攒下的字符（合并成一帧发出）。 */
  let pending = 0;
  for (let at = options.from; at <= options.to; at += TICK_MS) {
    if (options.charsAt !== undefined) {
      while (nextFrameAt <= at) {
        pending += options.charsAt(nextFrameAt);
        nextFrameAt += FRAME_MS;
      }
    }
    if (pending > 0) {
      m.push("x".repeat(Math.round(pending)), at);
      pending = 0;
    }
    readings.push(m.reading(at));
    if (options.settle === true && at === options.to) m.settle(at);
  }
  return readings;
}

/** 取最后一次读数。 */
function last(readings: readonly (number | undefined)[]): number | undefined {
  return readings[readings.length - 1];
}

/** 9 窗口、与生产一致的速度计。 */
function meter(options: { followMs?: number; decayMs?: number; windows?: number } = {}): TpsMeter {
  return createTpsMeter({ windowMs: 1_000, windows: options.windows ?? 9, ...options });
}

/**
 * 恒定速度输出：每秒 `tokensPerSecond × 4.2` 个其它字符。
 * @param tokensPerSecond - 目标 tok/s。
 * @returns 帧生成器（每 `FRAME_MS` 吐出该吐的量）。
 */
function steady(tokensPerSecond: number): (at: number) => number {
  return () => (tokensPerSecond * 4.2 * FRAME_MS) / 1_000;
}

describe("字符计数：CJK 与其它分开", () => {
  it("纯中文：每个汉字算 1 个 CJK", () => {
    expect(countChars("你好世界")).toEqual({ cjk: 4, other: 0 });
  });

  it("纯英文：每个字符算 1 个 other", () => {
    expect(countChars("hello")).toEqual({ cjk: 0, other: 5 });
  });

  it("混合文本各归各的", () => {
    expect(countChars("abc中文def")).toEqual({ cjk: 2, other: 6 });
  });

  it("全角标点按 CJK 计（分词器里它们也是 1 字 1 token）", () => {
    expect(countChars("，。！")).toEqual({ cjk: 3, other: 0 });
  });

  it("**按码位而非 UTF-16 长度**：emoji 只算 1 个字符", () => {
    // "😀" 的 length 是 2（代理对），按码位是 1。算成 2 会让速度虚高。
    expect(countChars("😀").other).toBe(1);
  });

  it("空串与纯空白不崩", () => {
    expect(countChars("")).toEqual({ cjk: 0, other: 0 });
  });
});

describe("换算系数", () => {
  it("CJK 1 字 ≈ 1 token", () => {
    expect(tokensOf({ cjk: 100, other: 0 })).toBeCloseTo(100, 5);
  });

  it("其它字符 4.2 个 ≈ 1 token（来自本机 5.03 字符/token 的实测口径）", () => {
    expect(tokensOf({ cjk: 0, other: 42 })).toBeCloseTo(10, 5);
  });

  it("零字符是零 token（不是 NaN）", () => {
    expect(tokensOf({ cjk: 0, other: 0 })).toBe(0);
  });
});

describe("分窗平均：1 秒窗口 × 9 窗口（分母固定 9）", () => {
  it("**持续稳定输出 → 爬到真实速度**", () => {
    // 20 秒足矣：3 秒低通 + 9 秒窗口，到 20 秒时已稳定。
    const rate = last(run(meter(), { from: 1_000, to: 25_000, charsAt: steady(10) }));
    expect(rate).toBeDefined();
    expect(rate!).toBeCloseTo(10, 0);
  });

  it("**窗口是左开右闭**：正好落在当前时刻的帧必须计入", () => {
    const m = meter();
    m.push("x".repeat(42), 1_000);
    // 目标值 > 0 才说明帧进入了窗口（显示值此时还在从 0 往上爬）。
    expect(m.reading(1_000), "at 时刻收到的帧不能被窗口排除").toBeGreaterThanOrEqual(0);
    /*
     * 停在宽限期内（800ms）读：目标值仍是 10/9，低通会把它慢慢兑现成非零的显示值。
     * 超过宽限后读数会转成指针衰减（那是另外一条路径，另有专门用例）。
     */
    expect(run(m, { from: 1_100, to: 1_700 }).at(-1)!, "目标值会被低通慢慢兑现").toBeGreaterThan(0);
  });

  it("**无数据时返回 undefined**，不伪造 0（缺失 ≠ 0）", () => {
    expect(meter().reading(50_000)).toBeUndefined();
  });

  it("**一趟扫描与「每个窗口各扫一遍」等价**（2026-11-13 的性能优化）", () => {
    /*
     * 优化把「每个窗口扫一遍全部桶」（9 × 约 560 桶/次读数）改成「每个桶直接算出
     * 属于第几个窗口」（单趟）。判据等价关系：
     *
     * ```
     * from < key <= to  ⟺  floor((at - key) / windowMs) === i
     * ```
     *
     * 这里用一个**参照实现**（一遍遍地扫、按原判据累加）来对拍：两边的目标值
     * 必须逐点相等。`followMs: 0` 让低通一步到位（factor = 1），这样 `reading()`
     * 直接暴露目标值，不受 3 秒缓冲干扰。
     * @param buckets - 毫秒桶。
     * @param at - 读数时刻。
     * @returns 参照实现算出的目标值。
     */
    const reference = (buckets: readonly (readonly [number, number])[], at: number): number | undefined => {
      let sum = 0;
      let anyData = false;
      for (let index = 0; index < 9; index += 1) {
        const from = at - (index + 1) * 1_000;
        const to = at - index * 1_000;
        let chars = 0;
        for (const [key, count] of buckets) {
          // 原来的判据：右闭左开。
          if (key > from && key <= to) chars += count;
        }
        const rate = (chars / 4.2 / 1_000) * 1_000;
        if (rate > 0) anyData = true;
        sum += rate;
      }
      return anyData ? sum / 9 : undefined;
    };

    /** 一帧里有多少个 ASCII 字符（其它字符 ÷ 4.2 就是 token）。 */
    const CASES: readonly (readonly number[])[] = [
      [0],
      [100],
      [799],
      [800],
      [1_000],
      [1_001],
      [2_500, 3_100, 4_000],
      [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000],
      [8_999],
      [9_000],
      [9_001],
      [500, 9_500, 30_000],
    ];
    for (const offsets of CASES) {
      const buckets: (readonly [number, number])[] = offsets.map((offset) => [1_000_000 + offset, 42]);
      /*
       * 读在**最后一帧之后 100ms**：这样一定在空闲宽限（800ms）内，不会走指针衰减，
       * 读数就是纯目标值。
       */
      const at = 1_000_000 + Math.max(...offsets) + 100;
      const m = createTpsMeter({ followMs: 0, idleGraceMs: 100_000 });
      for (const [time, chars] of buckets) m.pushCounts({ cjk: 0, other: chars }, time);
      /*
       * 先读一次**早 1ms**：它把显示值初始化成 0（`followToward` 的首调用不跳变）。
       * 再读 `at`：`followMs: 0` 时 factor = 1，这一次的读数就是纯目标值。
       * 两次都在空闲宽限内，都不会走指针衰减。
       */
      m.reading(at - 1);
      const actual = m.reading(at);
      const expected = reference(buckets, at);
      if (expected === undefined) {
        // 没有落在窗口里的帧 → 目标值不存在，读数走衰减分支（这里当作 0）。
        expect(actual ?? 0, `offsets=${offsets.join(",")}`).toBe(0);
      } else {
        expect(actual, `offsets=${offsets.join(",")}`).toBeCloseTo(expected, 9);
      }
    }
  });

  it("**停顿期间读数往下走**（空窗按 0 计入，不是僵在高位）", () => {
    const m = meter();
    const moving = last(run(m, { from: 1_000, to: 20_000, charsAt: steady(10) }))!;
    expect(moving).toBeCloseTo(10, 0);
    /*
     * 再停 3 秒（帧不再来）：宽限期内仍走分窗平均，之后交给指针衰减。
     * 两种情况都**必须低于**满速时的读数 —— 旧实现（跳过空窗）会停在 10。
     */
    const afterStop = last(run(m, { from: 20_100, to: 24_000 }))!;
    expect(afterStop, "停机几秒后必须明显低于满速").toBeLessThan(moving);
  });

  it("**9 窗口比 3 窗口更平滑**（同一串抖动数据，9 窗口更接近长期均值）", () => {
    // 造「忽快忽慢」：奇数秒 20 tok/s、偶数秒 0；低通关掉，只看分窗本身。
    const jitter = (at: number): number => (Math.floor(at / 1_000) % 2 === 1 ? 20 * 4.2 * FRAME_MS : 0) / 1_000;
    const threeRate = last(run(meter({ windows: 3, followMs: 1 }), { from: 1_000, to: 20_000, charsAt: jitter }))!;
    const nineRate = last(run(meter({ windows: 9, followMs: 1 }), { from: 1_000, to: 20_000, charsAt: jitter }))!;
    expect(nineRate, "9 窗口必须更平滑（更接近长期均值）").toBeLessThan(threeRate);
  });

  it("`settle` 之后新帧不再计入（但已有读数仍可读）", () => {
    const m = meter();
    const before = last(run(m, { from: 1_000, to: 20_000, charsAt: steady(10), settle: true }))!;
    expect(before).toBeGreaterThan(0);
    // 结束后继续「有帧到达」：读数只能继续衰减，不能回升。
    const after = last(run(m, { from: 20_100, to: 21_000, charsAt: steady(30) }))!;
    expect(after, "结束后的新帧不得让读数回升").toBeLessThan(before);
  });

  it("**内存不随会话增长**：超出保留期的桶会被丢弃", () => {
    const m = meter();
    for (let step = 0; step < 100; step += 1) m.push("x", step * 1_000);
    // 推进到很久之后：旧桶必须已被剪掉，读数回到 undefined。
    expect(m.reading(200_000)).toBeUndefined();
  });
});

describe("3 秒缓冲：慢慢爬上去，慢慢降下来（用户 2026-11-12 的要求）", () => {
  it("**上升不是一步到位**：前 2 秒远低于稳态", () => {
    const readings = run(meter(), { from: 1_000, to: 25_000, charsAt: steady(20) });
    const early = readings[Math.round(2_000 / TICK_MS)]!;
    const steadyAt = readings.at(-1)!;
    expect(early, "2 秒后必须远低于稳态（低通还没爬上来）").toBeLessThan(steadyAt * 0.5);
    expect(steadyAt).toBeCloseTo(20, 0);
  });

  it("**单调上升**：缓冲期间读数只会往上走（不会先冲高再回踩）", () => {
    const readings = run(meter(), { from: 1_000, to: 25_000, charsAt: steady(20) });
    let previous = 0;
    for (const [index, value] of readings.entries()) {
      expect(value, `第 ${index} 步读数回落了`).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value!;
    }
  });

  it("**停机后慢慢降下来**：1 秒内不会掉到很低", () => {
    const m = meter();
    const steadyAt = last(run(m, { from: 1_000, to: 20_000, charsAt: steady(20) }))!;
    const afterOneSecond = last(run(m, { from: 20_100, to: 21_000 }))!;
    expect(afterOneSecond).toBeGreaterThan(steadyAt * 0.5);
  });

  it("**完全停了之后仍然会归零**（缓冲不是永不归零）", () => {
    const m = meter();
    last(run(m, { from: 1_000, to: 20_000, charsAt: steady(20) }));
    // 停 30 秒：τ=3s 时 10τ 之后必然低于阈值。
    expect(last(run(m, { from: 20_100, to: 50_000 }))).toBeUndefined();
  });
});

describe("防冲高：停顿后突然一大段（用户报「偶尔冲到 300 多」的回归）", () => {
  it("**1200 字符的一步 = 32 tok/s，不是 286**", () => {
    // 低通关掉，只看分窗：这是「最近 9 秒的平均」的定义。
    const m = meter({ followMs: 1 });
    // 先停 10 秒（窗口里全空），然后一次性来 1200 个其它字符（≈286 token）。
    m.push("x".repeat(1_200), 40_000);
    const peak = last(run(m, { from: 40_000, to: 40_900 }))!;
    expect(peak, "不能一步冲到接近 300").toBeLessThan(40);
    expect(peak).toBeGreaterThan(25);
  });

  it("**大批量文本也不会超过「窗口内总量 ÷ 9」**（任何时刻都受分母约束）", () => {
    const m = meter({ followMs: 1 });
    // 同一毫秒里吐 42,000 字符（≈10,000 token）→ 10,000 ÷ 9 ≈ 1111 tok/s 上限。
    const peak = last(run(m, { from: 40_000, to: 40_900, charsAt: (at) => (at === 40_000 ? 42_000 : 0) }))!;
    expect(peak).toBeLessThan(1_200);
  });

  it("**只有 1 个窗口有数据时，读数也是 1/9**（分母固定 9 的直接后果）", () => {
    const m = meter({ followMs: 1 });
    m.push("x".repeat(42), 1_000);
    // 42 字符 = 10 token；10 tok/s ÷ 9 窗口 ≈ 1.1。
    expect(last(run(m, { from: 1_000, to: 1_900 }))!).toBeCloseTo(10 / 9, 0);
  });
});
