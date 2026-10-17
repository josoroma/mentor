import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const config = defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'] },
})
export { config as default }
