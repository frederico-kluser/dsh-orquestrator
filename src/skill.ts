/**
 * The global agent skill the plugin ships, `orchestrate-subagents`, and how it reaches DSH's skill registry.
 *
 * It is registered at plugin load through `ctx.skills.register()`, so that a `/orchestrate-subagents` token in a
 * user message makes DSH inject the skill's instructions, and, unless the operator keeps it out of the model's
 * catalog, so that the model's skill catalog lists it. The registration is a runtime skill (no file provider, no
 * `resourceBase`): DSH then tells the model nothing about a resource directory, which is what the skill's own text
 * wants, since the orchestrator it teaches does not read files.
 *
 * The text is not read from disk at runtime, because the published package is one bundled `lib/index.js`:
 * `scripts/gen-skill.mjs` embeds `skills/orchestrate-subagents/SKILL.md` in `skill.generated.ts` at build time.
 * The file on disk is only handed to DSH as the skill's `path` when it exists, so the transcript can open it.
 *
 * Host half only: nothing in the browser half may import this module, or the whole text would ride in `lib/client.cjs`.
 * @module dsh-orquestrator/skill
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LoggerLike, SkillRegistrationLike, SkillsLike } from './host-services.ts'
import { SKILL_SOURCE } from './skill.generated.ts'

/** The origin bucket DSH shows for the skill: the plugin that registered it. */
const SKILL_ORIGIN = 'dsh-orquestrator'

/**
 * The generated module typed as what it carries, so that a skill with or without `when-to-use` type-checks the same.
 * Assigning the `as const` object to this widens it; nothing is copied.
 */
interface SkillSourceShape {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
}

const SOURCE: SkillSourceShape = SKILL_SOURCE

/** What the operator decides about the skill (the `skill` block of the configuration). */
export interface SkillSettings {
  /**
   * Whether the model's skill catalog and `skill` tool include it. False leaves only the `/name` token and the
   * dialog's checkbox to load it; the skill stays user-invocable either way.
   */
  readonly modelInvocable: boolean
}

/**
 * Where the skill's Markdown lies on disk: `skills/orchestrate-subagents/SKILL.md` next to `src/` (development) and
 * next to `lib/` (the installed package), which is the same relative URL from both.
 * @returns the absolute path, or undefined when the file is not there (a package built without it) or the module
 *   does not live at a `file:` URL. It never throws.
 */
export function bundledSkillPath(): string | undefined {
  try {
    const path = fileURLToPath(new URL('../skills/orchestrate-subagents/SKILL.md', import.meta.url))
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * The definition handed to `ctx.skills.register()`. `resourceBase` is deliberately absent: with one DSH would tell the
 * model to resolve files against a directory, the opposite of what the skill says. `userInvocable` is always true,
 * because the `/name` token is how the dialog loads the skill for one task.
 * @param settings - the operator's choice.
 * @param path - the skill file on disk, when there is one (see {@link bundledSkillPath}).
 * @returns the registration.
 */
export function skillRegistration(settings: SkillSettings, path?: string): SkillRegistrationLike {
  return {
    name: SOURCE.name,
    description: SOURCE.description,
    content: SOURCE.content,
    source: SKILL_ORIGIN,
    invocation: { modelInvocable: settings.modelInvocable, userInvocable: true },
    ...SOURCE.whenToUse === undefined ? {} : { whenToUse: SOURCE.whenToUse },
    ...path === undefined ? {} : { path },
  }
}

/**
 * Register the global skill with DSH. Never throws: a registry that refuses it (an invalid definition, a composition
 * whose registry is gone) costs the skill, not the plugin's load, and the log says so.
 * @param skills - the `ctx.skills` registry.
 * @param settings - the operator's choice.
 * @param logger - one info line on success, one warning on failure.
 * @returns whether the skill is registered (so the browser may offer it) and `dispose`, which unregisters it
 *   (idempotent; DSH also unregisters it when the plugin's context is disposed).
 */
export function registerOrchestrationSkill(
  skills: SkillsLike,
  settings: SkillSettings,
  logger: Pick<LoggerLike, 'info' | 'warn'>,
): { readonly available: boolean; dispose(): void } {
  let unregister: () => void
  try {
    unregister = skills.register(skillRegistration(settings, bundledSkillPath()))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`dsh-orquestrator: could not register the global skill "${SOURCE.name}": ${reason}; the dialog will not offer it`)
    return { available: false, dispose() {} }
  }
  logger.info(`dsh-orquestrator: registered the global skill "${SOURCE.name}" (model-invocable: ${settings.modelInvocable ? 'yes' : 'no'})`)
  let disposed = false
  return {
    available: true,
    dispose() {
      if (disposed) return
      disposed = true
      unregister()
    },
  }
}
