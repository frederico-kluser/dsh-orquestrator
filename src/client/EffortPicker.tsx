/**
 * EffortPicker: a small select of one route's reasoning levels, built on the
 * DSH `Menu` primitive like the model picker. Its first row is the
 * recommended level (value null), which the host resolves from the model's
 * profile; the other rows are the levels the model offers.
 * @module dsh-orquestrator/client/EffortPicker
 */

import { useCallback, useMemo, useState, type JSX } from 'react'
import { IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogReasoningLike } from './host-types.ts'

/** Id of the "recommended" row (the value null). */
const RECOMMENDED_ID = '__recommended__'

/** Props of the picker. */
export interface EffortPickerProps {
  /** DOM id of the trigger. */
  readonly id: string
  /** Visible label above the trigger. */
  readonly label: string
  readonly ladder: CatalogReasoningLike
  /** The explicit level, or null for the recommended one. */
  readonly value: string | null
  readonly onChange: (level: string | null) => void
  /** The text of the recommended row, for example "Recommended: Medium". */
  readonly recommendedLabel: string
  /** Suffix marking the level the route uses on its own, for example "(model default)". */
  readonly defaultSuffix: string
  readonly disabled?: boolean | undefined
  /** Reports menu open/close so the dialog can keep Escape for the menu first. */
  readonly onMenuOpenChange?: ((open: boolean) => void) | undefined
}

/**
 * The select.
 * @param props - see {@link EffortPickerProps}.
 * @returns the labeled trigger and, while open, the menu.
 */
export function EffortPicker(props: EffortPickerProps): JSX.Element {
  const { id, label, ladder, value, onChange, recommendedLabel, defaultSuffix } = props
  const [open, setOpenState] = useState(false)
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    props.onMenuOpenChange?.(next)
  }, [props])

  const items = useMemo<MenuEntry[]>(() => [
    { id: RECOMMENDED_ID, label: recommendedLabel },
    { type: 'separator', id: 'sep:levels' },
    ...ladder.efforts.map(effort => ({ id: effort.id, label: effort.id === ladder.defaultEffort ? `${effort.name} ${defaultSuffix}` : effort.name })),
  ], [ladder, recommendedLabel, defaultSuffix])

  const known = value !== null && ladder.efforts.some(effort => effort.id === value)
  const shown = known ? ladder.efforts.find(effort => effort.id === value)?.name ?? value : recommendedLabel
  const labelId = `${id}-label`
  const valueId = `${id}-value`

  const trigger = (
    <button
      id={id}
      type="button"
      className="dsh-orq-picker"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-labelledby={`${labelId} ${valueId}`}
      disabled={props.disabled === true}
      onClick={() => { setOpen(!open) }}
    >
      <span className="dsh-orq-picker-value" id={valueId}>
        <span className="dsh-orq-picker-name">{shown}</span>
      </span>
      <span className="dsh-orq-picker-chevron"><IconChevronDownOutline14 size={14} /></span>
    </button>
  )

  return (
    <div className="dsh-orq-field">
      <label className="dsh-orq-field-label" id={labelId} htmlFor={id}>{label}</label>
      <Menu
        open={open}
        anchor={trigger}
        items={items}
        selectedId={known ? value : RECOMMENDED_ID}
        onSelect={(rowId) => {
          setOpen(false)
          onChange(rowId === RECOMMENDED_ID ? null : rowId)
        }}
        onClose={() => { setOpen(false) }}
        portal
        compact
        className="dsh-orq-menu-root"
      />
    </div>
  )
}
