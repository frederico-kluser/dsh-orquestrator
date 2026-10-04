## T1: a spec with several easy-to-miss rules

The worker writes `duration.js` and its tests; the reviewer has to verify them. The ceilings are on (the default).

Models, and only these three: main agent GLM 5.3, subagent DeepSeek V4.1 Flash, reviewer MiMo-V2.6-Pro.
Produced by `scripts/e2e/run-trio.sh` (removed in 0.5.0 with the reviewer).

### The task the main agent was given

```text
Use the subagent tool exactly once to do this work: in the current directory create duration.js (CommonJS) exporting parseDuration(text) that converts a duration string to whole seconds. Rules: units are d, h, m and s (86400, 3600, 60 and 1 seconds); tokens look like 1d, 2h, 30m, 45s and may be separated by single spaces; units must appear in descending order d, h, m, s and each unit may appear at most once; whitespace inside a token (for example 1 h) is invalid; any invalid input, including an empty string and a non-string, must throw a TypeError whose message is exactly invalid duration; a total above 99 days must throw a RangeError whose message is exactly too long. Also create duration.test.js with node:test cases covering every rule, and run them with `node --test`. When the subagent tool returns, reply with its result verbatim and nothing else.
```

### What each session was asked (read back from the DSH session logs)

| Session | Role | Route | Reasoning effort | Max output tokens | Requests | Tool calls | Seconds | structured_output | Review packet |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `session-a040cc95` | main | openrouter/z-ai/glm-5.3 | high | (model window) | 1 | 1 | 254 | no | - |
| `fa3e4309-214d-47` | subagent | azure-opencode/DeepSeek-V4.1-Flash | medium | 64000 | 1 | 7 | 28 | no | - |
| `35177808-c80c-4f` | reviewer | openrouter-extra/xiaomi/mimo-v2.6-pro | medium | 32000 | 1 | 16 | 169 | yes | workspace facts, worker report withheld |

### What happened

Result: `exit=0 seconds=255`

| Session | Role | Model | Steps | Tool calls | Started (UTC) |
| --- | --- | --- | --- | --- | --- |
| `session-a040cc95` | main | openrouter/z-ai/glm-5.3 | 2 | 1 | 11:03:01 |
| `fa3e4309-214d-47` | subagent (depth 1) | azure-opencode/DeepSeek-V4.1-Flash | 8 | 7 | 11:03:31 |
| `35177808-c80c-4f` | subagent (depth 1) | openrouter-extra/xiaomi/mimo-v2.6-pro | 10 | 16 | 11:03:59 |

Main agent called `subagent` with `run_in_background: false`, description "Create duration.js with tests".

The `subagent` tool result the main agent received (first 900 characters):

```text
Reviewed delivery: a subagent (session fa3e4309-214d-4728-9fc1-3a882718605f) did the work and an independent reviewer (session 35177808-c80c-4f8f-936c-fe32847b1c3a) verified it [verdict: APPROVED]. The report below was written by the reviewer; treat it as the result of the delegated task. VERDICT: APPROVED - All spec rules verified by an independent 62-assertion conformance check and the full node:test suite (21/21 pass, 0 skipped); a mutation check confirmed the tests genuinely detect broken behavior, so no defects were found and nothing was changed. CRITERIA: - [VERIFIED] duration.js is a CommonJS module (module.exports) exporting a single function parseDuration(text) that returns whole seconds as a Number (Read duration.js (module.exports = parseDuration at line 48); independent-check asserted typeof function and typeof result === 'number' for valid inputs — 62 assertions, exit 0) - [...
```

Main agent final answer (first 400 characters):

```text
VERDICT: APPROVED - All spec rules verified by an independent 62-assertion conformance check and the full node:test suite (21/21 pass, 0 skipped); a mutation check confirmed the tests genuinely detect broken behavior, so no defects were found and nothing was changed. CRITERIA: - [VERIFIED] duration.js is a CommonJS module (module.exports) exporting a single function parseDuration(text) that return...
```

Workspace after the run: `README.md`, `duration.js`, `duration.test.js`
