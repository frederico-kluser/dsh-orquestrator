import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePluginConfig } from '../../src/config.ts'
import { describeRoute, failureMessage, flattenText, orchestrate, parseDelegationArgs, settle, toAgentOptions, type PipelineDeps } from '../../src/pipeline.ts'
import { buildConfig } from '../../src/shared.ts'
import { FakeRun, FakeSubagents, fakeAgent, promptText, textResult } from '../helpers.ts'

const tool = { name: 'subagent', provider: 'spawn', mode: 'continuable' as const }
const oneShot = { name: 'subagent', provider: 'spawn', mode: 'one-shot' as const }
const cheap = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const strong = { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high' }
const args = { description: 'Add a slugify helper', prompt: 'Create src/slug.ts exporting slugify(text). Add tests.' }

const logs: string[] = []
function deps(subagents: FakeSubagents, overrides: Record<string, unknown> = {}): PipelineDeps {
  return {
    subagents,
    config: parsePluginConfig(overrides),
    logger: { info: message => logs.push(`info:${message}`), warn: message => logs.push(`warn:${message}`) },
  }
}
const signal = (): AbortSignal => new AbortController().signal

describe('parseDelegationArgs', () => {
  it('reads description, prompt and an explicit background request', () => {
    assert.deepEqual(parseDelegationArgs({ description: 'd', prompt: 'p' }), { description: 'd', prompt: 'p' })
    assert.deepEqual(parseDelegationArgs({ description: 'd', prompt: 'p', run_in_background: false }), { description: 'd', prompt: 'p', runInBackground: false })
  })

  it('rejects calls without both required strings', () => {
    assert.throws(() => parseDelegationArgs({ description: 'd' }), /needs string/)
    assert.throws(() => parseDelegationArgs(null), /needs string/)
    assert.throws(() => parseDelegationArgs({ description: 1, prompt: 'p' }), /needs string/)
  })
})

describe('helpers', () => {
  it('maps routes, flattens text and describes failures', () => {
    assert.deepEqual(toAgentOptions(cheap), { provider: 'openrouter', model: 'google/gemini-3.8-flash' })
    assert.deepEqual(toAgentOptions(strong), { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high' })
    assert.equal(flattenText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
    assert.equal(describeRoute(null), "the main agent's model")
    assert.equal(describeRoute(strong), 'azure-opencode-claude/claude-sonnet-5-5@high')
    assert.match(failureMessage(textResult('half', 'max-tokens', 'ran out')), /token limit[\s\S]*Diagnostic: ran out[\s\S]*half/)
    assert.match(failureMessage(textResult('', 'refusal')), /declined/)
    assert.match(failureMessage(textResult('', 'weird')), /ended abnormally \(weird\)/)
  })

  it('settle disposes the run and surfaces failures without losing either', async () => {
    const run = new FakeRun('r', textResult('ok'))
    assert.equal((await settle(run)).stopReason, 'completed')
    assert.equal(run.disposed, 1)

    const failing = new FakeRun('r2', new Error('boom'))
    failing.dispose = () => Promise.reject(new Error('dispose failed'))
    await assert.rejects(settle(failing), /boom.*dispose failed/s)
  })
})

describe('model-only orchestration', () => {
  it('keeps the continuable background scheduling and only changes the route', async () => {
    const subagents = new FakeSubagents({ results: [], maxDepth: 1 })
    const value = await orchestrate(deps(subagents), {
      tool, args, parent: fakeAgent(), signal: signal(),
      config: buildConfig({ subagentModel: cheap, reviewerEnabled: false, reviewerModel: null, remember: false }),
    })
    assert.deepEqual(value, { kind: 'continuable', subagentId: 'child-1' })
    assert.equal(subagents.starts.length, 0)
    const spec = subagents.continuables[0]
    assert.equal(spec?.provider, 'spawn')
    assert.equal(spec?.label, 'Add a slugify helper')
    const request = spec?.request as { prompt: { text: string }[]; agentOptions: unknown; maxDepth: number }
    assert.equal(request.prompt[0]?.text, args.prompt) // untouched: no handoff contract without a reviewer
    assert.deepEqual(request.agentOptions, { provider: 'openrouter', model: 'google/gemini-3.8-flash' })
    assert.equal(request.maxDepth, 1)
  })

  it('runs in the foreground when the model asked for it, or when the tool is one-shot', async () => {
    const config = buildConfig({ subagentModel: cheap, reviewerEnabled: false, reviewerModel: null, remember: false })
    for (const [selected, runInBackground] of [[tool, false], [oneShot, undefined]] as const) {
      const subagents = new FakeSubagents({ results: [textResult('done text')] })
      const value = await orchestrate(deps(subagents), {
        tool: selected, args: { ...args, ...runInBackground === undefined ? {} : { runInBackground } }, parent: fakeAgent(), signal: signal(), config,
      })
      assert.deepEqual(value, { kind: 'foreground', runId: 'run-1', output: [{ type: 'text', text: 'done text' }] })
      assert.equal(subagents.starts[0]?.run.disposed, 1)
      assert.equal(subagents.continuables.length, 0)
    }
  })

  it('reports a failed worker exactly like the stock tool', async () => {
    const subagents = new FakeSubagents({ results: [textResult('partial', 'error', 'provider 500')] })
    await assert.rejects(
      orchestrate(deps(subagents), {
        tool: oneShot, args, parent: fakeAgent(), signal: signal(),
        config: buildConfig({ subagentModel: cheap, reviewerEnabled: false, reviewerModel: null, remember: false }),
      }),
      /subagent run failed[\s\S]*provider 500[\s\S]*partial/,
    )
  })

  it('refuses a provider that cannot run on another model', async () => {
    const subagents = new FakeSubagents({ results: [], capabilities: { spawn: { agentOptions: false, persona: false } } })
    await assert.rejects(
      orchestrate(deps(subagents), {
        tool, args, parent: fakeAgent(), signal: signal(),
        config: buildConfig({ subagentModel: cheap, reviewerEnabled: false, reviewerModel: null, remember: false }),
      }),
      /cannot run a child on another model/,
    )
    const missing = new FakeSubagents({ results: [], capabilities: { spawn: undefined } })
    await assert.rejects(
      orchestrate(deps(missing), {
        tool, args, parent: fakeAgent(), signal: signal(),
        config: buildConfig({ subagentModel: cheap, reviewerEnabled: false, reviewerModel: null, remember: false }),
      }),
      /not registered/,
    )
  })
})

describe('reviewed orchestration', () => {
  const reviewedConfig = buildConfig({ subagentModel: cheap, reviewerEnabled: true, reviewerModel: strong, remember: false })

  it('hands the worker report to the reviewer and delivers ONLY the reviewer report', async () => {
    const subagents = new FakeSubagents({
      results: [
        textResult('WORKER-REPORT: created src/slug.ts and tests; ran node --test: 3 passed'),
        textResult('VERDICT: APPROVED_WITH_FIXES\nDELIVERABLE: slugify now handles unicode.\nVERIFICATION: node --test => 5 passed'),
      ],
      maxDepth: 1,
    })
    const value = await orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig })

    assert.equal(value.kind, 'foreground')
    const text = value.kind === 'foreground' ? value.output[0]?.text ?? '' : ''
    assert.match(text, /^Reviewed delivery: a subagent \(session run-1\) did the work and an independent reviewer \(session run-2\) verified it \[verdict: APPROVED_WITH_FIXES\]/)
    assert.match(text, /DELIVERABLE: slugify now handles unicode\./)
    // The worker's own report never reaches the main agent in reviewed mode.
    assert.equal(text.includes('WORKER-REPORT'), false)
    assert.equal(value.kind === 'foreground' ? value.runId : '', 'run-2')

    // Worker: user's route, task prompt plus the handoff contract, depth cap.
    const worker = subagents.starts[0]
    assert.equal(worker?.provider, 'spawn')
    assert.equal(worker?.request.label, 'Add a slugify helper')
    assert.deepEqual(worker?.request.agentOptions, { provider: 'openrouter', model: 'google/gemini-3.8-flash' })
    assert.equal(worker?.request.maxDepth, 1)
    const workerPrompt = promptText(worker?.request.prompt ?? [])
    assert.ok(workerPrompt.startsWith(args.prompt))
    assert.match(workerPrompt, /Delivery contract/)

    // Reviewer: its own route, a persona, the worker report as data, and a distinct label.
    const reviewer = subagents.starts[1]
    assert.equal(reviewer?.provider, 'spawn')
    assert.equal(reviewer?.request.label, 'Review: Add a slugify helper')
    assert.deepEqual(reviewer?.request.agentOptions, { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high' })
    assert.ok((reviewer?.request.persona ?? '').includes('independent REVIEWER'))
    const packet = promptText(reviewer?.request.prompt ?? [])
    assert.ok(packet.includes(args.prompt))
    assert.ok(packet.includes('WORKER-REPORT'))
    assert.equal(subagents.starts.every(started => started.run.disposed === 1), true)
    assert.equal(subagents.continuables.length, 0)
  })

  it('does not leak the worker model identity to the reviewer', async () => {
    const subagents = new FakeSubagents({ results: [textResult('report'), textResult('VERDICT: APPROVED\nok')] })
    await orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig })
    const packet = promptText(subagents.starts[1]?.request.prompt ?? [])
    assert.equal(packet.includes('gemini'), false)
    assert.equal(packet.includes('openrouter'), false)
  })

  it('inherits the parent route for the worker and the worker route for the reviewer when nothing is picked', async () => {
    const subagents = new FakeSubagents({ results: [textResult('report'), textResult('VERDICT: APPROVED\nok')] })
    await orchestrate(deps(subagents), {
      tool, args, parent: fakeAgent(), signal: signal(),
      config: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null, remember: false }),
    })
    assert.equal(subagents.starts[0]?.request.agentOptions, undefined)
    assert.equal(subagents.starts[1]?.request.agentOptions, undefined)

    const worker = new FakeSubagents({ results: [textResult('report'), textResult('VERDICT: APPROVED\nok')] })
    await orchestrate(deps(worker), {
      tool, args, parent: fakeAgent(), signal: signal(),
      config: buildConfig({ subagentModel: cheap, reviewerEnabled: true, reviewerModel: null, remember: false }),
    })
    assert.deepEqual(worker.starts[1]?.request.agentOptions, { provider: 'openrouter', model: 'google/gemini-3.8-flash' })
  })

  it('skips the handoff contract when workerHandoff is off and omits persona for providers without it', async () => {
    const subagents = new FakeSubagents({
      results: [textResult('report'), textResult('VERDICT: APPROVED\nok')],
      capabilities: { spawn: { agentOptions: true, persona: false } },
    })
    await orchestrate(deps(subagents, { workerHandoff: false }), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig })
    assert.equal(promptText(subagents.starts[0]?.request.prompt ?? []), args.prompt)
    assert.equal(subagents.starts[1]?.request.persona, undefined)
  })

  it('reports a worker that did not complete without starting a reviewer', async () => {
    const subagents = new FakeSubagents({ results: [textResult('partial work', 'max-tokens')] })
    await assert.rejects(orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig }), /token limit[\s\S]*partial work/)
    assert.equal(subagents.starts.length, 1)
  })

  it('delivers the raw worker report under an UNREVIEWED banner when the reviewer fails', async () => {
    for (const reviewerOutcome of [textResult('', 'error', 'boom'), textResult('   ', 'completed'), new Error('start exploded')]) {
      const subagents = new FakeSubagents({ results: [textResult('the worker report'), reviewerOutcome] })
      const value = await orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig })
      const text = value.kind === 'foreground' ? value.output[0]?.text ?? '' : ''
      assert.match(text, /^WARNING - UNREVIEWED: the independent review did not complete/)
      assert.match(text, /NOT verified/)
      assert.ok(text.endsWith('the worker report'))
      assert.equal(value.kind === 'foreground' ? value.runId : '', 'run-1')
    }
    assert.ok(logs.some(line => line.startsWith('warn:dsh-orquestrator: review of run-1 failed')))
  })

  it('falls back to UNREVIEWED when the reviewer cannot start at all', async () => {
    const subagents = new FakeSubagents({
      results: [textResult('worker report')],
      failStartAt: { index: 1, error: new Error('depth exceeded') },
    })
    const value = await orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig })
    assert.match(value.kind === 'foreground' ? value.output[0]?.text ?? '' : '', /depth exceeded/)
  })

  it('falls back to UNREVIEWED when the reviewer provider lacks the requested capability', async () => {
    const subagents = new FakeSubagents({
      results: [textResult('worker report')],
      capabilities: { review: { agentOptions: false, persona: false } },
    })
    const value = await orchestrate(deps(subagents, { reviewerProvider: 'review' }), { tool, args, parent: fakeAgent(), signal: signal(), config: reviewedConfig })
    assert.match(value.kind === 'foreground' ? value.output[0]?.text ?? '' : '', /cannot run on another model/)
  })

  it('propagates a caller cancellation instead of delivering anything', async () => {
    const controller = new AbortController()
    const subagents = new FakeSubagents({
      results: [
        () => { controller.abort(new Error('user stop')); return textResult('report') },
        textResult('never delivered'),
      ],
    })
    await assert.rejects(orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: controller.signal, config: reviewedConfig }), /user stop/)
    assert.equal(subagents.starts.length, 1)
  })

  it('does not treat a reviewer-time cancellation as a review failure', async () => {
    const controller = new AbortController()
    const subagents = new FakeSubagents({
      results: [textResult('report'), () => { controller.abort(new Error('user stop')); return new Error('aborted by signal') }],
    })
    await assert.rejects(orchestrate(deps(subagents), { tool, args, parent: fakeAgent(), signal: controller.signal, config: reviewedConfig }), /user stop/)
  })
})
