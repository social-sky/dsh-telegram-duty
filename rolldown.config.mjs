/**
 * Host-half bundle for a standalone fork clone.
 *
 * `npm run build` (tsc -b) only works inside the dsh monorepo: tsconfig.json
 * extends ../../../tsconfig.base.json and references ../../../vendor/*. A
 * standalone clone has none of those paths, so this config bundles
 * src/index.ts with rolldown instead and points the TS transform at
 * tsconfig.build.json (rolldown would otherwise try to load the broken
 * tsconfig.json and fail with TSCONFIG_ERROR).
 *
 * `@deepseek-ai/*`, node builtins and zod stay external: the host supplies
 * its own copies, and inlining them changes the bundle by ~5x.
 */
export default {
	input: 'src/index.ts',
	resolve: { tsconfigFilename: new URL('tsconfig.build.json', import.meta.url).pathname },
	external: (id) => id.startsWith('node:') || id.startsWith('@deepseek-ai/') || id === 'zod',
	output: { file: 'lib/index.js', format: 'esm' },
}
