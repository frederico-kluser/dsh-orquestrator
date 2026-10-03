/**
 * Pins the DSH internals this plugin relies on, by reading the DSH source
 * checkout. Skipped unless DSH_CHECKOUT points at a checkout (on the macmini:
 * /Volumes/Ext2TB/Projects/deepseek-harness). When DSH changes one of these
 * seams, this test fails first and names the seam.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const checkout = process.env['DSH_CHECKOUT']
const skip = checkout === undefined || !existsSync(join(checkout, 'package.json'))
const read = (path: string): string => readFileSync(join(checkout as string, path), 'utf8')

describe('DSH source contract', { skip: skip ? 'set DSH_CHECKOUT to a DeepSeek Harness checkout' : false }, () => {
  it('targets the tested DSH line', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version
    assert.match(version, /^0\.1\.6/, `tested on 0.1.6-alpha.x, found ${version}`)
  })

  it('tools/execute is an around-dispatch waterfall whose substituted value is re-validated against the tool schema', () => {
    const tools = read('packages/core/tools/src/index.ts')
    assert.match(tools, /'tools\/execute'\(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: \(\) => Promise<ToolExecutionResult>\): Promise<ToolExecutionResult>/)
    assert.match(tools, /private normalizeDispatchResult\(exec: ToolExecution, result: ToolExecutionResult\)/)
    assert.match(tools, /const normalized = this\.createSuccessResult\(exec, tool, result\.value\)/)
    assert.match(tools, /Input rewriting is excluded/) // why the wrapper substitutes the result instead of rewriting args
  })

  it('the subagent tool output schema still has the foreground and continuable shapes', () => {
    const tool = read('packages/subagent/tool-subagent/src/index.ts')
    assert.match(tool, /kind: 'foreground'/)
    assert.match(tool, /runId/)
    assert.match(tool, /kind: 'continuable'/)
    assert.match(tool, /subagentId/)
    assert.match(tool, /backgroundMode\?: 'one-shot' \| 'continuable'/)
    assert.match(tool, /toolName\?: string/)
  })

  it('the standard preset still delegates through subagent (spawn) and subagent_fork (fork), both continuable', () => {
    const preset = read('packages/preset/agent-presets/presets/standard/agent.cordis.yml')
    assert.match(preset, /provider: spawn\s+toolName: subagent\s+modelSelectionSettings: true\s+backgroundMode: continuable/)
    assert.match(preset, /provider: fork\s+toolName: subagent_fork\s+backgroundMode: continuable/)
  })

  it('SubagentRuntime keeps start/startContinuable/resolveMaxDepth/getProvider and the request fields', () => {
    const runtime = read('packages/subagent/subagent/src/index.ts')
    assert.match(runtime, /async startContinuable\(spec: ContinuableStartSpec\): Promise<ContinuableStart>/)
    assert.match(runtime, /resolveMaxDepth\(configured\?: number \| 'provider-managed'\): number \| undefined/)
    const types = read('packages/subagent/subagent/src/types.ts')
    for (const field of ['agentOptions', 'persona', 'maxDepth', 'toolFilter', 'outputSchema']) assert.match(types, new RegExp(`\\b${field}\\b`))
    const spawn = read('packages/subagent/subagent-spawn-in-process/src/index.ts')
    assert.match(spawn, /agentOptions: true,\s+outputSchema: true,\s+depthLimit: true,\s+toolFilter: true,\s+persona: true/)
  })

  it('the delivery paths the reviewer replaces still exist (settlement notice + child send_message guidance)', () => {
    const messages = read('packages/subagent/subagent/src/continuation-messages.ts')
    assert.match(messages, /kind: 'subagent-settled'/)
    assert.match(messages, /send_message/)
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
    assert.match(face, /readonly blank: boolean/) // the gate reads it: a conversation with no turn yet always asks
  })

  it('the web client reuses a workspace\'s blank session for "new session": why "do not ask again" may never rest on one', () => {
    const navigation = read('packages/client/ui-workspace/src/client/navigation.ts')
    assert.match(navigation, /summary\.blank && summary\.cwd === workspace\.path/) // the reuse: one choice would cover the workspace
    assert.match(navigation, /this\.sessions\.create\(\{ workspaceId \}\)/) // otherwise a fresh session
    assert.match(read('packages/api/session-controller/src/list.ts'), /state\.blank && event\.type !== 'turn\/start'/) // blank ends at the first turn
  })

  it('the composer still declares the overlay slot and looks the conversation service up per send', () => {
    assert.match(read('packages/client/ui-conversation/src/client/contract/slots.ts'), /conversation\.input\.overlay/)
    assert.match(read('packages/client/ui-conversation/src/client/input/hub.ts'), /this\.conversation\(\)\.sendSession\(/)
  })

  it('the primitives this plugin renders are still exported, with the props it passes', () => {
    const index = read('packages/client/ui-primitives/src/index.ts')
    for (const name of ['Modal', 'Button', 'Switch', 'Checkbox', 'Menu', 'IconAgentPresetOutline16', 'IconShieldOutline16']) {
      assert.match(index + read('packages/client/ui-primitives/src/icons/index.tsx'), new RegExp(`\\b${name}\\b`))
    }
    const modal = read('packages/client/ui-primitives/src/Modal.tsx')
    for (const prop of ['open', 'onClose', 'title', 'closeLabel', 'description', 'footer', 'className']) assert.match(modal, new RegExp(`\\b${prop}\\b`))
    assert.match(read('packages/client/ui-primitives/src/Menu.tsx'), /portal = false/)
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

  it('the spawn provider answers a structured request through the cooperative structured_output tool, and settles a plain-text finish as an error', () => {
    const structured = read('packages/subagent/subagent-in-process-driver/src/structured.ts')
    assert.match(structured, /export const STRUCTURED_OUTPUT_TOOL = 'structured_output'/)
    assert.match(structured, /exec\.concludeTurn\(\)/)
    assert.match(structured, /validateJsonSchemaValue\(schema, args\)/)
    assert.match(structured, /Do not finish with a plain text answer/)
    const driver = read('packages/subagent/subagent-in-process-driver/src/index.ts')
    assert.match(driver, /return \{ output, structured: structured\.captured\.value, stopReason \}/)
    assert.match(driver, /if \(stopReason === 'completed'\) return \{ output, stopReason: cancelled \? 'aborted' : 'error' \}/)
    const schema = read('packages/core/tools/src/json-schema.ts')
    for (const keyword of ["'type'", "'oneOf'", "'properties'", "'required'", "'additionalProperties'", "'items'", "'enum'", "'const'"]) assert.ok(schema.includes(keyword), keyword)
    assert.equal(/minItems|maxLength|pattern/.test(schema.slice(schema.indexOf('CONSTRAINT_KEYWORDS'), schema.indexOf('ANNOTATION_KEYWORDS'))), false)
  })

  it('a per-child tool restriction still names unknown tools loudly, which is why the reviewer gets no static deny-list', () => {
    assert.match(read('packages/core/tools/src/index.ts'), /tools\.restrict\(\) names unknown global tool/)
  })

  it('DeepSeek\'s own route is deepseek-official and still lists deepseek-v4-pro next to deepseek-flash', () => {
    assert.match(read('packages/llm/llm-deepseek/src/index.ts'), /const PROVIDER = 'deepseek-official'/)
    const models = read('packages/llm/llm-deepseek/src/common/models.ts')
    assert.match(models, /id: 'deepseek-flash'/)
    assert.match(models, /id: 'deepseek-v4-pro'/)
  })

  it('the client command surface still has the action kind and the model directory service', () => {
    assert.match(read('packages/client/ui-commands/src/client/contract.ts'), /readonly kind: 'action'/)
    assert.match(read('packages/client/ui-model-selection/src/client/index.ts'), /ctx\.inject\(\['slots', 'modelDirectories'\]/)
    assert.match(read('packages/client/ui-model-selection/src/client/service.ts'), /directoryFor\(/)
  })
})
