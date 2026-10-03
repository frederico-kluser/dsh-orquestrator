/**
 * What the worker changed, measured by the orchestrator instead of reported by
 * the worker. Before and after a delegation the working tree is fingerprinted
 * with git (path to content hash for every dirty or untracked file); the
 * difference is the worker's change set. That set decides whether the reviewer
 * can work from the workspace alone (clean context) and flags the test, runner
 * and CI files a worker could have weakened to fake a pass.
 *
 * Everything here fails soft: no git, no repository, a timeout or a huge tree
 * yields "unknown" and the pipeline falls back to the worker's report.
 * @module dsh-orquestrator/workspace
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Most dirty or untracked paths fingerprinted; beyond this the snapshot is marked truncated. */
const MAX_ENTRIES = 2000

/** Largest file hashed by content; bigger files are fingerprinted by size. */
const MAX_HASH_BYTES = 4 * 1024 * 1024

/** Longest a git command may run. */
const GIT_TIMEOUT_MS = 8000

/** Most paths a packet lists by name. */
const MAX_LISTED = 60

/** The I/O the snapshot needs, injectable for tests. */
export interface WorkspaceIo {
  /** Run `git` in `cwd` and return stdout; reject on failure. */
  git(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string>
  /** Read a file; reject with an ENOENT-coded error when it does not exist. */
  readFile(path: string): Promise<Uint8Array>
  /** Size in bytes, or undefined when the file does not exist. */
  size(path: string): Promise<number | undefined>
}

/** The production I/O: the git binary on PATH and the real file system. */
export const defaultIo: WorkspaceIo = {
  git(args, cwd, signal) {
    return new Promise((resolve, reject) => {
      execFile('git', [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        ...signal === undefined ? {} : { signal },
      }, (error, stdout) => {
        if (error === null) resolve(stdout)
        else reject(error)
      })
    })
  },
  readFile: path => readFile(path),
  async size(path) {
    try {
      return (await stat(path)).size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
}

/** A fingerprint of the working tree at one moment. */
export type WorkspaceSnapshot =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, string>; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse `git status --porcelain=v1 -z` output into dirty paths.
 * @param raw - NUL-separated status records.
 * @returns paths relative to the repository root (renames report the new path).
 */
export function parseStatus(raw: string): string[] {
  const parts = raw.split('\0')
  const paths: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (record === undefined || record.length < 4) continue
    const status = record.slice(0, 2)
    paths.push(record.slice(3))
    // A rename or copy carries its source path as the next record.
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return paths
}

/**
 * Fingerprint the working tree.
 * @param cwd - the workspace directory, or undefined when the session has none.
 * @param io - git and file-system access.
 * @param signal - cancellation.
 * @returns the snapshot, or `ok: false` with the reason when it cannot be taken.
 */
export async function snapshotWorkspace(cwd: string | undefined, io: WorkspaceIo = defaultIo, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  if (cwd === undefined || cwd === '') return { ok: false, reason: 'the session has no working directory' }
  try {
    const root = (await io.git(['rev-parse', '--show-toplevel'], cwd, signal)).trim()
    if (root === '') return { ok: false, reason: 'not a git repository' }
    const status = await io.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, signal)
    const paths = parseStatus(status)
    const entries = new Map<string, string>()
    for (const path of paths.slice(0, MAX_ENTRIES)) {
      const absolute = join(root, path)
      const size = await io.size(absolute)
      if (size === undefined) entries.set(path, 'deleted')
      else if (size > MAX_HASH_BYTES) entries.set(path, `size:${String(size)}`)
      else entries.set(path, createHash('sha1').update(await io.readFile(absolute)).digest('hex'))
    }
    return { ok: true, entries, truncated: paths.length > MAX_ENTRIES }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message.split('\n')[0] ?? 'git failed' : String(error) }
  }
}

/** The kind of file a worker could weaken to make a check pass. */
export type SensitiveKind = 'test' | 'runner-config' | 'ci'

/** Test directories and files. */
const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress)\//,
  /\.(test|spec)\.[a-z0-9]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(go|py|rs)$/,
]

