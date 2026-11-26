/**
 * **口径说明**的单测（2026-11-13）。
 *
 * 说明文字是**纯内容**，所以这里断言的是内容本身（而不是渲染出来的元素个数）：
 * 五个列名都解释到了、常驻提示比原来那一长行短得多、两个页签都有话说。
 */
import { describe, expect, it } from "vitest";

import { HELP_LABEL, HELP_SECTIONS } from "../../src/client/help";

/** 说明的全部文字（用来做包含性断言）。 */
const ALL_TEXT = HELP_SECTIONS.flatMap((section) => [section.title, ...section.lines]).join("\n");

describe("口径说明：内容", () => {
  it("**五个列名都解释到了**（读取 / 输入 / 输出 / 命中 / 速度）", () => {
    for (const word of ["读取", "输入", "输出", "命中", "速度"]) {
      // 「输入」出现在「缓存读取」之后，所以单独查「未缓存输入」更精确。
      expect(ALL_TEXT, `说明里缺少「${word}」`).toContain(word);
    }
  });

  it("两个页签都有对应小节（`?` 不偏袒某一页）", () => {
    expect(HELP_SECTIONS.map((section) => section.title)).toEqual(["实时速度", "每步平均"]);
  });

  it("说明里写清了命中率的分母（这正是用户之前搞错的地方）", () => {
    expect(ALL_TEXT).toContain("读取 + 输入 + 写入");
  });

  it("说明里写清了速度不含等工具的时间", () => {
    expect(ALL_TEXT).toContain("不含等工具");
  });

  it("每条都不长（一屏说明不该变成一篇文章）", () => {
    for (const line of HELP_SECTIONS.flatMap((section) => section.lines)) {
      expect(line.length, `这条太长：${line}`).toBeLessThanOrEqual(40);
    }
  });
});

describe("口径说明：按钮", () => {
  it("`?` 按钮有无障碍文案", () => {
    expect(HELP_LABEL).toBe("口径说明");
  });

  it("**说明之外不再有常驻提示**（用户 2026-11-13：「这句话不用加」）", () => {
    // 导出里只有说明本身与按钮文案；曾经那句 STEPS_HINT 已删除。
    // 这条断言防的是「又有人好心加一句常驻说明」。
    expect(Object.keys({ HELP_SECTIONS, HELP_LABEL })).toEqual(["HELP_SECTIONS", "HELP_LABEL"]);
  });
});
