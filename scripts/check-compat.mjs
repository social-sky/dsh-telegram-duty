#!/usr/bin/env node
/**
 * Fail-closed compatibility guard: src/ must not reference runtime symbols
 * removed from '@deepseek-ai/dsh-settings' in dsh 0.1.2-rc.1. A missing named
 * export kills the whole loader entry at import time — on the harness LXC
 * (2026-09-07) oomol, dshmarket and this plugin all tripped exactly this, and
 * systemd restarted dsh 192 times before a circuit breaker was added.
 *
 * Usage: node scripts/check-compat.mjs [source-dir, default: src]
 * Exit 0 = clean; exit 1 = at least one removed symbol referenced.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(repoRoot, process.argv[2] ?? 'src')

/**
 * Symbols removed from @deepseek-ai/dsh-settings in dsh 0.1.2-rc.1.
 * Keep this list in sync when dsh publishes another breaking release.
 * NOTE: plain-substring matching is intentionally coarse (fail closed);
 * mentioning these names in comments trips it too — rewrite the comment.
 */
const BANNED = ['settingsNamespace', 'installSettingsSection']

const hits = []
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p)
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      const text = readFileSync(p, 'utf8')
      for (const symbol of BANNED) {
        if (text.includes(symbol)) {
          hits.push(`${p}: references "${symbol}" (removed from @deepseek-ai/dsh-settings in dsh 0.1.2-rc.1)`)
        }
      }
    }
  }
}

walk(target)
if (hits.length > 0) {
  console.error('compat check FAILED — loader-entry crash risk:')
  for (const line of hits) console.error('  ' + line)
  console.error('Namespaces are plain strings now (validated against /^[a-z][a-z0-9-]*$/ by SettingsProvider.register).')
  process.exit(1)
}
console.log(`compat check OK: no removed dsh-settings runtime symbols under ${target}`)