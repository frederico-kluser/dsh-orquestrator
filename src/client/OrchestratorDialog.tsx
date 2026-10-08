/**
 * The orchestration dialog, built only from DSH primitives (Modal, Switch,
 * Button, Menu) and DSH tokens so it is indistinguishable from the
 * host's own dialogs in light and dark themes. It is raised for every new task:
 * there is no "do not ask again", so no answer can hide it from a later task or
 * from another conversation.
 *
 * One question, answered with a switch (progressive disclosure: the model
 * picker only appears when the switch is on): should subagents run on a
 * different model than the main agent? A second, collapsed block, shown once
 * a model is chosen, says how hard subagents may think (reasoning effort). It
 * defaults to the recommended level for the model, so most people never open
 * it, and it says in one line why it exists.
 *
 * When the host offers the global orchestration skill (gate mode only), a third
 * block holds one checkbox that applies the skill to the message being sent: a
 * confirm answers `applySkill` and the gate then puts the skill's `/name` token
 * in the prompt. Without an offer the block is not there. The box follows the
 * subagent-model switch: the skill orchestrates subagents, so with the switch
 * off it shows unchecked and disabled whatever the memory or a typed token
 * says, and the answer is then `applySkill: false`. Toggling the switch off and
 * back on keeps the box state the user left (only the shown value is gated).
 * A message that already carries the token gets the skill whatever the box
 * says: the hint says so, and the gate never removes that token.
 *
 * "Cancel" (button, Escape, mask click) never blocks the task: in gate mode it
 * clears any stored choice and lets the task go out exactly as stock DSH, with
 * no skill token.
 * @module dsh-orquestrator/client/OrchestratorDialog
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import {
  Button, Checkbox, IconAgentPresetOutline16, IconSkillOutline16, Modal, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { notesFor } from '../models.ts'
import { buildConfig, type ModelRoute } from '../shared.ts'
import { adviseEffort, modelName, type CatalogState } from './catalog.ts'
import type { DialogRequest } from './dialogs.ts'
import { installFocusTrap } from './focus-trap.ts'
import { EffortPicker } from './EffortPicker.tsx'
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
  // The skill checkbox exists only when a task is being sent and the host offers the skill.
  const skill = mode === 'gate' ? request.skill : null
  const skillOffered = skill !== null
  // A token already in the message applies the skill whatever the box says: show that, do not pretend to ask.
  const skillLocked = skillOffered && request.skillInMessage
  const [skillOn, setSkillOn] = useState(request.initialSkill)
  const [subagentsOn, setSubagentsOn] = useState(initial.subagentModel !== null)
  const [subagentRoute, setSubagentRoute] = useState<ModelRoute | null>(initial.subagentModel)
  const [workerEffort, setWorkerEffort] = useState<string | null>(initial.workerEffort)
  const [effortOpen, setEffortOpen] = useState(initial.workerEffort !== null)
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

  // Reasoning effort: what "recommended" means for the chosen model.
  const effortActive = subagentsOn && subagentRoute !== null
  const workerAdvice = effortActive ? adviseEffort(catalog.groups, subagentRoute) : undefined
  // A stored level stays chosen until the model's ladder says otherwise: while the catalog is loading or
  // unreachable the ladder is unknown, and dropping the level would silently reset a confirmed choice to
  // "recommended". Only a ladder that is known and lacks the level falls back to it.
  const workerLadder = workerAdvice?.ladder
  const workerChosen = workerLadder === undefined
    ? workerEffort
    : (workerLadder.efforts.some(effort => effort.id === workerEffort) ? workerEffort : null)
  const recommendedText = workerAdvice?.level === undefined
    ? t('effort.recommended.default')
    : t('effort.recommended', { level: workerAdvice.level.name })
  const noteTexts = (route: ModelRoute | null): string[] => (
    route === null ? [] : notesFor(route).slice(0, 2).map(note => t(`note.${note}` as OrchestratorKey))
  )

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
      workerEffort: subagentsOn ? workerChosen : null,
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
    request.resolve({ kind: 'confirm', config, applySkill: skillOffered && subagentsOn && (skillLocked || skillOn) })
  }, [busy, needsModel, subagentsOn, subagentRoute, workerChosen, skillOffered, skillLocked, skillOn, request, t])

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
          {subagentsOn ? <p className="dsh-orq-hint">{t('subagents.scope')}</p> : undefined}
          {subagentsOn ? noteTexts(subagentRoute).map(text => <p key={text} className="dsh-orq-hint dsh-orq-note">{text}</p>) : undefined}
          {needsModel && catalog.status === 'ready' ? <p className="dsh-orq-hint" role="status">{t('subagents.needModel')}</p> : undefined}
        </section>

        {effortActive
          ? (
              <section className="dsh-orq-section dsh-orq-section-quiet" aria-labelledby={`${uid}-effort`}>
                <div className="dsh-orq-row">
                  <div className="dsh-orq-heading">
                    <h3 className="dsh-orq-title" id={`${uid}-effort`}>{t('effort.title')}</h3>
                    <p className="dsh-orq-hint">{workerChosen === null ? t('effort.summary.recommended') : t('effort.summary.custom')}</p>
                  </div>
                  <button
                    type="button"
                    className="dsh-orq-link"
                    aria-expanded={effortOpen}
                    aria-controls={`${uid}-effort-body`}
                    disabled={busy}
                    onClick={() => { setEffortOpen(!effortOpen) }}
                  >
                    {effortOpen ? t('effort.hide') : t('effort.show')}
                  </button>
                </div>
                {effortOpen
                  ? (
                      <div className="dsh-orq-stack-tight" id={`${uid}-effort-body`}>
                        <p className="dsh-orq-hint">{t('effort.hint')}</p>
                        {workerAdvice?.ladder !== undefined
                          ? (
                              <EffortPicker
                                id={`${uid}-worker-effort`}
                                label={t('effort.subagent')}
                                ladder={workerAdvice.ladder}
                                value={workerChosen}
                                onChange={setWorkerEffort}
                                recommendedLabel={recommendedText}
                                defaultSuffix={t('effort.defaultSuffix')}
                                disabled={busy}
                                onMenuOpenChange={onMenuOpenChange}
                              />
                            )
                          : <p className="dsh-orq-hint">{t('effort.subagent')}: {workerChosen ?? t('effort.none')}</p>}
                      </div>
                    )
                  : undefined}
              </section>
            )
          : undefined}

        {skill !== null
          ? (
              <section className="dsh-orq-section dsh-orq-skill" aria-labelledby={`${uid}-skill`}>
                <h3 className="dsh-orq-title" id={`${uid}-skill`}>
                  <IconSkillOutline16 size={16} />
                  {t('skill.title')}
                </h3>
                <Checkbox
                  checked={subagentsOn && (skillLocked || skillOn)}
                  onChange={setSkillOn}
                  label={t('skill.checkbox')}
                  disabled={busy || skillLocked || !subagentsOn}
                />
                <p className="dsh-orq-hint dsh-orq-skill-hint">
                  {t(skillLocked ? 'skill.typed' : (subagentsOn ? 'skill.hint' : 'skill.needsModel'), { token: `/${skill.name}` })}
                </p>
              </section>
            )
          : undefined}

        {error !== null ? <p className="dsh-orq-error" role="alert">{error}</p> : undefined}
      </div>
    </Modal>
  )
}
