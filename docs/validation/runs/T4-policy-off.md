## T4: the T1 task with the ceilings switched off

`effort: false` and `limits: false`: what DSH does by itself. The before to T1's after.

Models, and only these three: main agent GLM 5.3, subagent DeepSeek V4.1 Flash, reviewer MiMo-V2.6-Pro.
Produced by `scripts/e2e/run-trio.sh` (removed in 0.5.0 with the reviewer).

### The task the main agent was given

```text
Use the subagent tool exactly once to do this work: in the current directory create duration.js (CommonJS) exporting parseDuration(text) that converts a duration string to whole seconds. Rules: units are d, h, m and s (86400, 3600, 60 and 1 seconds); tokens look like 1d, 2h, 30m, 45s and may be separated by single spaces; units must appear in descending order d, h, m, s and each unit may appear at most once; whitespace inside a token (for example 1 h) is invalid; any invalid input, including an empty string and a non-string, must throw a TypeError whose message is exactly invalid duration; a total above 99 days must throw a RangeError whose message is exactly too long. Also create duration.test.js with node:test cases covering every rule, and run them with `node --test`. When the subagent tool returns, reply with its result verbatim and nothing else.
```

### What each session was asked (read back from the DSH session logs)

| Session | Role | Route | Reasoning effort | Max output tokens | Requests | Tool calls | Seconds | structured_output | Review packet |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `session-afc8059a` | main | openrouter/z-ai/glm-5.3 | high | (model window) | 1 | 1 | 258 | no | - |
| `b3e6b0c8-3d1a-42` | subagent | azure-opencode/DeepSeek-V4.1-Flash | max | 384000 | 1 | 18 | 63 | no | - |
| `bb686071-cb75-4e` | reviewer | openrouter-extra/xiaomi/mimo-v2.6-pro | max | 131072 | 1 | 13 | 128 | yes | workspace facts, worker report withheld |

### What happened

Result: `exit=0 seconds=259`

| Session | Role | Model | Steps | Tool calls | Started (UTC) |
| --- | --- | --- | --- | --- | --- |
| `session-afc8059a` | main | openrouter/z-ai/glm-5.3 | 2 | 1 | 11:14:01 |
| `b3e6b0c8-3d1a-42` | subagent (depth 1) | azure-opencode/DeepSeek-V4.1-Flash | 16 | 18 | 11:14:33 |
| `bb686071-cb75-4e` | subagent (depth 1) | openrouter-extra/xiaomi/mimo-v2.6-pro | 8 | 13 | 11:15:36 |

Main agent called `subagent` with `run_in_background: false`, description "Create and test duration parser".

The `subagent` tool result the main agent received (first 900 characters):

```text
Reviewed delivery: a subagent (session b3e6b0c8-3d1a-42dd-94a5-69e54ccac009) did the work and an independent reviewer (session bb686071-cb75-4e82-8c0c-9976befb26d7) verified it [verdict: APPROVED]. The report below was written by the reviewer; treat it as the result of the delegated task. VERDICT: APPROVED - Every requirement verified: duration.js and duration.test.js implement and cover all rules exactly, node --test passes 95/95 with exit 0, and mutation checks prove the tests are not vacuous. CRITERIA: - [VERIFIED] duration.js exists, is CommonJS (module.exports), and exports a single function parseDuration(text) that returns a whole number of seconds (Read duration.js (module.exports = parseDuration, line 68); probe `Number.isInteger(p('1d 2h'))` returned true; require('./duration') is a function of length 1.) - [VERIFIED] Units d/h/m/s are worth 86400/3600/60/1 seconds (duration.js ...
```

Main agent final answer (first 400 characters):

```text
Reviewed delivery: a subagent (session b3e6b0c8-3d1a-42dd-94a5-69e54ccac009) did the work and an independent reviewer (session bb686071-cb75-4e82-8c0c-9976befb26d7) verified it [verdict: APPROVED]. The report below was written by the reviewer; treat it as the result of the delegated task. VERDICT: APPROVED - Every requirement verified: duration.js and duration.test.js implement and cover all rules...
```

Workspace after the run: `README.md`, `duration.js`, `duration.test.js`
