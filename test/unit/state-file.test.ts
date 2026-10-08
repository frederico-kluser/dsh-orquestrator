import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MAX_STATE_FILE_BYTES, readStateFile, writeStateFile } from '../../src/state-file.ts'
import { holdFifoOpen, makeFifo } from '../hostile-fs.ts'

const scratch = mkdtempSync(join(tmpdir(), 'orq-statefile-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })

/** A directory of its own for one test. */
function fresh(name: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('readStateFile', () => {
  it('bounds what it reads at 16 MiB by default', () => {
    assert.equal(MAX_STATE_FILE_BYTES, 16 * 1024 * 1024)
  })

  it('reads the text of a regular file, empty or not', () => {
    const dir = fresh('read-text')
    writeFileSync(join(dir, 'full'), 'héllo\n{"a":1}')
    writeFileSync(join(dir, 'empty'), '')
    assert.deepEqual(readStateFile(join(dir, 'full')), { kind: 'text', text: 'héllo\n{"a":1}' })
    assert.deepEqual(readStateFile(join(dir, 'empty')), { kind: 'text', text: '' })
  })

  it('says a file is missing, and that a path under something that is not a directory cannot be read', () => {
    const dir = fresh('read-missing')
    assert.deepEqual(readStateFile(join(dir, 'nothing')), { kind: 'missing' })
    writeFileSync(join(dir, 'plain'), 'x')
    const blocked = readStateFile(join(dir, 'plain', 'inside'))
    assert.equal(blocked.kind, 'failed')
    assert.equal(((blocked as { error: NodeJS.ErrnoException }).error).code, 'ENOTDIR')
  })

  it('accepts a file of exactly the largest size and refuses one a byte over, without reading it', () => {
    const dir = fresh('read-bound')
    writeFileSync(join(dir, 'exact'), '0123456789')
    writeFileSync(join(dir, 'over'), '0123456789X')
    assert.deepEqual(readStateFile(join(dir, 'exact'), 10), { kind: 'text', text: '0123456789' })
    assert.deepEqual(readStateFile(join(dir, 'over'), 10), { kind: 'refused', reason: 'it is larger than 10 bytes' })
  })

  it('refuses a symbolic link, even one to a regular file and even a dangling one', () => {
    const dir = fresh('read-link')
    writeFileSync(join(dir, 'real'), 'secret')
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling'))
    assert.deepEqual(readStateFile(join(dir, 'link')), { kind: 'refused', reason: 'it is a symbolic link' })
    assert.deepEqual(readStateFile(join(dir, 'dangling')), { kind: 'refused', reason: 'it is a symbolic link' })
  })

  it('follows a symbolic link in a directory of the path: only the file itself must not be one', () => {
    const dir = fresh('read-dirlink')
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'state.json'), 'inside')
    symlinkSync(join(dir, 'real'), join(dir, 'alias'))
    assert.deepEqual(readStateFile(join(dir, 'alias', 'state.json')), { kind: 'text', text: 'inside' })
  })

  it('refuses a directory', () => {
    const dir = fresh('read-dir')
    mkdirSync(join(dir, 'a-directory'))
    assert.deepEqual(readStateFile(join(dir, 'a-directory')), { kind: 'refused', reason: 'it is not a regular file' })
  })

  it('refuses a FIFO without waiting for a writer', async (t) => {
    const dir = fresh('read-fifo')
    const fifo = join(dir, 'pipe')
    if (!makeFifo(fifo)) {
      t.skip('mkfifo is not available here')
      return
    }
    const holder = await holdFifoOpen(fifo)
    try {
      const started = Date.now()
      assert.deepEqual(readStateFile(fifo), { kind: 'refused', reason: 'it is not a regular file' })
      assert.ok(Date.now() - started < 2000)
    } finally {
      holder.kill()
    }
  })
})

describe('readStateFile and a pipe nobody writes to', () => {
  it('answers at once instead of waiting for a writer (read in a process of its own, so that a regression is a failure and not a hang)', (t) => {
    const dir = fresh('read-fifo-alone')
    const fifo = join(dir, 'pipe')
    if (!makeFifo(fifo)) {
      t.skip('mkfifo is not available here')
      return
    }
    const module = fileURLToPath(new URL('../../src/state-file.ts', import.meta.url))
    const script = `import { readStateFile } from ${JSON.stringify(module)}\nconsole.log(JSON.stringify(readStateFile(${JSON.stringify(fifo)})))`
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.error, undefined, 'the child did not have to be killed: it did not wait for a writer')
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), { kind: 'refused', reason: 'it is not a regular file' })
  })
})

