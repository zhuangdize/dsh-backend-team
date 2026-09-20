import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
  },
})
