import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { en, pt, zh } from '../../src/client/locales.ts'
import { MODEL_PROFILES } from '../../src/models.ts'

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()

describe('dictionaries', () => {
  it('have the same keys in every language', () => {
    assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort())
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  it('use the same {placeholders} in every language', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.deepEqual(placeholders(pt[key]), placeholders(en[key]), `pt ${key}`)
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `zh ${key}`)
    }
  })

  it('explain every note a model profile can raise', () => {
    const raised = new Set(MODEL_PROFILES.flatMap(profile => [...profile.notes.worker ?? [], ...profile.notes.reviewer ?? []]))
    assert.ok(raised.size >= 6)
    for (const note of raised) assert.ok(`note.${note}` in en, `note.${note} is missing from the dictionaries`)
  })

  it('have no empty strings and no em dashes', () => {
    for (const [language, dictionary] of Object.entries({ en, pt, zh })) {
      for (const [key, value] of Object.entries(dictionary)) {
        assert.notEqual(value.trim(), '', `${language} ${key} is empty`)
        assert.equal(value.includes('\u2014'), false, `${language} ${key} has an em dash`)
      }
    }
  })
})