describe('writeStateFile', () => {
  it('creates the directory owner-only and the file owner-only, and leaves no temp file', () => {
    const dir = join(scratch, 'write-new', 'inner')
    const file = join(dir, 'state.json')
    writeStateFile(file, 'one\n')
    assert.equal(readFileSync(file, 'utf8'), 'one\n')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(dir), ['state.json'])
  })

  it('replaces what is there, atomically', () => {
    const dir = fresh('write-replace')
    const file = join(dir, 'state.json')
    writeStateFile(file, 'one\n')
    writeStateFile(file, 'two\n')
    assert.equal(readFileSync(file, 'utf8'), 'two\n')
    assert.deepEqual(readdirSync(dir), ['state.json'])
  })

  it('removes a stale temp file of an earlier run instead of appending to it or failing on it', () => {
    const dir = fresh('write-stale')
    const file = join(dir, 'state.json')
    writeFileSync(`${file}.${String(process.pid)}.tmp`, 'left over by a crash, much longer than the new content')
    writeStateFile(file, 'new\n')
    assert.equal(readFileSync(file, 'utf8'), 'new\n')
    assert.deepEqual(readdirSync(dir), ['state.json'])
  })

  it('does not follow a symbolic link planted at the temp name: the link goes, its target stays', () => {
    const dir = fresh('write-planted')
    const file = join(dir, 'state.json')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'PRECIOUS\n', { mode: 0o644 })
    symlinkSync(victim, `${file}.${String(process.pid)}.tmp`)
    writeStateFile(file, 'new\n')
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n')
    assert.equal(statSync(victim).mode & 0o777, 0o644)
    assert.equal(readFileSync(file, 'utf8'), 'new\n')
    assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'victim.txt'])
  })

  it('does not create the target of a dangling link planted at the temp name', () => {
    const dir = fresh('write-dangling')
    const file = join(dir, 'state.json')
    symlinkSync(join(dir, 'nowhere'), `${file}.${String(process.pid)}.tmp`)
    writeStateFile(file, 'new\n')
    assert.equal(existsSync(join(dir, 'nowhere')), false)
  })

  it('replaces a symbolic link at the target path without writing through it', () => {
    const dir = fresh('write-target-link')
    const file = join(dir, 'state.json')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'PRECIOUS\n')
    symlinkSync(victim, file)
    writeStateFile(file, 'new\n')
    assert.equal(lstatSync(file).isFile(), true)
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n')
  })

  it('replaces a FIFO at the target path, and does not open it', async (t) => {
    const dir = fresh('write-target-fifo')
    const file = join(dir, 'state.json')
    if (!makeFifo(file)) {
      t.skip('mkfifo is not available here')
      return
    }
    const holder = await holdFifoOpen(file)
    try {
      writeStateFile(file, 'new\n')
      assert.equal(lstatSync(file).isFile(), true)
      assert.equal(readFileSync(file, 'utf8'), 'new\n')
    } finally {
      holder.kill()
    }
  })

  it('throws, and leaves no temp file, when the rename cannot happen (a directory at the target)', () => {
    const dir = fresh('write-target-dir')
    const file = join(dir, 'state.json')
    mkdirSync(file)
    assert.throws(() => { writeStateFile(file, 'new\n') }, /EISDIR|ENOTEMPTY|EEXIST/)
    assert.deepEqual(readdirSync(dir), ['state.json'])
  })

  it('throws, and writes nothing, when something it cannot remove is at the temp name', () => {
    const dir = fresh('write-temp-dir')
    const file = join(dir, 'state.json')
    mkdirSync(`${file}.${String(process.pid)}.tmp`)
    assert.throws(() => { writeStateFile(file, 'new\n') })
    assert.equal(existsSync(file), false)
  })

  it('throws when the directory cannot be made (a file where it should be)', () => {
    const dir = fresh('write-no-dir')
    writeFileSync(join(dir, 'plain'), 'x')
    assert.throws(() => { writeStateFile(join(dir, 'plain', 'inside', 'state.json'), 'new\n') }, /ENOTDIR|EEXIST/)
  })

  it('gives the file mode 0600 whatever the umask took away from the creation mode', () => {
    const dir = fresh('write-umask')
    const file = join(dir, 'state.json')
    const previous = process.umask(0o277)
    try {
      writeStateFile(file, 'new\n')
    } finally {
      process.umask(previous)
    }
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})
