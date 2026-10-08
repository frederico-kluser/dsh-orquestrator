import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SubagentRecord } from '../../src/shared.ts'
import type {
  CatalogGroupLike, SessionSummaryLike, SubagentCatalogEntryLike, SubagentCatalogLike,
} from '../../src/client/host-types.ts'
import {
  STALE_RUNNING_MS, describeRoute, entryLabel, markFor, ownValue, resolveRows, type ChildEntry, type DomRow,
} from '../../src/client/subagent-marks.ts'

/** A child entry of a catalog. */
const child = (id: string, label?: string, activity: 'running' | 'inactive' = 'inactive'): ChildEntry => ({
  kind: 'child', id, activity, hasChildren: false, mode: 'continuable', ...label === undefined ? {} : { label },
})
const diagnostic = (id: string): SubagentCatalogEntryLike => ({ kind: 'diagnostic', id, reason: 'corrupt' })
const catalog = (...entries: SubagentCatalogEntryLike[]): SubagentCatalogLike => ({ entries, state: 'ready' })
/** A DOM row: the aria-label DSH renders is `<label> <secondary...>`. */
const row = (level: number, label: string, disabled = false): DomRow => ({ level, label, disabled })
/** A first-level row that carries `aria-current`. */
const current = (label: string): DomRow => ({ level: 1, label, disabled: false, current: true })

/** The ids the resolved rows stand for, and the parent each belongs to, for compact assertions. */
function shape(resolved: ReturnType<typeof resolveRows>): (string | undefined)[] {
  return resolved.rows.map(hit => (hit === undefined ? undefined : `${hit.parentId}>${hit.entry.id}`))
}

