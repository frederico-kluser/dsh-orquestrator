/**
 * The orchestration dialog, built only from DSH primitives (Modal, Switch,
 * Checkbox, Button, Menu) and DSH tokens so it is indistinguishable from the
 * host's own dialogs in light and dark themes.
 *
 * Two questions, asked once and answered with switches (progressive
 * disclosure: a model picker only appears when its switch is on):
 *  1. Should subagents run on a different model than the main agent?
 *  2. Should an independent reviewer validate each subagent's work, and on
 *     which model?
 *
 * "Cancel" (button, Escape, mask click) never blocks the task: in gate mode it
 * clears any stored choice and lets the task go out exactly as stock DSH.
 * @module dsh-orquestrator/client/OrchestratorDialog
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import {
  Button, Checkbox, IconAgentPresetOutline16, IconShieldOutline16, Modal, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { buildConfig, routeKey, type ModelRoute } from '../shared.ts'
import { modelName, type CatalogState } from './catalog.ts'
import type { DialogRequest } from './dialogs.ts'
import { installFocusTrap } from './focus-trap.ts'
import type { OrchestratorKey } from './locales.ts'
import { ModelPicker } from './ModelPicker.tsx'

/** The bound translate function of this plugin's namespace. */
export type Translate = (key: OrchestratorKey, params?: Record<string, unknown>) => string

/** Props of the dialog. */
export interface OrchestratorDialogProps {
  readonly request: DialogRequest
  readonly catalog: CatalogState
  /** Reload the catalog after a failure. */
  readonly reloadCatalog: () => void
  readonly t: Translate
}

/** Window after a menu closed during which Escape/mask must not also close the dialog. */
const MENU_CLOSE_GUARD_MS = 300

/** How long a gate-mode cancel waits for the host to clear the stored choice. */
const CANCEL_CLEAR_WAIT_MS = 1_500

/**
 * The dialog.
 * @param props - the request, the catalog state and the translate function.
 * @returns the modal.
 */
