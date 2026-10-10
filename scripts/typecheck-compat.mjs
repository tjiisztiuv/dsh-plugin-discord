// Type-check src/dsh.ts against a sibling deepseek-harness checkout using that
// checkout's own TypeScript. Harness sources are compiled per package with
// their own options, so diagnostics inside the checkout are ignored; only
// diagnostics in this plugin fail the check.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(process.env.DSH_SOURCE ?? join(root, '..', 'deepseek-harness'))
const tsc = join(harness, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error(`typecheck:compat needs a built deepseek-harness checkout with node_modules at ${harness} (set DSH_SOURCE).`)
  process.exit(2)
}
const run = spawnSync(process.execPath, [tsc, '-p', join(root, 'compat', 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
const lines = `${run.stdout}${run.stderr}`.split('\n')
const ours = lines.filter(line => /^(compat|src)\//.test(line) || line.includes('dsh-plugin-discord/'))
if (ours.length > 0) {
  console.error(ours.join('\n'))
  process.exit(1)
}
console.log(`compat OK against ${harness}`)
