/**
 * Ambient declarations for the DSH browser modules this plugin `require()`s at
 * factory time. The real packages live in the DeepSeek Harness workspace and
 * are answered by the shell's frozen platform table at runtime
 * (`PLATFORM_MODULES` in dsh-client-web); this file mirrors ONLY the slice the
 * plugin uses, so the repository type-checks without a DSH checkout.
 *
 * Source of truth: packages/client/ui-primitives/src (Modal.tsx, Button.tsx,
 * Switch.tsx, Checkbox.tsx, Menu.tsx, icons/props.ts) at DSH 0.1.6-alpha.2.
 * If a prop below drifts, `scripts/e2e/` fails first on a real DSH.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react'

  /** Shared props of every icon component. */
  export interface IconProps {
    /** Square edge in px. */
    size?: number | undefined
    /** Extra class for layout placement; color rides currentColor. */
    className?: string | undefined
  }

  /** An icon component from the shared set. */
  export type IconComponent = (props: IconProps) => JSX.Element

  export const IconAgentPresetOutline16: IconComponent
  export const IconCheckOutline16: IconComponent
  export const IconDataOutline16: IconComponent
  export const IconChevronDownOutline14: IconComponent
  export const IconLoadingOutline16: IconComponent
  export const IconWarningOutline16: IconComponent

  /** Props of the centered, body-portaled modal. */
  export type ModalProps = {
    open: boolean
    /** Escape or mask click; the owner must ignore it while a menu inside the dialog is open. */
    onClose: () => void
    /** Dialog heading (also the aria-label). */
    title: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
  } & (
    | { headless: true; closeLabel?: never }
    | { headless?: false; closeLabel: string }
  )
  export function Modal(props: ModalProps): JSX.Element | null

  /** Visual family of a button. */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element

  /** Two-state toggle; `label` is the required accessible name. */
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string | undefined
    className?: string | undefined
  }): JSX.Element

  /** Labeled native checkbox. */
  export function Checkbox(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string | undefined
    className?: string | undefined
  }): JSX.Element

  /** Selectable menu row. */
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
  }
  /** Hairline between groups. */
  export interface MenuSeparator {
    type: 'separator'
    id: string
  }
  /** Non-interactive heading row. */
  export interface MenuLabel {
    type: 'label'
    id: string
    text: string
  }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  /** Anchored dropdown menu (portal mode layers above modal overlays). */
  export function Menu(props: {
    open: boolean
    autoFocus?: boolean
    anchor: ReactNode
    items: readonly MenuEntry[]
    selectedId?: string | undefined
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    dense?: boolean
    compact?: boolean
    selection?: 'check' | 'fill'
    className?: string | undefined
  }): JSX.Element
}
