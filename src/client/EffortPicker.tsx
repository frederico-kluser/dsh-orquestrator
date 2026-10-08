/**
 * EffortPicker: the dialog's reasoning-effort select. It is a plain native
 * `<select>` (DSH has no Select primitive; its own settings cards use a native
 * one too), styled with the host's tokens, one row per reasoning level the
 * effective model offers plus a first neutral row that leaves the level to the
 * model itself. The rows keep the canonical order (`rankOf`), so the ladder
 * reads low to high whatever order the catalog lists it in.
 *
 * The select never invents a level: when the stored level is not among the rows
 * (the catalog has not answered yet, or the model no longer offers it) it is
 * shown as its own row, so a stored choice is never silently dropped from the
 * screen. {@link highestEffortOf} answers the "auto-max" rule: the level a
 * model change selects.
 * @module dsh-orquestrator/client/EffortPicker
 */

import { useMemo, type JSX } from 'react'
import { rankOf } from '../models.ts'
import type { CatalogReasoningLike } from './host-types.ts'

/** Value of the neutral row: the model's own default, which the host resolves. */
export const NEUTRAL_EFFORT = ''

/** One row of the ladder. */
export interface EffortOption {
  readonly id: string
  readonly name: string
}

/** Props of the select. */
export interface EffortPickerProps {
  /** DOM id of the select (its visible label points at it). */
  readonly id: string
  /** Visible label above the select. */
  readonly label: string
  /** The levels the effective model offers, in any order. */
  readonly efforts: readonly EffortOption[]
  /** The chosen level, or null for the neutral row. */
  readonly value: string | null
  /** Text of the first, neutral row, for example "Model default". */
  readonly neutralLabel: string
  readonly disabled?: boolean | undefined
  readonly onChange: (level: string | null) => void
}

/**
 * Order a ladder low to high.
 * @param efforts - the levels as the catalog lists them.
 * @returns the same levels by reasoning rank; ids DSH does not define keep their place at the end.
 */
function byRank(efforts: readonly EffortOption[]): EffortOption[] {
  return [...efforts].sort((left, right) => {
    const a = rankOf(left.id)
    const b = rankOf(right.id)
    if (a < 0 && b < 0) return 0
    if (a < 0) return 1
    if (b < 0) return -1
    return a - b
  })
}

/**
 * The highest level of a ladder, by reasoning rank: what a model change picks.
 * @param ladder - the model's reasoning ladder, or undefined when it has none.
 * @returns the top level's id, or null when there is no level to pick.
 */
export function highestEffortOf(ladder: CatalogReasoningLike | undefined): string | null {
  let best: string | null = null
  let bestRank = Number.NEGATIVE_INFINITY
  for (const effort of ladder?.efforts ?? []) {
    const rank = rankOf(effort.id)
    if (best === null || rank > bestRank) {
      best = effort.id
      bestRank = rank
    }
  }
  return best
}

/**
 * The select.
 * @param props - see {@link EffortPickerProps}.
 * @returns the labeled native select.
 */
export function EffortPicker(props: EffortPickerProps): JSX.Element {
  const { id, label, efforts, value, neutralLabel, disabled, onChange } = props
  const rows = useMemo(() => byRank(efforts), [efforts])
  // A stored level the ladder does not list (the catalog has not answered yet) gets a row of its own:
  // dropping it from the screen would hide a choice the confirm still writes back.
  const kept = value !== null && !rows.some(row => row.id === value) ? value : null

  return (
    <div className="dsh-orq-field">
      <label className="dsh-orq-field-label" htmlFor={id}>{label}</label>
      <select
        id={id}
        className="dsh-orq-select"
        value={value ?? NEUTRAL_EFFORT}
        disabled={disabled === true}
        onChange={(event) => { onChange(event.target.value === NEUTRAL_EFFORT ? null : event.target.value) }}
      >
        <option value={NEUTRAL_EFFORT}>{neutralLabel}</option>
        {kept === null ? undefined : <option value={kept}>{kept}</option>}
        {rows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select>
    </div>
  )
}
