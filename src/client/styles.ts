/**
 * The dialog's stylesheet. It rides the DSH design tokens only
 * (`--dsw-alias-*`), so light/dark themes and the host's shape language apply
 * unchanged; the plugin ships no colors, fonts or radii of its own beyond
 * mirroring the host's own component geometry (r12 fields, r16 sections).
 * Injected once as a `<style>` element and removed on plugin dispose.
 * @module dsh-orquestrator/client/styles
 */

/** Id of the injected `<style>` element (idempotency key across HMR reloads). */
export const STYLE_ID = 'dsh-orquestrator-styles'

/** The stylesheet text. */
export const CSS = `
.dsh-orq-dialog[role='dialog'] { width: min(480px, 100%); max-height: calc(100vh - 48px); }
.dsh-orq-stack { display: flex; flex-direction: column; gap: 12px; max-height: calc(100vh - 250px); overflow-y: auto; padding: 2px; margin: -2px; }
.dsh-orq-task { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-orq-task-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-task-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-orq-section { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-orq-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dsh-orq-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-orq-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-orq-title svg { flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-orq-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-steps { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0 0 0 16px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-orq-field-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dsh-orq-menu-root.dsh-orq-menu-root { display: flex; width: 100%; }
.dsh-orq-picker { display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; width: 100%; height: 36px; padding: 0 10px 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer; }
.dsh-orq-picker:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-orq-picker:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-orq-picker:disabled { cursor: not-allowed; opacity: 0.5; }
.dsh-orq-picker-value { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }
.dsh-orq-picker-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-orq-picker-provider { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-picker-placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-orq-picker-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dsh-orq-status { display: flex; align-items: center; gap: 8px; min-height: 36px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-status-error { color: var(--dsw-alias-state-error-primary); }
.dsh-orq-link { padding: 0; border: 0; background: none; font: inherit; color: var(--dsw-alias-brand-text); text-decoration: underline; cursor: pointer; }
.dsh-orq-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-orq-spin { display: inline-flex; animation: dsh-orq-spin 900ms linear infinite; }
@keyframes dsh-orq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-orq-spin { animation: none; } }
`

/**
 * Inject the stylesheet once.
 * @param doc - the document to style.
 * @returns a disposer that removes the element again.
 */
export function installStyles(doc: Document): () => void {
  const existing = doc.getElementById(STYLE_ID)
  if (existing !== null) existing.remove()
  const element = doc.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  doc.head.appendChild(element)
  return () => { element.remove() }
}
