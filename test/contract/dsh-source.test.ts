/**
 * Pins the DSH internals this plugin relies on, by reading the DSH source
 * checkout. Skipped unless DSH_CHECKOUT points at a checkout (on the macmini:
 * /Volumes/Ext2TB/Projects/deepseek-harness). When DSH changes one of these
 * seams, this test fails first and names the seam.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const checkout = process.env['DSH_CHECKOUT']
const skip = checkout === undefined || !existsSync(join(checkout, 'package.json'))
const read = (path: string): string => readFileSync(join(checkout as string, path), 'utf8')

/** Every non-test TypeScript source under `packages/` that matches a pattern (paths relative to the checkout). */
function sourcesMatching(pattern: RegExp): string[] {
  const root = join(checkout as string, 'packages')
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'tests' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name) && pattern.test(readFileSync(path, 'utf8'))) found.push(relative(checkout as string, path))
    }
  }
  walk(root)
  return found.sort()
}

describe('DSH source contract', { skip: skip ? 'set DSH_CHECKOUT to a DeepSeek Harness checkout' : false }, () => {
  it('targets the tested DSH line', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version
    assert.match(version, /^0\.1\.6/, `tested on 0.1.6-alpha.x, found ${version}`)
  })

  it('SubagentRuntime keeps start/startContinuable/getProvider and the request fields the guard reads', () => {
    const runtime = read('packages/subagent/subagent/src/index.ts')
    assert.match(runtime, /async startContinuable\(spec: ContinuableStartSpec\): Promise<ContinuableStart>/)
    assert.match(runtime, /getProvider\(/)
    const types = read('packages/subagent/subagent/src/types.ts')
    for (const field of ['agentOptions', 'parent', 'signal', 'prompt']) assert.match(types, new RegExp(`\\b${field}\\b`))
    const spawn = read('packages/subagent/subagent-spawn-in-process/src/index.ts')
    assert.match(spawn, /agentOptions: true/)
  })

  it('SessionFace.prompt keeps its shape and beginSubmission still precedes it', () => {
    const session = read('packages/api/session-controller/src/client/sessions/session.ts')
    assert.match(session, /async prompt\(\s+content: PromptContentPart\[\],\s+mode: 'queue' \| 'steer',\s+signal\?: AbortSignal,\s+requestId\?: SessionRequestId,\s+\): Promise<RemoteResult<\{ accepted: true \}>>/)
    const service = read('packages/client/ui-conversation/src/client/service.ts')
    assert.match(service, /session\.beginSubmission\(\{/)
    assert.match(service, /await session\.prompt\(content, mode, signal, submission\.requestId\)/)
    const face = read('packages/api/session-controller/src/client/contract/snapshot.ts')
    assert.match(face, /readonly running: boolean/)
    assert.match(face, /readonly subagent: \{/)
    assert.match(face, /readonly blank: boolean/) // not read by the gate any more (the dialog asks every time); a pin of the snapshot's shape
  })

  it('the web client reuses a workspace\'s blank session for "new session": why "do not ask again" may never rest on one', () => {
    const navigation = read('packages/client/ui-workspace/src/client/navigation.ts')
    assert.match(navigation, /summary\.blank && summary\.cwd === workspace\.path/) // the reuse: one choice would cover the workspace
    assert.match(navigation, /this\.sessions\.create\(\{ workspaceId \}\)/) // otherwise a fresh session
    assert.match(read('packages/api/session-controller/src/list.ts'), /state\.blank && event\.type !== 'turn\/start'/) // blank ends at the first turn
  })

  it('the composer still declares the overlay slot and the dock slot, and looks the conversation service up per send', () => {
    const slots = read('packages/client/ui-conversation/src/client/contract/slots.ts')
    assert.match(slots, /conversation\.input\.overlay/)
    assert.match(slots, /'conversation\.composer\.dock': \{ kind: 'list'; scope: 'session' \}/) // where the status chip mounts
    assert.match(read('packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'), /renderSlot\('conversation\.composer\.dock', \{\}\)/)
    assert.match(read('packages/client/ui-conversation/src/client/input/hub.ts'), /this\.conversation\(\)\.sendSession\(/)
  })

  it('the primitives this plugin renders are still exported, with the props it passes', () => {
    const index = read('packages/client/ui-primitives/src/index.ts')
    for (const name of ['Modal', 'Button', 'Switch', 'Checkbox', 'Menu', 'IconAgentPresetOutline16', 'IconSkillOutline16']) {
      assert.match(index + read('packages/client/ui-primitives/src/icons/index.tsx'), new RegExp(`\\b${name}\\b`))
    }
    const modal = read('packages/client/ui-primitives/src/Modal.tsx')
    for (const prop of ['open', 'onClose', 'title', 'closeLabel', 'description', 'footer', 'className']) assert.match(modal, new RegExp(`\\b${prop}\\b`))
    assert.match(read('packages/client/ui-primitives/src/Menu.tsx'), /portal = false/)
    assert.match(read('packages/client/ui-primitives/src/Checkbox.tsx'), /onChange: \(next: boolean\) => void/) // the skill checkbox hands the dialog a boolean
  })

  it('the shell platform table still answers every external of the client bundle', () => {
    const platform = read('packages/client/web/src/platform.ts')
    for (const specifier of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']) {
      assert.ok(platform.includes(`'${specifier}'`), `${specifier} left PLATFORM_MODULES`)
    }
  })

  it('a child re-routed without an effort loses the parent\'s level and resolves the route default: why every child gets an explicit effort', () => {
    const child = read('packages/subagent/subagent/src/child-agent.ts')
    assert.match(child, /const routeChanged = resolved\.provider !== parentProvider \|\| resolved\.model !== parentModel/)
    assert.match(child, /if \(routeChanged && requested\?\.reasoningEffort === undefined\) delete resolved\.reasoningEffort/)
    assert.match(child, /\.\.\.requested,\s+subagentDepth: childDepth/) // `requested` is merged over the parent's options
    assert.match(child, /\.\.\.parentMaxTokens !== undefined \? \{ maxTokens: parentMaxTokens \} : \{\}/)
    assert.match(child, /\.\.\.parentHeader\.cwd !== undefined \? \{ cwd: parentHeader\.cwd \} : \{\}/) // the session header carries the workspace
    assert.match(child, /const requestConfig = parent\.session\.requestHeader\(\)\?\.config/) // the live route comes from the request header
  })

  it('the LLM service describes a route\'s reasoning ladder and token ceiling, and never clamps an unsupported effort', () => {
    const llm = read('packages/llm/llm/src/index.ts')
    assert.match(llm, /async resolveModelInfo\(\s+provider: string,\s+model: string,\s+signal\?: AbortSignal,\s+\): Promise<LlmResolvedModelInfo>/)
    assert.match(llm, /const defaultMaxTokens = resolved\.defaultMaxTokens/)
    assert.match(llm, /Unsupported explicit efforts\s+\* reject before provider I\/O; no clamping or aliasing is performed/)
    assert.match(llm, /'UNSUPPORTED_REASONING_EFFORT'/)
    const adapter = read('packages/llm/llm-pi-ai/src/adapter.ts')
    assert.match(adapter, /efforts: levels\.map\(level => \(\{\s+id: ReasoningEffortId\(level\)/)
    assert.match(adapter, /\.\.\.defaultLevel === undefined \? \{\} : \{ defaultEffort: ReasoningEffortId\(defaultLevel\) \}/)
    const catalog = read('packages/llm/llm-pi-ai/src/catalog.ts')
    assert.match(catalog, /off: true,\s+minimal: true,\s+low: true,\s+medium: true,\s+high: true,\s+xhigh: true,\s+max: true,/) // the canonical level order of src/models.ts
  })

  it('the browser catalog carries each model\'s reasoning ladder and default level', () => {
    const types = read('packages/api/session-controller/src/types.ts')
    assert.match(types, /export interface ModelReasoning \{\s+readonly efforts: readonly ModelReasoningEffort\[\]\s+readonly defaultEffort\?: string/)
    assert.match(types, /readonly reasoning\?: ModelReasoning/)
    assert.match(read('packages/api/session-controller/src/catalog.ts'), /efforts: resolved\.reasoning\.efforts\.map/)
  })

  it('DeepSeek\'s own route is deepseek-official and still lists deepseek-v4-pro next to deepseek-flash', () => {
    assert.match(read('packages/llm/llm-deepseek/src/index.ts'), /const PROVIDER = 'deepseek-official'/)
    const models = read('packages/llm/llm-deepseek/src/common/models.ts')
    assert.match(models, /id: 'deepseek-flash'/)
    assert.match(models, /id: 'deepseek-v4-pro'/)
  })

  it('every child of every delegation passes through SubagentRuntime.start or startContinuable: the two doors the start guard stands in', () => {
    const runtime = read('packages/subagent/subagent/src/index.ts')
    assert.match(runtime, /async start\(name: string, request: SubagentStartRequest\): Promise<SubagentRun>/)
    assert.match(runtime, /const run = await provider\.start\(resolved\)/)
    assert.match(runtime, /async startContinuable\(spec: ContinuableStartSpec\): Promise<ContinuableStart>/)
    // A provider is started from SubagentRuntime.start and nowhere else; a second call site would be a door the guard does not cover.
    assert.deepEqual(sourcesMatching(/\b(?:provider|subagentProvider|backend)\.start\(/), ['packages/subagent/subagent/src/index.ts'])
    // Whoever obtains a provider object (the public `getProvider`) could start it without the runtime, whatever the variable is
    // called: that list is reviewed, so a new consumer of provider objects cannot slip in as a door.
    assert.deepEqual(sourcesMatching(/\.getProvider\(/), [
      'packages/subagent/tool-subagent/src/index.ts',
      'packages/workflow/tool-ralph/src/index.ts',
      'packages/workflow/workflow-ptc/src/index.ts',
    ])
    // A child agent (one with a live parent) is created only by the one-shot driver and the continuation activation, both
    // reached through those doors. Pinned as the SET of non-test sources that mention a parent agent at all, and as the set
    // of every agent create/resume call site, so a new door cannot hide behind a different variable name.
    assert.deepEqual(sourcesMatching(/\bparentAgent\b/), [
      'packages/core/agent-loop/src/index.ts',
      'packages/core/agent/src/index.ts',
      'packages/extensions/tool-cordis/src/api-catalog.ts',
      'packages/subagent/subagent-in-process-driver/src/index.ts',
      'packages/subagent/subagent/src/continuation-activation.ts',
    ])
    assert.deepEqual(sourcesMatching(/\bagents\.(?:create|resume)\(\{/), [
      'packages/acp/acp/src/session.ts',
      'packages/api/session-controller/src/agent.ts',
      'packages/api/session-controller/src/commands.ts',
      'packages/bundle/headless/src/index.ts',
      'packages/sdk/server/src/server.ts',
      'packages/subagent/subagent-in-process-driver/src/index.ts',
      'packages/subagent/subagent/src/continuation-activation.ts',
      'packages/webhook/webhook/src/session.ts',
    ])
    assert.match(read('packages/subagent/subagent/src/continuation.ts'), /const agentOptions = resolveChildAgentOptions\(parent, request\.agentOptions, childDepth\)/)
    // The one-shot driver (every `spawn` and `fork` child) hands the request's agentOptions to the same resolver.
    assert.match(read('packages/subagent/subagent-in-process-driver/src/index.ts'), /agentOptions: resolveChildAgentOptions\(parent, request\.agentOptions, childDepth\)/)
  })

  it('there is no hook around a child start (subagent/start is a notification), so the guard wraps the service instance', () => {
    const runtime = read('packages/subagent/subagent/src/index.ts')
    assert.match(runtime, /'subagent\/start'\(this: Scoped<SubagentRuntime>, info: SubagentRunInfo\): void/)
    assert.match(runtime, /A provider established a published child/)
    assert.doesNotMatch(runtime, /'subagents?\/(pre-start|before-start|resolve|will-start)'/)
    // A deny-list cannot know the next hook's name: the runtime's hooks are listed, so a new one is reviewed (it may be the seam).
    assert.deepEqual([...runtime.matchAll(/'subagents?\/([a-z-]+)'\(/g)].map(match => match[1]), ['provider-added', 'provider-removed', 'start', 'end'])
  })

  it('a Cordis service proxy hands out the instance behind it under Symbol.for(\'cordis.original\')', () => {
    const utils = read('vendor/cordis/src/utils.ts')
    assert.match(utils, /original: Symbol\.for\('cordis\.original'\)/)
    assert.match(utils, /if \(prop === symbols\.original\) return target/)
  })

  it('the workflow engine starts its agents through ctx.subagents.start, with agentOptions of provider and model only (no effort, no token limit)', () => {
    const host = read('packages/workflow/workflow-ptc/src/host.ts')
    assert.match(host, /const run = await this\.subagents\.start\(this\.provider, \{/)
    assert.match(host, /\.\.\.request\.provider === undefined && request\.model === undefined \? \{\} : \{\s+agentOptions: \{\s+\.\.\.request\.provider === undefined \? \{\} : \{ provider: request\.provider \},\s+\.\.\.request\.model === undefined \? \{\} : \{ model: request\.model \},\s+\},\s+\},\s+\}\)/)
    assert.match(read('packages/workflow/workflow-ptc/src/runtime.ts'), /const SUPPORTED_AGENT_OPTIONS = new Set\(\['label', 'phase', 'schema', 'provider', 'model'\]\)/)
    // meta.phases[].model is display metadata: nothing in the engine reads it to pick a child's model.
    assert.equal(/\.phases\b[^\n]*\.model|phase\.model|phase\?\.model/.test(read('packages/workflow/workflow-ptc/src/runtime.ts') + read('packages/workflow/workflow-ptc/src/host.ts')), false)
  })

  it('ralph runs on the same workflow engine, and the standard preset ships workflow-ptc (spawn) and tool-workflow enabled', () => {
    assert.match(read('packages/workflow/tool-ralph/src/index.ts'), /ctx\.workflowEngine\.start\(\{/)
    const preset = read('packages/preset/agent-presets/presets/standard/agent.cordis.yml')
    assert.match(preset, /- id: workflow-ptc\s+name: '@deepseek-ai\/dsh-workflow-ptc'\s+config:\s+provider: spawn/)
    assert.match(preset, /- id: tool-workflow\s+name: '@deepseek-ai\/dsh-tool-workflow'\s+\n/)
    assert.doesNotMatch(preset, /- id: tool-workflow\s+name: '@deepseek-ai\/dsh-tool-workflow'\s+disabled: true/)
  })

  it('which providers take agent options (the README table): spawn, fork and the SDK do; codex, claude-code and ACP do not', () => {
    assert.match(read('packages/subagent/subagent/src/out-of-process.ts'), /NO_START_CAPABILITIES[^=]*=\s*Object\.freeze\(\{\s+agentOptions: false,\s+outputSchema: false,\s+depthLimit: false,\s+toolFilter: false,\s+persona: false,/)
    assert.match(read('packages/subagent/subagent-codex/src/index.ts'), /capabilities: SubagentCapabilities = NO_START_CAPABILITIES/)
    assert.match(read('packages/subagent/subagent-claude-code/src/index.ts'), /capabilities: SubagentCapabilities = NO_START_CAPABILITIES/)
    assert.match(read('packages/subagent/subagent-acp/src/index.ts'), /readonly capabilities: SubagentCapabilities = \{\s+agentOptions: false,/)
    assert.match(read('packages/subagent/subagent-dsh-sdk/src/index.ts'), /SDK_START_CAPABILITIES: SubagentCapabilities = Object\.freeze\(\{\s+\.\.\.NO_START_CAPABILITIES,\s+agentOptions: true,/)
  })

  it('AgentOptions is provider, model, reasoningEffort and maxTokens: replacing it wholesale cannot drop a field that matters', () => {
    // The merge adds one more field, `subagentDepth`, and re-stamps it AFTER `...requested`, so a request cannot lose it.
    assert.match(read('packages/subagent/subagent/src/child-agent.ts'), /\.\.\.requested,\s+subagentDepth: childDepth/)
    const runtime = read('packages/core/agent/src/runtime-types.ts')
    const block = runtime.slice(runtime.indexOf('export interface AgentOptions {'), runtime.indexOf('}', runtime.indexOf('export interface AgentOptions {')))
    const fields = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map(match => match[1])
    assert.deepEqual(fields, ['provider', 'model', 'reasoningEffort', 'maxTokens'])
  })

  it('DSH\'s skill registry takes a runtime skill and tool-skill loads it from a `/name` token in a user message: how the orchestration skill reaches a task', () => {
    const registry = read('packages/skill/skill/src/index.ts')
    assert.match(registry, /skills: SkillRegistry/) // `ctx.skills`: the service the plugin registers with
    assert.match(registry, /register\(skill: SkillRegistration\): \(\) => void/)
    assert.match(registry, /export type SkillRegistration = Omit<SkillDefinition, 'invocation' \| 'provider'> & \{/)
    assert.match(registry, /const SKILL_NAME = \/\^\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\*\$\//) // the name grammar: kebab-case words
    assert.match(registry, /const RUNTIME_RANK = 250/) // a runtime skill outranks user-level ones (400, 500) and loses to project-level ones (100, 200)
    assert.match(registry, /ignored because it is already registered/) // a duplicate name in one layer is first-wins and logged
    const loader = read('packages/skill/tool-skill/src/index.ts')
    assert.match(loader, /const SKILL_GESTURE = \/\(\^\|\\s\)\\\/\(\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\*\)\(\?=\\s\|\$\)\/g/) // a whitespace-bounded token anywhere in the text
    assert.match(loader, /\(message\.source as \{ kind\?: unknown \}\)\.kind !== 'user'/) // only a user's own message can carry the gesture
    assert.match(loader, /if \(skill === undefined \|\| !isUserInvocable\(skill\)\) continue/)
    assert.match(loader, /content: \[\{ type: 'text', text: renderSkillContent\(skill\) \}\]/) // the whole body is injected
    assert.match(loader, /\.\.\.decision, messages: \[\.\.\.decision\.messages, \.\.\.injections\]/) // after every other injection, closest to the answer
    assert.match(read('packages/skill/tool-skill/src/index.ts'), /DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH/)
    assert.match(read('docs/subsystems/skills.md'), /default `500`/) // the catalog caps a skill's description there: ours stays well under
  })

  it('every in-process child emits subagent/start and subagent/end with the identity, the backend, `local` and the stop reason the ledger reads', () => {
    const types = read('packages/subagent/subagent/src/types.ts')
    // An interface body ends at the first closing brace in column 0 (a doc comment inside it may hold `{@link ...}`).
    const body = (name: string): string => types.slice(types.indexOf(`export interface ${name} {`), types.indexOf('\n}\n', types.indexOf(`export interface ${name} {`)))
    assert.deepEqual([...body('SubagentRunInfo').matchAll(/^\s{2}readonly (\w+)\??:/gm)].map(match => match[1]), ['runId', 'provider', 'id', 'local'])
    assert.deepEqual([...body('SubagentRunEndInfo').matchAll(/^\s{2}readonly (\w+)\??:/gm)].map(match => match[1]), ['runId', 'provider', 'id', 'local', 'stopReason', 'lastAssistantMessage'])
    const reasons = read('packages/subagent/subagent/src/types.ts')
    for (const reason of ['completed', 'aborted', 'error', 'max-tokens', 'refusal']) assert.match(reasons, new RegExp(`'${reason}'`)) // the set `subagentStateOf` maps; an unknown one counts as a failure
    const lifecycle = read('packages/subagent/subagent/src/lifecycle.ts')
    assert.match(lifecycle, /emit\('subagent\/end', \{ \.\.\.identity, stopReason: 'error' \}, parent\)/) // an infrastructure rejection still ends the run
    assert.match(lifecycle, /emit\('subagent\/start', identity, parent\)/) // one-shot and continuable epochs alike
    assert.match(lifecycle, /const identity = \{ runId: SubagentRunId\(randomUUID\(\)\), provider, id: childId, local: true \}/)
    // A listener on the root context sees every delegation: the other plugins that watch the lifecycle do exactly that, and a child resolves in the agent registry.
    assert.match(read('packages/hooks/hooks-claude-code/src/index.ts'), /ctx\.on\('subagent\/start', \(info\) => \{\s+const child = ctx\.get\('agents'\)\?\.get\(info\.id\)/)
    assert.match(read('docs/subsystems/subagent.md'), /For in-process providers, `ctx\.agents\.get\(info\.id\)` resolves during this notification/)
  })

  it('a continuable child (the standard preset\'s default) emits its own start when the epoch is resident and its own end only after the handle is disposed: the end cannot read the agent', () => {
    const lifecycle = read('packages/subagent/subagent/src/lifecycle.ts')
    // The continuable epoch's start edge, with the identity whose `runId` pairs it with its end. Pinned in place, because a
    // bare `emit('subagent/start', identity, parent)` also matches the one-shot edge, so removing this one would go unnoticed.
    assert.match(lifecycle, /start: \(child: Agent\): void => \{\s+boundary = child\.session\.seq\s+emit\('subagent\/start', identity, parent\)\s+\},/)
    // Its end edge, `settle`, which publishes the same identity and the epoch's stop reason.
    assert.match(lifecycle, /settle: \(failure: unknown\): void => \{\s+const \{ stopReason, output \} = terminal\(failure\)\s+emit\('subagent\/end', \{\s+\.\.\.identity,\s+stopReason,\s+\.\.\.output === undefined \? \{\} : \{ lastAssistantMessage: output \},\s+\}, parent\)\s+\},/)
    // The one-shot edges: the end on the run's result, and an identity whose `local` is the presence of the run's local agent.
    assert.match(lifecycle, /emit\('subagent\/end', \{\s+\.\.\.identity,\s+stopReason: result\.stopReason,/)
    assert.match(lifecycle, /const identity = \{\s+runId: SubagentRunId\(randomUUID\(\)\),\s+provider,\s+id: run\.id,\s+local: run\.localAgent !== undefined,\s+\}/)
    // Nothing else emits these events: exactly two starts and three ends (one-shot result, one-shot rejection, continuable settle).
    assert.equal(lifecycle.match(/emit\('subagent\/start'/g)?.length, 2)
    assert.equal(lifecycle.match(/emit\('subagent\/end'/g)?.length, 3)
    const activation = read('packages/subagent/subagent/src/continuation-activation.ts')
    assert.match(activation, /observer\.start\(handle\.agent\)/) // the epoch is resident: its start edge
    assert.equal(activation.match(/observer\.start\(/g)?.length, 1) // and nowhere else
    assert.equal(activation.match(/observer\.settle\(/g)?.length, 1) // one end edge per epoch, at the place pinned below
    // The order behind the limit the ledger documents: the handle is disposed (the agent leaves the registry), the child stops being
    // resident, and only then is the end emitted. When DSH emits it earlier, `ctx.agents.get(id)` resolves at the end and the
    // tracker can read the route the child last requested for continuable children too: this test then names the seam to revisit.
    assert.match(activation, /await activation\.handle\.dispose\(\)[\s\S]+?this\.resident\.delete\(childId\)[\s\S]+?activation\.observer\.settle\(failure\)/)
  })

  it('the subagent dropdown keeps the structure the marks on its rows rely on: a body-level role=tree menu, role=treeitem rows in catalog order, the status dot directly before the content span', () => {
    const menu = read('packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx')
    assert.match(menu, /role="tree"\s+aria-label=\{t\('tree\.aria'\)\}/) // the menu, named by the `subagent` namespace's own translation
    assert.match(menu, /\), document\.body\)\}/) // portaled to the body, so a body-level observer sees it open and close
    assert.match(menu, /role="treeitem"\s+tabIndex=\{0\}\s+aria-level=\{level\}/) // a child row; the loading and diagnostic rows are the aria-disabled ones
    assert.match(menu, /aria-label=\{\[label, secondary, metrics\]\.filter\(value => value !== ''\)\.join\(' '\)\}/) // the row's name starts with the child's label
    assert.match(menu, /const label = entry\.label \?\? entry\.id/) // ... which is the creation label, else the session id
    assert.match(menu, /\{catalog\.entries\.map\(\(entry\) => \{/) // rows follow the entries in order, nested groups inside the parent's node
    assert.match(menu, /<StateDot state=\{entry\.activity === 'running' \? 'ongoing' : 'done'\} \/>\s+<span className=\{css\.content\}>/) // the dot, then the content span the model label goes into
    assert.match(menu, /role="group"\s+className=\{css\.children\}/) // a branch's children
    assert.equal((menu.match(/data-state/g) ?? []).length, 0, 'the menu itself never sets data-state: only the status dot carries it')
    const dot = read('packages/client/ui-primitives/src/StateDot.tsx')
    assert.match(dot, /export type StateDotState = 'done' \| 'warning' \| 'ongoing' \| 'error' \| 'idle'/)
    assert.match(dot, /data-state="ongoing"/)
    assert.match(dot, /data-state=\{state\}/)
    assert.match(read('packages/client/ui-subagent/src/client/locales.ts'), /export const NS = 'subagent'/)
    assert.match(read('packages/client/ui-subagent/src/client/locales.ts'), /'tree\.aria': 'Subagent sessions'/)
    // What the plugin reads of the client session store to know which child a row is, and which model it ran on.
    const list = read('packages/api/session-controller/src/client/sessions/service.ts')
    assert.match(list, /subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>/)
    assert.match(list, /projectionValues\?: Readonly<Partial<SessionProjectionMap>>/)
    assert.match(read('packages/api/session-controller/src/types.ts'), /readonly lastUsed: ModelSelection \| null/)
    assert.match(read('packages/api/session-controller/src/client/contract/sessions.ts'), /readonly list: ObservableSnapshot<SessionListState>/)
    const control = read('packages/subagent/subagent/src/control-types.ts')
    assert.match(control, /readonly activity: 'running' \| 'inactive'/)
    assert.match(control, /readonly kind: 'diagnostic'/)
  })

  it('the client command surface still has the action kind and the model directory service', () => {
    assert.match(read('packages/client/ui-commands/src/client/contract.ts'), /readonly kind: 'action'/)
    assert.match(read('packages/client/ui-model-selection/src/client/index.ts'), /ctx\.inject\(\['slots', 'modelDirectories'\]/)
    assert.match(read('packages/client/ui-model-selection/src/client/service.ts'), /directoryFor\(/)
  })
})
