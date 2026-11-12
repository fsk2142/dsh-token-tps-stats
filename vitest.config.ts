import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `react` 由宿主运行时提供，本包不安装它。测试用替身顶上，
      // 逼着状态机留在可单测的纯模块里（与 dsh-llm-account 同一纪律）。
      react: fileURLToPath(new URL("./tests/support/react-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
