import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Each test spins up real git repos in tmp dirs — keep them serial-ish but
    // isolated. Default pool is fine; just give git room to breathe.
    testTimeout: 20_000,
  },
});
