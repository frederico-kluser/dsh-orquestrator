/**
 * Build for `dsh-orquestrator`.
 *
 * Two artifacts, both COMMITTED under `lib/` so that `dsh plugin add` from a
 * git URL works without running any build script on the installing machine:
 *
 * - `lib/index.js`   — the host half: one ESM bundle for Node. It imports no
 *   bare specifier at runtime (only `node:` builtins); every DSH service is
 *   reached through the Cordis context, so the file runs from any location.
 * - `lib/client.cjs` — the browser half: one CJS factory artifact that opens
 *   `window.__ModuleLoader__.load({ id, factory })`, the shape the DSH client
 *   module table expects (hand-rolled mirror of the official
 *   `packages/client/tsdown.client.ts` client-face contract, which only
 *   resolves packages inside the DSH workspace). Specifiers in
 *   {@link MODULE_TABLE_EXTERNALS} stay `require()` calls answered by the
 *   shell's frozen platform table (`PLATFORM_MODULES`); everything else inlines.
 */
import type { UserConfig } from 'tsdown'

/** This package's loader-table id (the package name). */
const PLUGIN_ID = 'dsh-orquestrator'

/** The shell's frozen platform module table (`PLATFORM_MODULES` in dsh-client-web). */
const MODULE_TABLE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

export default [
  {
    name: `${PLUGIN_ID}/node`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: false,
    sourcemap: false,
    clean: false,
    // Pin the .js extension: package.json main/exports name lib/index.js.
    outExtensions: () => ({ js: '.js' }),
    deps: {
      // Nothing is a production dependency: everything inlines except builtins.
      alwaysBundle: (specifier: string) => !specifier.startsWith('node:'),
    },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: false,
    clean: false,
    outputOptions: {
      entryFileNames: 'client.cjs',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    deps: {
      neverBundle: [...MODULE_TABLE_EXTERNALS],
      alwaysBundle: (specifier: string) => !MODULE_TABLE_EXTERNALS.includes(specifier as never),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',
      'import.meta.env': '{"MODE":"production"}',
      'process.env': '{}',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['production', 'browser', 'import', 'module', 'default'],
      },
    },
  },
] satisfies UserConfig[]
