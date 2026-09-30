/**
 * ModelPicker: a provider-grouped model select built on the DSH `Menu`
 * primitive, so it looks and behaves like the composer's own model menu
 * (same rows, checkmark, keyboard walk, portal above the modal layer).
 * It only ever offers routes the model catalog advertises.
 * @module dsh-orquestrator/client/ModelPicker
 */

import { useCallback, useMemo, useState, type JSX } from 'react'
import { IconChevronDownOutline14, IconLoadingOutline16, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { routeKey, type ModelRoute } from '../shared.ts'
import type { CatalogGroupLike } from './host-types.ts'

/** Id of the "inherit" row (the value null). */
const INHERIT_ID = '__inherit__'

/** Props of the picker. */
export interface ModelPickerProps {
  /** DOM id of the trigger (its visible label points at it). */
  readonly id: string
  /** Visible label above the trigger. */
  readonly label: string
  readonly groups: readonly CatalogGroupLike[]
  /** The picked route; null means "inherit" when {@link inheritLabel} is set, else "nothing picked". */
  readonly value: ModelRoute | null
  readonly onChange: (route: ModelRoute | null) => void
  /** When set, the first row keeps the stock route (value null) under this label. */
  readonly inheritLabel?: string | undefined
  readonly placeholder: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly loadingLabel: string
  readonly errorLabel: string
  readonly retryLabel: string
  readonly onRetry: () => void
  readonly disabled?: boolean | undefined
  /** Reports menu open/close so the dialog can keep Escape for the menu first. */
  readonly onMenuOpenChange?: ((open: boolean) => void) | undefined
}

/**
 * The select.
 * @param props - see {@link ModelPickerProps}.
 * @returns the labeled trigger and, while open, the grouped menu.
 */
export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const { id, label, groups, value, onChange, inheritLabel, placeholder, status } = props
  const [open, setOpenState] = useState(false)
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    props.onMenuOpenChange?.(next)
  }, [props])

  const { items, routes } = useMemo(() => {
    const entries: MenuEntry[] = []
    const lookup = new Map<string, ModelRoute>()
    if (inheritLabel !== undefined) {
      entries.push({ id: INHERIT_ID, label: inheritLabel })
      if (groups.length > 0) entries.push({ type: 'separator', id: 'sep:inherit' })
    }
    let index = 0
    groups.forEach((group, groupIndex) => {
      if (groupIndex > 0) entries.push({ type: 'separator', id: `sep:${group.id}` })
      entries.push({ type: 'label', id: `label:${group.id}`, text: group.name })
      for (const model of group.models) {
        const rowId = `m${String(index)}`
        index += 1
        lookup.set(rowId, { provider: group.id, model: model.id })
        entries.push({ id: rowId, label: model.name })
      }
    })
    return { items: entries, routes: lookup }
  }, [groups, inheritLabel])

  const selectedId = useMemo(() => {
    if (value === null) return inheritLabel === undefined ? undefined : INHERIT_ID
    for (const [rowId, route] of routes) if (routeKey(route) === routeKey(value)) return rowId
    return undefined
  }, [routes, value, inheritLabel])

  const picked = useMemo(() => {
    if (value === null) return undefined
    const group = groups.find(candidate => candidate.id === value.provider)
    return { name: group?.models.find(model => model.id === value.model)?.name ?? value.model, provider: group?.name ?? value.provider }
  }, [groups, value])

  if (status === 'loading') {
    return (
      <div className="dsh-orq-field">
        <span className="dsh-orq-field-label">{label}</span>
        <div className="dsh-orq-status" role="status">
          <span className="dsh-orq-spin"><IconLoadingOutline16 size={16} /></span>
          <span>{props.loadingLabel}</span>
        </div>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="dsh-orq-field">
        <span className="dsh-orq-field-label">{label}</span>
        <div className="dsh-orq-status dsh-orq-status-error" role="alert">
          <span>{props.errorLabel}</span>
          <button type="button" className="dsh-orq-link" onClick={props.onRetry}>{props.retryLabel}</button>
        </div>
      </div>
    )
  }

  // The visible label AND the current value form the accessible name; a bare
  // <label for> would name the button by the label alone and hide the value
  // from screen readers.
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
        {picked !== undefined
          ? (
              <>
                <span className="dsh-orq-picker-name">{picked.name}</span>
                <span className="dsh-orq-picker-provider">{picked.provider}</span>
              </>
            )
          : value === null && inheritLabel !== undefined
            ? <span className="dsh-orq-picker-name">{inheritLabel}</span>
            : <span className="dsh-orq-picker-name dsh-orq-picker-placeholder">{placeholder}</span>}
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
        selectedId={selectedId}
        onSelect={(rowId) => {
          setOpen(false)
          onChange(rowId === INHERIT_ID ? null : routes.get(rowId) ?? null)
        }}
        onClose={() => { setOpen(false) }}
        portal
        compact
        className="dsh-orq-menu-root"
      />
    </div>
  )
}
