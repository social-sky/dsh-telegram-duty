import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/*.spec.ts'],
  },
  resolve: {
    tsconfigFilename: 'tsconfig.check.json',
  },
  oxc: {
    tsconfig: './tsconfig.check.json',
  },
})
