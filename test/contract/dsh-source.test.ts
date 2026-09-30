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

  it('the client command surface still has the action kind and the model directory service', () => {
    assert.match(read('packages/client/ui-commands/src/client/contract.ts'), /readonly kind: 'action'/)
    assert.match(read('packages/client/ui-model-selection/src/client/index.ts'), /ctx\.inject\(\['slots', 'modelDirectories'\]/)
    assert.match(read('packages/client/ui-model-selection/src/client/service.ts'), /directoryFor\(/)
  })
})
