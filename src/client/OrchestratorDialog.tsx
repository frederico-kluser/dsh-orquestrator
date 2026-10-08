/**
 * The orchestration dialog, built from DSH primitives (Modal, Switch, Checkbox,
 * Button, Menu) plus one native `<select>`, and from the host's tokens only, so
 * it is indistinguishable from the host's own dialogs in light and dark themes.
 * It is raised for every new task: there is no "do not ask again", so no answer
 * can hide it from a later task or from another conversation.
 *
 * One question, answered with a switch: should subagents run on a different
 * model than the main agent? With the switch on, the picker under it chooses
 * that model. Under the picker, always visible, the reasoning-effort select
 * offers the levels of the model that will actually run the subagents (the main
 * agent's model while the switch is off) plus a first neutral row that leaves
 * the level to the model itself. A model change answers the effort question with
 * that model's highest level; a stored level, though, is never dropped at open,
 * not even while the catalog is still loading. Under the select, a capability
 * strip says what the effective model understands (audio, images, text, video)
 * and, when it is known, its benchmark score; an unknown model shows no strip.
 *
 * When the host offers the global orchestration skill (gate mode), the last
 * section holds one checkbox that applies the skill to the message being sent: a
 * confirm answers `applySkill` and the gate then puts the skill's `/name` token
 * in the prompt. Without an offer the section is not there. The box is always
 * visible and always toggleable, whatever the subagent-model switch says: the
 * skill token may go out on a message whose subagents stay on the main model. A
 * message that already carries the token gets the skill whatever the box says:
 * the box then shows ticked and locked, the hint says so, and the gate never
 * removes that token.
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
import { ladderOf, modelName, type CatalogState } from './catalog.ts'
import type { DialogRequest } from './dialogs.ts'
import { EffortPicker, highestEffortOf } from './EffortPicker.tsx'
import { FactsAudioIcon, FactsPhotoIcon, FactsTextIcon, FactsVideoIcon } from './facts-icons.tsx'
import { installFocusTrap } from './focus-trap.ts'
import type { OrchestratorKey } from './locales.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { modelFactsOf, type ModelFacts } from './model-facts.ts'

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

/** One input modality of the capability strip, in the order the strip shows them. */
const MODALITIES = [
  { id: 'audio', icon: FactsAudioIcon },
  { id: 'image', icon: FactsPhotoIcon },
  { id: 'text', icon: FactsTextIcon },
  { id: 'video', icon: FactsVideoIcon },
] as const satisfies readonly { readonly id: keyof ModelFacts['modalities']; readonly icon: (props: { size?: number }) => JSX.Element }[]

/** Accessible label of each modality, marked and dimmed. */
const MODALITY_LABELS: Record<keyof ModelFacts['modalities'], { readonly on: OrchestratorKey; readonly off: OrchestratorKey }> = {
  audio: { on: 'facts.audio', off: 'facts.audio.off' },
  image: { on: 'facts.photo', off: 'facts.photo.off' },
  text: { on: 'facts.text', off: 'facts.text.off' },
  video: { on: 'facts.video', off: 'facts.video.off' },
}

/** Label of each score kind. */
const SCORE_LABELS: Record<'terminal-bench-4' | 'intelligence', OrchestratorKey> = {
  'terminal-bench-4': 'facts.tb4',
  intelligence: 'facts.intelligence',
}

/**
 * The capability strip of one model: four modality glyphs, marked when the model
 * understands that input and dimmed when it does not, plus the benchmark score
 * when the facts carry one.
 * @param props - the facts and the translate function.
 * @returns the strip.
 */