describe('resolveRows', () => {
  it('finds the root by count and labels and resolves every first-level row to its entry in order', () => {
    const catalogs = { main: catalog(child('c1', 'Scout'), child('c2', 'Builder')) }
    const resolved = resolveRows([row(1, 'Scout continuable not running'), row(1, 'Builder continuable running')], catalogs, ['main'])
    assert.equal(resolved.root, 'main')
    assert.deepEqual(shape(resolved), ['main>c1', 'main>c2'])
    assert.equal(resolved.rows[0]?.entry, catalogs.main.entries[0])
  })

  it('matches on the id when the entry has no label, and on `label ?? id` only', () => {
    const catalogs = { main: catalog(child('c-1f3a'), child('c2', 'Builder')) }
    assert.deepEqual(shape(resolveRows([row(1, 'c-1f3a one-shot'), row(1, 'Builder')], catalogs, ['main'])), ['main>c-1f3a', 'main>c2'])
    // A label that does not start with the entry's label is a different row.
    assert.equal(resolveRows([row(1, 'x c-1f3a'), row(1, 'Builder')], catalogs, ['main']).root, undefined)
    assert.equal(entryLabel(child('c-1f3a')), 'c-1f3a')
    assert.equal(entryLabel(child('c2', 'Builder')), 'Builder')
  })

  it('needs the label to end where DSH puts a space: a longer label that merely starts the same is another row', () => {
    const catalogs = { main: catalog(child('c1', 'Review')) }
    // DSH's aria-label is `label mode · activity ...`: the label is followed by a space.
    assert.equal(resolveRows([row(1, 'Review one-shot · not running')], catalogs, ['main']).root, 'main')
    assert.equal(resolveRows([row(1, 'Review')], catalogs, ['main']).root, 'main', 'a label with nothing after it still fits')
    assert.equal(resolveRows([row(1, 'Reviewer one-shot · not running')], catalogs, ['main']).root, undefined)
    assert.equal(resolveRows([row(1, 'Review-all one-shot · not running')], catalogs, ['main']).root, undefined)
    // `Review` followed by a space is how a longer label starts too; what tells them apart is the title DSH puts next
    // (see the title test below), so with the title known the longer label is not captured.
    const context = { titleOf: (id: string) => (id === 'c1' ? 'Check the login flow' : undefined) }
    assert.equal(resolveRows([row(1, 'Review the auth module Plan it · one-shot · not running')], catalogs, ['main'], context).root, undefined)
    assert.equal(resolveRows([row(1, 'Review Check the login flow · one-shot · not running')], catalogs, ['main'], context).root, 'main')
  })

  it('never lets an entry with an empty label fit a row', () => {
    // DSH drops an empty label from the aria-label, so the row starts with the summary and there is nothing to compare.
    const catalogs = { main: catalog(child('c1', '')) }
    assert.deepEqual(resolveRows([row(1, 'one-shot · not running')], catalogs, ['main']), { root: undefined, rows: [undefined] })
    assert.deepEqual(resolveRows([row(1, '')], catalogs, ['main']), { root: undefined, rows: [undefined] })
    // An empty diagnostic id fits nothing either.
    assert.equal(resolveRows([row(1, ' x', true)], { main: catalog(diagnostic('')) }, ['main']).root, undefined)
    // And an empty label in a nested group leaves that row unresolved.
    const nested = { root: catalog(child('a', 'Alpha')), a: catalog(child('a1', '')) }
    assert.deepEqual(shape(resolveRows([row(1, 'Alpha'), row(2, 'one-shot')], nested, ['root'])), ['root>a', undefined])
  })

  it('requires the session title after the label when the session list has one (`label title · mode · activity`)', () => {
    const catalogs = { main: catalog(child('c1', 'Review')) }
    const titles: Record<string, string> = { c1: 'Check the auth module' }
    const context = { titleOf: (id: string) => titles[id] }
    // The real DSH row of a child with a title.
    assert.equal(resolveRows([row(1, 'Review Check the auth module · one-shot · not running 14.2K tok · 2s')], catalogs, ['main'], context).root, 'main')
    // Another conversation's child that happens to share the label: its title is another one.
    assert.equal(resolveRows([row(1, 'Review Plan the release · one-shot · not running')], catalogs, ['main'], context).root, undefined)
    // The label alone no longer fits once the title is known.
    assert.equal(resolveRows([row(1, 'Review one-shot · not running')], catalogs, ['main'], context).root, undefined)
    // Without a title in the list the row has none either.
    assert.equal(resolveRows([row(1, 'Review one-shot · not running')], catalogs, ['main'], { titleOf: () => undefined }).root, 'main')
    // An empty title is still a title: DSH joins it (and its separator) all the same.
    assert.equal(resolveRows([row(1, 'Review  · one-shot · not running')], catalogs, ['main'], { titleOf: () => '' }).root, 'main')
    // A title that is not text is no title.
    assert.equal(resolveRows([row(1, 'Review one-shot · not running')], catalogs, ['main'], { titleOf: () => 7 as never }).root, 'main')
  })

  it('needs the title to end where DSH puts its separator: a longer title that merely starts the same is another row', () => {
    const catalogs = { main: catalog(child('c1', 'Review')) }
    const context = { titleOf: () => 'Check' }
    assert.equal(resolveRows([row(1, 'Review Check · one-shot · not running')], catalogs, ['main'], context).root, 'main')
    assert.equal(resolveRows([row(1, 'Review Check the login flow · one-shot · not running')], catalogs, ['main'], context).root, undefined)
    assert.equal(resolveRows([row(1, 'Review Checkout · one-shot · not running')], catalogs, ['main'], context).root, undefined)
  })

  it('uses the title to tell two conversations whose subagents carry the same labels apart', () => {
    const catalogs = {
      a: catalog(child('a1', 'Explore codebase')),
      b: catalog(child('b1', 'Explore codebase')),
    }
    const titles: Record<string, string> = { a1: 'Find the router', b1: 'Find the store' }
    const context = { titleOf: (id: string) => titles[id] }
    const menuOfB = [row(1, 'Explore codebase Find the store · one-shot · not running')]
    assert.deepEqual(shape(resolveRows(menuOfB, catalogs, [['a', 'b']], context)), ['b>b1'])
    assert.deepEqual(shape(resolveRows([row(1, 'Explore codebase Find the router · one-shot · not running')], catalogs, [['a', 'b']], context)), ['a>a1'])
  })

  it('checks nested rows against their own titles as well', () => {
    const catalogs = { root: catalog(child('a', 'Alpha')), a: catalog(child('a1', 'Beta')) }
    const context = { titleOf: (id: string) => (id === 'a1' ? 'Second thing' : undefined) }
    assert.deepEqual(shape(resolveRows([row(1, 'Alpha one-shot'), row(2, 'Beta Second thing · one-shot')], catalogs, ['root'], context)), ['root>a', 'a>a1'])
    assert.deepEqual(shape(resolveRows([row(1, 'Alpha one-shot'), row(2, 'Beta Other · one-shot')], catalogs, ['root'], context)), ['root>a', undefined])
  })

  it('skips a candidate that has the same count but other labels, and takes the next one', () => {
    const catalogs = {
      other: catalog(child('o1', 'Alpha'), child('o2', 'Beta')),
      main: catalog(child('c1', 'Scout'), child('c2', 'Builder')),
    }
    const resolved = resolveRows([row(1, 'Scout'), row(1, 'Builder')], catalogs, ['other', 'main'])
    assert.equal(resolved.root, 'main')
    assert.deepEqual(shape(resolved), ['main>c1', 'main>c2'])
  })

  it('skips a candidate with another count', () => {
    const catalogs = {
      big: catalog(child('b1', 'Scout'), child('b2', 'Builder'), child('b3', 'Extra')),
      main: catalog(child('c1', 'Scout'), child('c2', 'Builder')),
    }
    assert.equal(resolveRows([row(1, 'Scout'), row(1, 'Builder')], catalogs, ['big', 'main']).root, 'main')
  })

  it('resolves nothing when two catalogs of the same tier fit: a guess would mark one conversation with the other\'s outcomes', () => {
    const catalogs = {
      a: catalog(child('a1', 'Scout'), child('a2', 'Builder')),
      b: catalog(child('b1', 'Scout'), child('b2', 'Builder')),
    }
    const rows = [row(1, 'Scout'), row(1, 'Builder')]
    // The order of the candidates no longer decides anything.
    assert.deepEqual(resolveRows(rows, catalogs, ['a', 'b']), { root: undefined, rows: [undefined, undefined] })
    assert.deepEqual(resolveRows(rows, catalogs, ['b', 'a']), { root: undefined, rows: [undefined, undefined] })
    assert.deepEqual(resolveRows(rows, catalogs, [['a', 'b']]), { root: undefined, rows: [undefined, undefined] })
    // The same session listed twice is not a tie with itself.
    assert.equal(resolveRows(rows, catalogs, ['a', 'a']).root, 'a')
  })

  it('does not fall through to a later tier once an earlier one is ambiguous', () => {
    const catalogs = {
      a: catalog(child('a1', 'Scout')),
      b: catalog(child('b1', 'Scout')),
      c: catalog(child('c1', 'Scout')),
    }
    assert.deepEqual(resolveRows([row(1, 'Scout')], catalogs, [['a', 'b'], ['c']]), { root: undefined, rows: [undefined] })
  })

  it('lets an earlier tier win over a later one that fits as well, and falls back to the later tier when the earlier has no fit', () => {
    const catalogs = {
      page: catalog(child('p1', 'Scout')),
      other: catalog(child('o1', 'Scout')),
      far: catalog(child('f1', 'Scout')),
    }
    const rows = [row(1, 'Scout')]
    assert.equal(resolveRows(rows, catalogs, [['page'], ['other', 'far']]).root, 'page')
    assert.equal(resolveRows(rows, catalogs, [['ghost'], ['other']]).root, 'other')
    assert.equal(resolveRows(rows, catalogs, [[], ['far']]).root, 'far')
    // Two fits in the later tier are ambiguous too.
    assert.equal(resolveRows(rows, catalogs, [['ghost'], ['other', 'far']]).root, undefined)
  })

  it('takes a flat list of candidates as one tier', () => {
    const catalogs = { a: catalog(child('a1', 'Scout')), b: catalog(child('b1', 'Builder')) }
    assert.equal(resolveRows([row(1, 'Builder')], catalogs, ['a', 'b']).root, 'b')
    assert.equal(resolveRows([row(1, 'Builder')], catalogs, [['a', 'b']]).root, 'b')
  })

  it('breaks a tie with the row DSH marks aria-current, when exactly one fitting catalog has that row on the page', () => {
    // A switcher menu rooted at P lists C (the page) among its siblings; C's own catalog has a look-alike child list.
    const catalogs = {
      P: catalog(child('x', 'Fix the bug'), child('C', 'Fix the bug')),
      C: catalog(child('g1', 'Fix the bug'), child('g2', 'Fix the bug')),
    }
    const rows = [row(1, 'Fix the bug one-shot'), current('Fix the bug continuable')]
    const onPage = ['C', 'P']
    // Both fit by label; only P has the marked row on a session of the page.
    assert.deepEqual(shape(resolveRows(rows, catalogs, [['C', 'P']], { onPage })), ['P>x', 'P>C'])
    assert.deepEqual(shape(resolveRows(rows, catalogs, [['P', 'C']], { onPage })), ['P>x', 'P>C'])
    // Without the page to compare with, or without a marked row, the tie stands.
    assert.equal(resolveRows(rows, catalogs, [['C', 'P']]).root, undefined)
    assert.equal(resolveRows([row(1, 'Fix the bug one-shot'), row(1, 'Fix the bug continuable')], catalogs, [['C', 'P']], { onPage }).root, undefined)
    // When neither marked row is on the page, or both are, it stands as well.
    assert.equal(resolveRows(rows, catalogs, [['C', 'P']], { onPage: ['elsewhere'] }).root, undefined)
    assert.equal(resolveRows(rows, catalogs, [['C', 'P']], { onPage: ['C', 'P', 'g2'] }).root, undefined)
  })

  it('does not use aria-current to reject the only catalog that fits (the page may not be among the sessions the controller knows)', () => {
    const catalogs = { P: catalog(child('x', 'One'), child('C', 'Two')) }
    const rows = [row(1, 'One'), current('Two')]
    assert.equal(resolveRows(rows, catalogs, [['P']], { onPage: [] }).root, 'P')
    assert.equal(resolveRows(rows, catalogs, [['P']], { onPage: ['somebody-else'] }).root, 'P')
  })

  it('resolves duplicate labels by order', () => {
    const catalogs = { main: catalog(child('first', 'worker'), child('second', 'worker'), child('third', 'worker')) }
    const resolved = resolveRows([row(1, 'worker continuable'), row(1, 'worker continuable'), row(1, 'worker one-shot')], catalogs, ['main'])
    assert.deepEqual(shape(resolved), ['main>first', 'main>second', 'main>third'])
  })

  it('resolves nested expanded groups against the catalog of the row that owns them', () => {
    const catalogs = {
      root: catalog(child('a', 'Alpha'), child('b', 'Beta'), child('c', 'Gamma')),
      a: catalog(child('a1', 'Alpha one'), child('a2', 'Alpha two')),
      a2: catalog(child('a2x', 'Deep')),
      b: catalog(child('b1', 'Beta one')),
    }
    const resolved = resolveRows([
      row(1, 'Alpha'), row(2, 'Alpha one'), row(2, 'Alpha two'), row(3, 'Deep'),
      row(1, 'Beta'), row(2, 'Beta one'),
      row(1, 'Gamma'),
    ], catalogs, ['root'])
    assert.deepEqual(shape(resolved), [
      'root>a', 'a>a1', 'a>a2', 'a2>a2x',
      'root>b', 'b>b1',
      'root>c',
    ])
  })

  it('counts the index per group, so a second group starts again at its own first entry', () => {
    const catalogs = {
      root: catalog(child('a', 'Same'), child('b', 'Same')),
      a: catalog(child('a1', 'Row'), child('a2', 'Row')),
      b: catalog(child('b1', 'Row'), child('b2', 'Row')),
    }
    const resolved = resolveRows([row(1, 'Same'), row(2, 'Row'), row(2, 'Row'), row(1, 'Same'), row(2, 'Row'), row(2, 'Row')], catalogs, ['root'])
    assert.deepEqual(shape(resolved), ['root>a', 'a>a1', 'a>a2', 'root>b', 'b>b1', 'b>b2'])
  })

  it('leaves a loading placeholder unresolved without losing the position of the rows around it', () => {
    const catalogs = { root: catalog(child('a', 'Alpha'), child('b', 'Beta')) }
    // `a` is expanded but its own catalog has not arrived: DSH renders disabled placeholders one level down.
    const resolved = resolveRows([
      row(1, 'Alpha'), row(2, 'Loading subagents', true), row(2, 'Loading subagents', true),
      row(1, 'Beta'),
    ], catalogs, ['root'])
    assert.deepEqual(shape(resolved), ['root>a', undefined, undefined, 'root>b'])
  })

  it('does not resolve a disabled row even when its label matches, nor anything nested under an unresolved row', () => {
    const catalogs = {
      root: catalog(child('a', 'Alpha'), child('b', 'Beta')),
      a: catalog(child('a1', 'Alpha one')),
      a1: catalog(child('a1x', 'Deeper')),
    }
    const resolved = resolveRows([
      row(1, 'Alpha'), row(2, 'Alpha one', true), row(3, 'Deeper'),
      row(1, 'Beta'),
    ], catalogs, ['root'])
    assert.deepEqual(shape(resolved), ['root>a', undefined, undefined, 'root>b'])
  })

  it('keeps a diagnostic row in the count (it matches on its id), leaves it unresolved and keeps the position', () => {
    const catalogs = { root: catalog(child('a', 'Alpha'), diagnostic('broken-1'), child('c', 'Gamma')) }
    const resolved = resolveRows([row(1, 'Alpha'), row(1, 'broken-1 corrupted session record', true), row(1, 'Gamma')], catalogs, ['root'])
    assert.equal(resolved.root, 'root')
    assert.deepEqual(shape(resolved), ['root>a', undefined, 'root>c'])
  })

  it('does not resolve a nested diagnostic row, and the next sibling still lines up', () => {
    const catalogs = {
      root: catalog(child('a', 'Alpha')),
      a: catalog(diagnostic('gone'), child('a2', 'Second')),
    }
    const resolved = resolveRows([row(1, 'Alpha'), row(2, 'gone unavailable', true), row(2, 'Second')], catalogs, ['root'])
    assert.deepEqual(shape(resolved), ['root>a', undefined, 'a>a2'])
  })

  it('finds no root, and resolves nothing, when the counts differ', () => {
    const catalogs = { main: catalog(child('c1', 'Scout'), child('c2', 'Builder')) }
    const resolved = resolveRows([row(1, 'Scout'), row(1, 'Builder'), row(1, 'Extra')], catalogs, ['main'])
    assert.deepEqual(resolved, { root: undefined, rows: [undefined, undefined, undefined] })
    assert.equal(resolveRows([row(1, 'Scout')], catalogs, ['main']).root, undefined)
  })

  it('finds no root when one label does not match', () => {
    const catalogs = { main: catalog(child('c1', 'Scout'), child('c2', 'Builder')) }
    assert.deepEqual(resolveRows([row(1, 'Scout'), row(1, 'Somebody else')], catalogs, ['main']), { root: undefined, rows: [undefined, undefined] })
  })

  it('finds no root when the first-level rows are loading placeholders (the catalog has no entries yet)', () => {
    const catalogs = { main: catalog() }
    assert.deepEqual(resolveRows([row(1, 'Loading subagents', true)], catalogs, ['main']), { root: undefined, rows: [undefined] })
  })

  it('finds no root for a menu without rows', () => {
    assert.deepEqual(resolveRows([], { main: catalog() }, ['main']), { root: undefined, rows: [] })
  })

  it('ignores candidates that have no catalog, or only an inherited one', () => {
    const catalogs = { main: catalog(child('c1', 'Scout')) }
    const resolved = resolveRows([row(1, 'Scout')], catalogs, ['ghost', 'constructor', '__proto__', 'toString', 'main'])
    assert.equal(resolved.root, 'main')
  })

  it('resolves nothing nested when the owner of a group has no catalog', () => {
    const catalogs = { root: catalog(child('a', 'Alpha')) }
    assert.deepEqual(shape(resolveRows([row(1, 'Alpha'), row(2, 'Whatever')], catalogs, ['root'])), ['root>a', undefined])
  })

  it('resolves nothing nested when the label of a nested row does not match its entry', () => {
    const catalogs = {
      root: catalog(child('a', 'Alpha')),
      a: catalog(child('a1', 'Alpha one')),
      a1: catalog(child('x', 'Deep')),
    }
    const resolved = resolveRows([row(1, 'Alpha'), row(2, 'Not the same'), row(3, 'Deep')], catalogs, ['root'])
    assert.deepEqual(shape(resolved), ['root>a', undefined, undefined])
  })

  it('resolves nothing for a nested row beyond the catalog (more rows than entries)', () => {
    const catalogs = { root: catalog(child('a', 'Alpha')), a: catalog(child('a1', 'One')) }
    assert.deepEqual(shape(resolveRows([row(1, 'Alpha'), row(2, 'One'), row(2, 'Two')], catalogs, ['root'])), ['root>a', 'a>a1', undefined])
  })

  it('treats a level that skips as unresolved, and a row after it goes back to its own group', () => {
    const catalogs = {
      root: catalog(child('a', 'Alpha'), child('b', 'Beta')),
      a: catalog(child('a1', 'One')),
    }
    // A level-3 row right under a level-1 row has no owner at level 2.
    const resolved = resolveRows([row(1, 'Alpha'), row(3, 'One'), row(2, 'One'), row(1, 'Beta')], catalogs, ['root'])
    assert.deepEqual(shape(resolved), ['root>a', undefined, 'a>a1', 'root>b'])
  })

  it('treats a NaN, missing or non-positive level as the first level', () => {
    const catalogs = { main: catalog(child('c1', 'One'), child('c2', 'Two'), child('c3', 'Three'), child('c4', 'Four')) }
    const resolved = resolveRows([row(Number.NaN, 'One'), row(0, 'Two'), row(-3, 'Three'), row(Number.POSITIVE_INFINITY, 'Four')], catalogs, ['main'])
    assert.deepEqual(shape(resolved), ['main>c1', 'main>c2', 'main>c3', 'main>c4'])
    // `Number(null)`, what a missing aria-level reads as, is 0.
    assert.equal(resolveRows([{ level: Number(null), label: 'One', disabled: false }], { main: catalog(child('c1', 'One')) }, ['main']).root, 'main')
  })

  it('does not hang or fail on absurd nesting (a level of 2^32 or more would be an invalid array length)', () => {
    const catalogs = { main: catalog(child('c1', 'One')) }
    for (const absurd of [65, 1_000_000_000, 2 ** 32, 2 ** 32 + 5, 1e15, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
      const resolved = resolveRows([row(1, 'One'), row(absurd, 'deep'), row(2, 'two')], catalogs, ['main'])
      assert.deepEqual(shape(resolved), ['main>c1', undefined, undefined], String(absurd))
    }
    // The deepest level that is honoured still resolves.
    const chain: Record<string, SubagentCatalogLike> = { n0: catalog(child('n1', 'L1')) }
    const rows: DomRow[] = [row(1, 'L1')]
    for (let level = 2; level <= 64; level += 1) {
      chain[`n${String(level - 1)}`] = catalog(child(`n${String(level)}`, `L${String(level)}`))
      rows.push(row(level, `L${String(level)}`))
    }
    const deep = resolveRows(rows, chain, ['n0'])
    assert.equal(deep.rows.filter(hit => hit !== undefined).length, 64)
  })

  it('answers with no root for odd input instead of throwing', () => {
    const none = { root: undefined, rows: [undefined] }
    assert.deepEqual(resolveRows([row(1, 'x')], {}, []), none)
    assert.deepEqual(resolveRows([row(1, 'x')], undefined as never, ['a']), none)
    assert.deepEqual(resolveRows([row(1, 'x')], { a: undefined } as never, ['a']), none)
    assert.deepEqual(resolveRows([row(1, 'x')], { a: { entries: 'nope' } } as never, ['a']), none)
    assert.deepEqual(resolveRows([row(1, 'x')], { a: { entries: [null] } } as never, ['a']), none)
    assert.deepEqual(resolveRows([row(1, 'x')], { a: catalog(child('c', 'x')) }, [[7, null, undefined]] as never), none)
    assert.deepEqual(resolveRows([row(1, 'x')], { a: { entries: [child('c', 'x'), null] } } as never, ['a']), none)
    // A null entry in a nested group leaves that row unresolved instead of throwing.
    assert.deepEqual(shape(resolveRows([row(1, 'x'), row(2, 'y')], { a: catalog(child('c', 'x')), c: { entries: [null] } } as never, ['a'])), ['a>c', undefined])
    assert.deepEqual(resolveRows([row(1, 'x')], { a: catalog(child('c', 'x')) }, undefined as never), none)
    assert.deepEqual(resolveRows(undefined as never, { a: catalog() }, ['a']), { root: undefined, rows: [] })
  })
})

describe('ownValue', () => {
  it('reads own entries only', () => {
    const table = { a: 1 }
    assert.equal(ownValue(table, 'a'), 1)
    assert.equal(ownValue(table, 'b'), undefined)
    assert.equal(ownValue(table, 'constructor'), undefined)
    assert.equal(ownValue(table, '__proto__'), undefined)
    assert.equal(ownValue(undefined, 'a'), undefined)
  })
})

const NOW = 1_800_000_000_000

/** A ledger record. */
const record = (state: SubagentRecord['state'], patch: Partial<SubagentRecord> = {}): SubagentRecord => ({
  id: 'c1', parentId: 'main', backend: 'spawn', route: null, state, stopReason: null, startedAt: NOW - 120_000, endedAt: null, ...patch,
})
const summary = (lastUsed: { provider: string; model: string; reasoningEffort?: string } | null): SessionSummaryLike => ({
  id: 'c1', running: false, projectionValues: { modelSelection: { lastUsed } },
})

describe('markFor', () => {
  it('draws running for a live child the ledger does not know', () => {
    assert.deepEqual(markFor(child('c1', 'x', 'running'), undefined, undefined, NOW), { state: 'running', stopReason: null, route: null })
  })

  it('draws unknown for a child that is not live and has no record', () => {
    assert.deepEqual(markFor(child('c1'), undefined, undefined, NOW), { state: 'unknown', stopReason: null, route: null })
  })

  it('lets a terminal ledger record decide, with its stop reason', () => {
    assert.deepEqual(markFor(child('c1'), record('done', { stopReason: 'completed', endedAt: NOW - 1 }), undefined, NOW), { state: 'done', stopReason: 'completed', route: null })
    assert.deepEqual(markFor(child('c1'), record('failed', { stopReason: 'max-tokens' }), undefined, NOW), { state: 'failed', stopReason: 'max-tokens', route: null })
    assert.deepEqual(markFor(child('c1'), record('stopped', { stopReason: 'aborted' }), undefined, NOW), { state: 'stopped', stopReason: 'aborted', route: null })
  })

  it('lets a terminal record win over a catalog that still says running (the catalog lags)', () => {
    assert.equal(markFor(child('c1', 'x', 'running'), record('done', { stopReason: 'completed' }), undefined, NOW).state, 'done')
    assert.equal(markFor(child('c1', 'x', 'running'), record('failed', { stopReason: 'error' }), undefined, NOW).state, 'failed')
    assert.equal(markFor(child('c1', 'x', 'running'), record('stopped', { stopReason: 'aborted' }), undefined, NOW).state, 'stopped')
  })

  it('draws running for a running record while the catalog says the child is live, however old the record', () => {
    const old = record('running', { startedAt: NOW - 10 * 60_000 })
    assert.deepEqual(markFor(child('c1', 'x', 'running'), old, undefined, NOW), { state: 'running', stopReason: null, route: null })
  })

  it('keeps a young running record running even though the catalog already says the child is not live', () => {
    assert.equal(markFor(child('c1'), record('running', { startedAt: NOW - 1_000 }), undefined, NOW).state, 'running')
    assert.equal(markFor(child('c1'), record('running', { startedAt: NOW - (STALE_RUNNING_MS - 1) }), undefined, NOW).state, 'running')
  })

  it('draws unknown once a running record is 5 s old and the catalog says the child is not live (a missed end event)', () => {
    assert.equal(STALE_RUNNING_MS, 5_000)
    assert.equal(markFor(child('c1'), record('running', { startedAt: NOW - STALE_RUNNING_MS }), undefined, NOW).state, 'unknown')
    assert.equal(markFor(child('c1'), record('running', { startedAt: NOW - 20_000 }), undefined, NOW).state, 'unknown')
    assert.equal(markFor(child('c1'), record('running', { startedAt: NOW - 3_600_000 }), undefined, NOW).state, 'unknown')
  })

  it('counts a record that starts in the future (a skewed clock) as young', () => {
    assert.equal(markFor(child('c1'), record('running', { startedAt: NOW + 60_000 }), undefined, NOW).state, 'running')
  })

  it('takes the route DSH saw the child use first, and the ledger\'s only when there is none (a continuable child may have outgrown the route it started on)', () => {
    const ledger = { provider: 'openrouter', model: 'google/gemini-3.8-flash', reasoningEffort: 'high' }
    const mark = markFor(child('c1'), record('done', { route: ledger }), summary({ provider: 'azure', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'low' }), NOW)
    assert.deepEqual(mark.route, { provider: 'azure', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'low' })
    // No request made yet: the session list has nothing, and the ledger's route stands in.
    assert.deepEqual(markFor(child('c1'), record('running', { route: ledger, startedAt: NOW }), summary(null), NOW).route, ledger)
    assert.deepEqual(markFor(child('c1'), record('running', { route: ledger, startedAt: NOW }), undefined, NOW).route, ledger)
    // A malformed route in the list is no route: the ledger's stands in for that too.
    assert.deepEqual(markFor(child('c1'), record('done', { route: ledger }), summary({ provider: '', model: 'm' }), NOW).route, ledger)
  })

  it('falls back to the route the session list saw the child use, with its effort', () => {
    assert.deepEqual(
      markFor(child('c1'), record('done'), summary({ provider: 'azure', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' }), NOW).route,
      { provider: 'azure', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' },
    )
    assert.deepEqual(
      markFor(child('c1'), undefined, summary({ provider: 'azure', model: 'DeepSeek-V4.1-Flash' }), NOW).route,
      { provider: 'azure', model: 'DeepSeek-V4.1-Flash' },
    )
  })

  it('has no route when neither source knows one', () => {
    assert.equal(markFor(child('c1'), record('done'), undefined, NOW).route, null)
    assert.equal(markFor(child('c1'), record('done'), summary(null), NOW).route, null)
    assert.equal(markFor(child('c1'), record('done'), { id: 'c1', running: false }, NOW).route, null)
    assert.equal(markFor(child('c1'), record('done'), { id: 'c1', running: false, projectionValues: {} }, NOW).route, null)
  })

  it('ignores a malformed route in the session list', () => {
    assert.equal(markFor(child('c1'), undefined, summary({ provider: '', model: 'm' }), NOW).route, null)
    assert.equal(markFor(child('c1'), undefined, summary({ provider: 'p', model: '' }), NOW).route, null)
    assert.equal(markFor(child('c1'), undefined, summary({ provider: 1, model: 'm' } as never), NOW).route, null)
    // An empty effort is no effort.
    assert.deepEqual(markFor(child('c1'), undefined, summary({ provider: 'p', model: 'm', reasoningEffort: '' }), NOW).route, { provider: 'p', model: 'm' })
  })

  it('still gives the route of a row whose state is unknown or running', () => {
    const lastUsed = { provider: 'p', model: 'm' }
    assert.deepEqual(markFor(child('c1'), undefined, summary(lastUsed), NOW), { state: 'unknown', stopReason: null, route: lastUsed })
    assert.deepEqual(markFor(child('c1', 'x', 'running'), undefined, summary(lastUsed), NOW), { state: 'running', stopReason: null, route: lastUsed })
  })
})

const groups: readonly CatalogGroupLike[] = [{
  id: 'openrouter',
  name: 'OpenRouter',
  models: [
    {
      id: 'google/gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    },
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  ],
}]

describe('describeRoute', () => {
  it('says nothing without a route', () => {
    assert.equal(describeRoute(groups, null), undefined)
  })

  it('names the model and the effort as the catalog does', () => {
    assert.deepEqual(describeRoute(groups, { provider: 'openrouter', model: 'google/gemini-3.8-flash', reasoningEffort: 'high' }), { model: 'Gemini 3.8 Flash', effort: 'High' })
  })

  it('has no effort when the route carries none (or an empty one)', () => {
    assert.deepEqual(describeRoute(groups, { provider: 'openrouter', model: 'google/gemini-3.8-flash' }), { model: 'Gemini 3.8 Flash', effort: null })
    assert.deepEqual(describeRoute(groups, { provider: 'openrouter', model: 'google/gemini-3.8-flash', reasoningEffort: '' }), { model: 'Gemini 3.8 Flash', effort: null })
  })

  it('falls back to the raw id for a model the catalog lacks, and to the raw effort for a level the ladder lacks', () => {
    assert.deepEqual(describeRoute(groups, { provider: 'openrouter', model: 'acme/mystery-9000' }), { model: 'acme/mystery-9000', effort: null })
    assert.deepEqual(describeRoute(groups, { provider: 'openrouter', model: 'google/gemini-3.8-flash', reasoningEffort: 'ultra' }), { model: 'Gemini 3.8 Flash', effort: 'ultra' })
    // A model with no ladder at all keeps the raw effort too.
    assert.deepEqual(describeRoute(groups, { provider: 'openrouter', model: 'moonshotai/kimi-k3', reasoningEffort: 'max' }), { model: 'Kimi K3', effort: 'max' })
  })

  it('shows raw ids while the catalog is empty (not loaded yet)', () => {
    assert.deepEqual(describeRoute([], { provider: 'openrouter', model: 'google/gemini-3.8-flash', reasoningEffort: 'high' }), { model: 'google/gemini-3.8-flash', effort: 'high' })
  })

  it('does not take a model from another provider that happens to share the id', () => {
    assert.deepEqual(describeRoute(groups, { provider: 'azure', model: 'google/gemini-3.8-flash', reasoningEffort: 'high' }), { model: 'google/gemini-3.8-flash', effort: 'high' })
  })
})