/** Runner and build configuration that can change what a check does. */
const RUNNER_PATTERNS: readonly RegExp[] = [
  /(^|\/)(conftest\.py|pytest\.ini|tox\.ini|noxfile\.py|setup\.cfg)$/,
  /(^|\/)(jest|vitest|playwright|karma|cypress)\.config\.[a-z]+$/,
  /(^|\/)vitest\.workspace\.[a-z]+$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(package\.json|pyproject\.toml|makefile|justfile|taskfile\.ya?ml)$/,
]

/** CI definitions. */
const CI_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)(azure-pipelines\.ya?ml|jenkinsfile)$/,
  /(^|\/)\.circleci\/config\.ya?ml$/,
]

/**
 * Turn a simple glob (`*` within a segment, `**` across segments) into a matcher.
 * @param glob - the pattern from the `sensitivePaths` config.
 * @returns a case-insensitive regular expression.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`(^|/)${escaped}$`, 'i')
}

/**
 * Classify one changed path.
 * @param path - path relative to the repository root.
 * @param extra - operator-configured extra patterns (counted as runner configuration).
 * @returns the kind of sensitive file, or undefined for ordinary files.
 */
export function classifyPath(path: string, extra: readonly RegExp[] = []): SensitiveKind | undefined {
  const lowered = path.toLowerCase()
  if (CI_PATTERNS.some(pattern => pattern.test(lowered))) return 'ci'
  if (TEST_PATTERNS.some(pattern => pattern.test(lowered))) return 'test'
  if (RUNNER_PATTERNS.some(pattern => pattern.test(lowered)) || extra.some(pattern => pattern.test(path))) return 'runner-config'
  return undefined
}

/** What changed between two snapshots. */
export interface WorkspaceFacts {
  /** Paths whose content differs between the two moments, sorted. */
  readonly changed: readonly string[]
  /** The changed paths that are test, runner or CI files. */
  readonly flagged: readonly { readonly path: string; readonly kind: SensitiveKind }[]
  /** Whether either snapshot hit the entry cap, so the list may be incomplete. */
  readonly truncated: boolean
}

/**
 * Compare two snapshots.
 * @param before - taken before the worker started.
 * @param after - taken after it finished.
 * @param extra - extra sensitive-path patterns.
 * @returns the facts, or undefined when either snapshot is unavailable.
 */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, extra: readonly RegExp[] = []): WorkspaceFacts | undefined {
  if (!before.ok || !after.ok) return undefined
  const changed: string[] = []
  for (const path of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    if (before.entries.get(path) !== after.entries.get(path)) changed.push(path)
  }
  changed.sort()
  const flagged = changed.flatMap((path) => {
    const kind = classifyPath(path, extra)
    return kind === undefined ? [] : [{ path, kind }]
  })
  return { changed, flagged, truncated: before.truncated || after.truncated }
}

/**
 * Render the facts for the reviewer's packet.
 * @param facts - the measured change set.
 * @returns plain text lines, bounded in length.
 */
export function describeFacts(facts: WorkspaceFacts): string {
  const lines: string[] = []
  if (facts.changed.length === 0) {
    lines.push('The working tree did not change while the worker ran (no file was added, modified or deleted).')
  } else {
    const listed = facts.changed.slice(0, MAX_LISTED)
    const more = facts.changed.length - listed.length
    lines.push(`Files changed while the worker ran (${String(facts.changed.length)}): ${listed.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`)
  }
  if (facts.flagged.length > 0) {
    const listed = facts.flagged.slice(0, MAX_LISTED).map(entry => `${entry.path} (${entry.kind})`)
    lines.push(`Test, runner or CI files among them. Inspect each of these diffs for deleted or skipped tests, weakened assertions, hooks that rewrite results and forced exit codes: ${listed.join(', ')}`)
  }
  if (facts.truncated) lines.push('The list may be incomplete: the working tree has too many changed files to fingerprint.')
  return lines.join('\n')
}
