import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { trapTarget } from '../../src/client/focus-trap.ts'

const els = ['close', 'picker', 'cancel', 'confirm']

describe('trapTarget', () => {
  it('lets the browser move focus while it stays inside the dialog', () => {
    assert.equal(trapTarget(els, 'picker', false), undefined)
    assert.equal(trapTarget(els, 'picker', true), undefined)
    assert.equal(trapTarget(els, 'close', false), undefined)
    assert.equal(trapTarget(els, 'confirm', true), undefined)
  })

  it('wraps at both ends', () => {
    assert.equal(trapTarget(els, 'confirm', false), 'close')
    assert.equal(trapTarget(els, 'close', true), 'confirm')
  })

  it('pulls focus back in when it is outside or on nothing', () => {
    assert.equal(trapTarget(els, 'composer', false), 'close')
    assert.equal(trapTarget(els, 'composer', true), 'confirm')
    assert.equal(trapTarget(els, null, false), 'close')
    assert.equal(trapTarget(els, null, true), 'confirm')
  })

  it('does nothing when the dialog has no focusable element', () => {
    assert.equal(trapTarget([], null, false), undefined)
    assert.equal(trapTarget([], 'x', true), undefined)
  })

  it('handles a single focusable element', () => {
    assert.equal(trapTarget(['only'], 'only', false), 'only')
    assert.equal(trapTarget(['only'], 'only', true), 'only')
  })
})
