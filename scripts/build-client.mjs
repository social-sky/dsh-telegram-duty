#!/usr/bin/env node
/**
 * Standalone client-half build (rc.1-native). The upstream tsdown client face
 * expects the dsh monorepo tree (`../../client/tsdown.client.ts`), which a
 * standalone fork clone does not have. This script produces the same
 * `window.__ModuleLoader__.load({id, factory})` face with esbuild: a CJS body
 * wrapped by the loader banner/footer. `react` (JSX runtime) and any
 * `@deepseek-ai/*` specifiers stay external — the sources only keep type-only
 * imports of the latter, so no such require is emitted.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const banner = [
	'window.__ModuleLoader__.load({',
	`\tid: ${JSON.stringify(pkg.name)},`,
	'\tfactory: (require) => {',
	'\t\tvar module = { exports: {} };',
	'\t\tvar exports = module.exports;',
	'\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
].join('\n')
const footer = '\t\treturn module.exports;\n\t}\n});'

execFileSync('npm', [
	'exec', '--yes', '--package=esbuild@0.24.2', '--',
	'esbuild', 'src/client/index.ts',
	'--bundle',
	'--format=cjs',
	'--platform=browser',
	'--jsx=automatic',
	'--external:react',
	'--external:react/*',
	'--external:@deepseek-ai/*',
	`--banner:js=${banner}`,
	`--footer:js=${footer}`,
	'--sourcemap',
	'--outfile=lib/client.js',
], { stdio: 'inherit' })