function CapabilityStrip({ facts, t }: { readonly facts: ModelFacts; readonly t: Translate }): JSX.Element {
  const score = facts.score
  return (
    <div className="dsh-orq-facts">
      {MODALITIES.map(({ id, icon: Icon }) => {
        const on = facts.modalities[id]
        const label = t(on ? MODALITY_LABELS[id].on : MODALITY_LABELS[id].off)
        return (
          <span key={id} className="dsh-orq-fact" data-orq-on={on ? 'true' : 'false'} role="img" aria-label={label} title={label}>
            <Icon size={15} />
          </span>
        )
      })}
      {score === null
        ? undefined
        : <span className="dsh-orq-facts-score">{t(SCORE_LABELS[score.kind], { value: score.value })}</span>}
    </div>
  )
}

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [facts, setFacts] = useState<ModelFacts | null>(null)

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

  // The model the effort ladder and the capability strip follow: the picked subagent model, and the main
  // agent's model while the switch is off (the subagents then run on it).
  const effectiveRoute: { readonly provider: string; readonly model: string } | null = subagentsOn ? subagentRoute : mainRoute
  const effectiveLadder = effectiveRoute === null ? undefined : ladderOf(catalog.groups, effectiveRoute)
  const hasLadder = effectiveLadder !== undefined && effectiveLadder.efforts.length > 0
  // A stored level stays chosen until the model's ladder says otherwise: while the catalog is loading or
  // unreachable the ladder is unknown, and dropping the level would silently reset a confirmed choice to
  // the neutral row. Only a ladder that is known and lacks the level falls back to it.
  const workerChosen = effectiveLadder === undefined
    ? workerEffort
    : (effectiveLadder.efforts.some(effort => effort.id === workerEffort) ? workerEffort : null)

  // AUTO-MAX: choosing a model answers the effort question with that model's highest level right away.
  // Opening the dialog is not a model change, so a stored level keeps its stored level until the user picks.
  const onModelChange = useCallback((route: ModelRoute | null) => {
    setSubagentRoute(route)
    setWorkerEffort(highestEffortOf(route === null ? undefined : ladderOf(catalog.groups, route)))
  }, [catalog.groups])

  // The facts of the effective model, fetched as the selection changes. Keyed by the model id: a slow
  // answer for a model the user has already left never lands on the strip. Unknown models resolve null
  // and show no strip at all; the request itself never blocks the dialog.
  const factsModel = effectiveRoute?.model
  const factsName = effectiveRoute === null ? undefined : modelName(catalog.groups, effectiveRoute)
  const factsKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    factsKey.current = factsModel
    setFacts(null)
    if (factsModel === undefined) return
    let live = true
    void modelFactsOf(factsModel, factsName).then((next) => {
      if (!live || factsKey.current !== factsModel) return
      setFacts(next)
    })
    return () => { live = false }
  }, [factsModel, factsName])

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
    // The effort travels on its own: with the switch off it is an effort-only choice, which the host honors.
    const config = buildConfig({
      subagentModel: subagentsOn ? subagentRoute : null,
      workerEffort: workerChosen,
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
    request.resolve({ kind: 'confirm', config, applySkill: skillOffered && (skillLocked || skillOn) })
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
                  onChange={onModelChange}
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
          <EffortPicker
            id={`${uid}-effort`}
            label={t('effort.label')}
            efforts={effectiveLadder?.efforts ?? []}
            value={workerChosen}
            neutralLabel={t('effort.defaultOption')}
            disabled={busy || !hasLadder}
            onChange={setWorkerEffort}
          />
          {facts === null ? undefined : <CapabilityStrip facts={facts} t={t} />}
          {subagentsOn ? <p className="dsh-orq-hint">{t('subagents.scope')}</p> : undefined}
          {subagentsOn ? noteTexts(subagentRoute).map(text => <p key={text} className="dsh-orq-hint dsh-orq-note">{text}</p>) : undefined}
          {needsModel && catalog.status === 'ready' ? <p className="dsh-orq-hint" role="status">{t('subagents.needModel')}</p> : undefined}
        </section>

        {skill !== null
          ? (
              <section className="dsh-orq-section dsh-orq-skill" aria-labelledby={`${uid}-skill`}>
                <h3 className="dsh-orq-title" id={`${uid}-skill`}>
                  <IconSkillOutline16 size={16} />
                  {t('skill.title')}
                </h3>
                <Checkbox
                  checked={skillLocked || skillOn}
                  onChange={setSkillOn}
                  label={t('skill.checkbox')}
                  disabled={busy || skillLocked}
                />
                <p className="dsh-orq-hint dsh-orq-skill-hint">
                  {t(skillLocked ? 'skill.typed' : 'skill.hint', { token: `/${skill.name}` })}
                </p>
              </section>
            )
          : undefined}

        {error !== null ? <p className="dsh-orq-error" role="alert">{error}</p> : undefined}
      </div>
    </Modal>
  )
}
