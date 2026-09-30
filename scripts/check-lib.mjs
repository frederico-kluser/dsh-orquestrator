#!/usr/bin/env node
/**
 * Guard for the committed build artifacts: `lib/index.js` and `lib/client.cjs`
 * are what `dsh plugin add` installs from git, so they must equal a fresh
 * build of the sources. Rebuilds and fails when the working tree differs.
 */
import { execFileSync } from 'node:child_process'

execFileSync('pnpm', ['exec', 'tsdown', '--config', 'tsdown.config.ts'], { stdio: 'inherit' })
try {
  execFileSync('git', ['diff', '--exit-code', '--stat', '--', 'lib'], { stdio: 'inherit' })
} catch {
  console.error('\ncheck-lib: lib/ is out of date. Run `pnpm run build` and commit the result.')
  process.exit(1)
}
console.log('check-lib: lib/ matches a fresh build')
