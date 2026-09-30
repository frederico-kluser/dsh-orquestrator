/**
 * Keyboard focus containment for the dialog.
 *
 * DSH's `Modal` marks itself `role="dialog" aria-modal="true"` but does not
 * keep Tab inside, so focus walks out to the page behind the backdrop. The
 * decision is a pure function (testable without a DOM); the browser wiring
 * below only feeds it real elements.
 * @module dsh-orquestrator/client/focus-trap
 */

/**
 * Decide where Tab / Shift+Tab must send focus, or `undefined` to let the
 * browser move it normally.
 * @param focusables - the focusable elements inside the dialog, in tab order.
 * @param active - the currently focused element, or null.
 * @param shift - whether Shift is held.
 * @returns the element to focus explicitly, when the natural move would leave the dialog.
 */
export function trapTarget<T>(focusables: readonly T[], active: T | null, shift: boolean): T | undefined {
  const first = focusables[0]
  const last = focusables.at(-1)
  if (first === undefined || last === undefined) return undefined
  const inside = active !== null && focusables.includes(active)
  if (!inside) return shift ? last : first
  if (shift && active === first) return last
  if (!shift && active === last) return first
  return undefined
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/**
 * Trap Tab inside the plugin's dialog while mounted.
 * @param isPaused - true while a menu portal (outside the dialog) owns the keyboard.
 * @returns the disposer that removes the listener.
 */
export function installFocusTrap(isPaused: () => boolean): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || event.defaultPrevented || isPaused()) return
    const active = document.activeElement
    // A menu portal sits outside the dialog; its own keyboard handling wins.
    if (active instanceof Element && active.closest('[role="menu"], [role="listbox"]') !== null) return
    const root = document.querySelector<HTMLElement>('.dsh-orq-dialog')
    if (root === null) return
    const focusables = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.getClientRects().length > 0)
    const target = trapTarget<Element>(focusables, active, event.shiftKey)
    if (target instanceof HTMLElement) {
      event.preventDefault()
      target.focus()
    }
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => { document.removeEventListener('keydown', onKeyDown, true) }
}
