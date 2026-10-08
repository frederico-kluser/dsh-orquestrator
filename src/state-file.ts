/**
 * Reading and writing the plugin's small JSON state files (`sessions.json`, `subagents.json`) in a directory it does
 * not fully control: anything that can write the state directory (a subagent under a full-access preset, another
 * user's process) must not be able to make the plugin follow a link, overwrite another file, hang on a pipe or load
 * a gigabyte of JSON.
 *
 * Reading opens the path without following a symbolic link and without waiting for a writer, then checks what was
 * opened (a regular file, not larger than a bound) before reading a byte. Writing goes through a temp file that this
 * process creates itself, exclusively, and renames over the target, so a write never ends up in a file the process
 * did not create. The callers decide what to say about a refusal and what to do with a corrupt file.
 * @module dsh-orquestrator/state-file
 */

import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Largest state file the plugin reads, in bytes. A real one holds at most a few thousand small records (under a megabyte). */
export const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024

/** What reading a state file found. */
export type StateFileRead =
  /** There is no file. */
  | { readonly kind: 'missing' }
  /** The file's contents. */
  | { readonly kind: 'text'; readonly text: string }
  /** Something is at the path that must not be read (a link, a pipe, a directory, an oversized file); `reason` says what. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The path could not be read (permissions, a parent that is not a directory, ...). */
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Read a state file without trusting what is at the path.
 * @param file - the state file path.
 * @param maxBytes - the largest size accepted.
 * @returns the text, or why there is none. Never throws, and never blocks on a pipe.
 */
export function readStateFile(file: string, maxBytes: number = MAX_STATE_FILE_BYTES): StateFileRead {
  let fd: number
  try {
    // O_NOFOLLOW: a link at the path is refused, never followed. O_NONBLOCK: opening a FIFO for reading must not wait
    // for a writer that may never come. Both are checked on the opened descriptor below, so there is no window
    // between looking at the path and reading it.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'refused', reason: 'it is a symbolic link' }
    return { kind: 'failed', error }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { kind: 'refused', reason: 'it is not a regular file' }
    if (stat.size > maxBytes) return { kind: 'refused', reason: `it is larger than ${String(maxBytes)} bytes` }
    // One byte more than the size: a file that grows while it is read fills the buffer and is refused, not read on.
    const buffer = Buffer.allocUnsafe(stat.size + 1)
    let length = 0
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
      if (length === buffer.length) return { kind: 'refused', reason: 'it changed while it was read' }
    }
    return { kind: 'text', text: buffer.toString('utf8', 0, length) }
  } catch (error: unknown) {
    return { kind: 'failed', error }
  } finally {
    closeSync(fd)
  }
}

/**
 * Write a state file atomically and owner-only: the directory is created with mode 0700, the content goes to a temp
 * file named after the process (two DSH processes sharing a directory never interleave writes), and a rename puts it
 * in place. Whatever is at the temp name is removed first, and the temp file is created exclusively (`wx`), so a
 * symbolic link planted there is never followed: it is the link that goes, not its target.
 * @param file - the state file path.
 * @param body - the complete new content.
 * @throws whatever the file system refuses with; the temp file is not left behind.
 */
export function writeStateFile(file: string, body: string): void {
  const tmp = `${file}.${String(process.pid)}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    rmSync(tmp, { force: true })
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      // The umask may have taken bits off the creation mode. Through the descriptor, so no path is followed.
      fchmodSync(fd, 0o600)
      writeFileSync(fd, body)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (error: unknown) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Nothing left to clean, or nothing that can be: the error below is the one to report.
    }
    throw error
  }
}