export function OrchestratorDialog({ request, catalog, reloadCatalog, t }: OrchestratorDialogProps): JSX.Element {
  const { initial, mode } = request
  const uid = useId()
  const [subagentsOn, setSubagentsOn] = useState(initial.subagentModel !== null)
  const [subagentRoute, setSubagentRoute] = useState<ModelRoute | null>(initial.subagentModel)
  const [reviewerOn, setReviewerOn] = useState(initial.reviewer.enabled)
  const [reviewerRoute, setReviewerRoute] = useState<ModelRoute | null>(initial.reviewer.model)
  const [remember, setRemember] = useState(initial.remember)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Escape belongs to an open menu first (the Menu primitive listens on
  // `document` like the Modal does, so both would otherwise fire).
  const menuOpen = useRef(false)
  const menuClosedAt = useRef(0)
  const onMenuOpenChange = useCallback((open: boolean) => {
    menuOpen.current = open
    if (!open) menuClosedAt.current = Date.now()
  }, [])

  // The DSH Modal does not contain Tab; keep keyboard focus inside while it is open.
  useEffect(() => installFocusTrap(() => menuOpen.current), [])

  const mainRoute = catalog.current
  const mainName = mainRoute === null ? undefined : modelName(catalog.groups, mainRoute)
  const needsModel = subagentsOn && subagentRoute === null

  // Evidence-based nudge: errors of models are strongly correlated, and a
  // reviewer on the very same model shares the worker's blind spots.
  const workerEffective: ModelRoute | null = subagentsOn ? subagentRoute : mainRoute
  const reviewerEffective = reviewerRoute ?? workerEffective
  const sameModelReview = reviewerOn
    && (reviewerRoute === null
      ? true
      : workerEffective !== null && routeKey(reviewerEffective ?? reviewerRoute) === routeKey(workerEffective))

  const cancel = useCallback(async (): Promise<void> => {
    if (busy) return
    if (mode === 'gate') {
      // The stock behavior must win for this task: drop any stored choice, but
      // never let a slow host hold the send hostage.
      setBusy(true)
      await Promise.race([
        request.save(null).catch(() => undefined),
        new Promise<void>((resolve) => { setTimeout(resolve, CANCEL_CLEAR_WAIT_MS) }),
      ])
    }
    request.resolve({ kind: 'cancel' })
  }, [busy, mode, request])

  const onClose = useCallback(() => {
    if (menuOpen.current || Date.now() - menuClosedAt.current < MENU_CLOSE_GUARD_MS) return
    void cancel()
  }, [cancel])

  const confirm = useCallback(async (): Promise<void> => {
    if (busy || needsModel) return
    const config = buildConfig({
      subagentModel: subagentsOn ? subagentRoute : null,
      reviewerEnabled: reviewerOn,
      reviewerModel: reviewerRoute,
      remember,
    })
    setBusy(true)
    setError(null)
    try {
      await request.save(config)
    } catch (cause: unknown) {
      setBusy(false)
      setError(t('error.save', { message: cause instanceof Error ? cause.message : String(cause) }))
      return
    }
    request.resolve({ kind: 'confirm', config })
  }, [busy, needsModel, subagentsOn, subagentRoute, reviewerOn, reviewerRoute, remember, request, t])

  const sameText = useMemo(
    () => (mainName === undefined ? t('subagents.same.unknown') : t('subagents.same', { model: mainName })),
    [mainName, t],
  )

  return (
    <Modal
      open
      onClose={onClose}
      title={t('dialog.title')}
      description={t(mode === 'gate' ? 'dialog.description.gate' : 'dialog.description.configure')}
      closeLabel={t('dialog.close')}
      className="dsh-orq-dialog"
      footer={(
        <>
          <Button variant="outline" disabled={busy} title={mode === 'gate' ? t('button.cancelHint') : undefined} onClick={() => { void cancel() }}>
            {t('button.cancel')}
          </Button>
          <Button
            variant="primary"
            autoFocus
            disabled={busy || needsModel}
            title={needsModel ? t('button.needModel') : undefined}
            onClick={() => { void confirm() }}
          >
            {busy ? t('button.saving') : t(mode === 'gate' ? 'button.confirm.gate' : 'button.confirm.configure')}
          </Button>
        </>
      )}
    >
      <div className="dsh-orq-stack">
        {mode === 'gate' && request.preview !== ''
          ? (
              <div className="dsh-orq-task">
                <span className="dsh-orq-task-label">{t('task.label')}</span>
                <span className="dsh-orq-task-text">{request.preview}</span>
              </div>
            )
          : undefined}

        <section className="dsh-orq-section" aria-labelledby={`${uid}-subagents`}>
          <div className="dsh-orq-row">
            <div className="dsh-orq-heading">
              <h3 className="dsh-orq-title" id={`${uid}-subagents`}>
                <IconAgentPresetOutline16 size={16} />
                {t('subagents.title')}
              </h3>
              <p className="dsh-orq-hint">{subagentsOn ? (mainName === undefined ? '' : t('subagents.main', { model: mainName })) : sameText}</p>
            </div>
            <Switch checked={subagentsOn} onChange={setSubagentsOn} label={t('subagents.switch')} disabled={busy} />
          </div>
          {subagentsOn
            ? (
                <ModelPicker
                  id={`${uid}-subagent-model`}
                  label={t('subagents.modelLabel')}
                  groups={catalog.groups}
                  value={subagentRoute}
                  onChange={setSubagentRoute}
                  placeholder={t('picker.placeholder')}
                  status={catalog.status}
                  loadingLabel={t('picker.loading')}
                  errorLabel={t('picker.error')}
                  retryLabel={t('picker.retry')}
                  onRetry={reloadCatalog}
                  disabled={busy}
                  onMenuOpenChange={onMenuOpenChange}
                />
              )
            : undefined}
          {needsModel && catalog.status === 'ready' ? <p className="dsh-orq-hint" role="status">{t('subagents.needModel')}</p> : undefined}
        </section>

        <section className="dsh-orq-section" aria-labelledby={`${uid}-reviewer`}>
          <div className="dsh-orq-row">
            <div className="dsh-orq-heading">
              <h3 className="dsh-orq-title" id={`${uid}-reviewer`}>
                <IconShieldOutline16 size={16} />
                {t('reviewer.title')}
              </h3>
              <p className="dsh-orq-hint">{t('reviewer.description')}</p>
            </div>
            <Switch checked={reviewerOn} onChange={setReviewerOn} label={t('reviewer.switch')} disabled={busy} />
          </div>
          {reviewerOn
            ? (
                <>
                  <ul className="dsh-orq-steps">
                    <li>{t('reviewer.how.1')}</li>
                    <li>{t('reviewer.how.2')}</li>
                    <li>{t('reviewer.how.3')}</li>
                    <li>{t('reviewer.how.4')}</li>
                  </ul>
                  <ModelPicker
                    id={`${uid}-reviewer-model`}
                    label={t('reviewer.modelLabel')}
                    groups={catalog.groups}
                    value={reviewerRoute}
                    onChange={setReviewerRoute}
                    inheritLabel={t('reviewer.sameAsSubagent')}
                    placeholder={t('picker.placeholder')}
                    status={catalog.status}
                    loadingLabel={t('picker.loading')}
                    errorLabel={t('picker.error')}
                    retryLabel={t('picker.retry')}
                    onRetry={reloadCatalog}
                    disabled={busy}
                    onMenuOpenChange={onMenuOpenChange}
                  />
                  {sameModelReview ? <p className="dsh-orq-hint">{t('reviewer.tip.sameModel')}</p> : undefined}
                </>
              )
            : undefined}
        </section>

        <Checkbox checked={remember} onChange={setRemember} label={t('remember.label')} disabled={busy} />
        {error !== null ? <p className="dsh-orq-error" role="alert">{error}</p> : undefined}
      </div>
    </Modal>
  )
}
