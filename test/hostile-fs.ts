import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

/**
 * Make a FIFO (a named pipe) at `path`, the way a hostile state directory could hold one.
 * @param path - where to make it; its directory must exist.
 * @returns false when this machine cannot (no `mkfifo`), so the caller can skip its test.
 */
export function makeFifo(path: string): boolean {
  const made = spawnSync('mkfifo', [path], { stdio: 'ignore' })
  return made.status === 0
}

/**
 * Keep a FIFO open for reading and writing for a few seconds, and resolve once it is open. Reading a FIFO that nobody
 * holds open waits for ever, which is what the code under test must never do; with this holder, a regression that
 * reads it anyway waits a few seconds and then fails an assertion, instead of hanging the whole suite.
 * @param path - the FIFO.
 * @returns the holder, to be killed when the test is over.
 */
export function holdFifoOpen(path: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const holder = spawn('sh', ['-c', 'exec 3<>"$1"; echo open; sleep 4', 'sh', path], { stdio: ['ignore', 'pipe', 'ignore'] })
    holder.once('error', reject)
    holder.stdout?.once('data', () => { resolve(holder) })
  })
}
