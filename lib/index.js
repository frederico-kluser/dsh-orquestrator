import { closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region src/models.ts
/**
* Model knowledge shared by both bundles (host and browser): what reasoning
* effort a subagent should run at on each model, and the short notes the
* dialog shows next to a model. Pure data and pure functions, like
* `shared.ts`, because both bundles inline this file.
*
* Every row of {@link MODEL_PROFILES} is dated and names the studies it comes
* from (`docs/estudos/`). It is advice, never a block: the user's pick in the
* dialog always wins over it, and an unknown model simply falls back to the
* generic ceiling.
* @module dsh-orquestrator/models
*/
/**
* Reasoning levels in DSH's canonical escalation order (pi-ai's thinking
* levels). A model's own ladder is a subset of these, in this order.
*/
const EFFORT_ORDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** The official DeepSeek route id in DSH (`llm-deepseek`). */
const OFFICIAL_DEEPSEEK = "deepseek-official";
/** Model id lowercased, vendor prefix kept. */
function lowered(route) {
	return route.model.trim().toLowerCase().replaceAll("_", "-");
}
/** Model id lowercased with any `vendor/` prefix removed. */
function bare(route) {
	const id = lowered(route);
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}
/** The V4.1 Flash line, under every spelling DSH catalogs carry. */
function isDeepSeekFlashLine(route) {
	const id = bare(route);
	return /^deepseek-(v4(\.1)?-)?flash/.test(id) && !id.includes("vision");
}
/**
* Dated model advice, most specific row first. Evidence behind each row is in
* `docs/estudos/` (ids E01 to E16) and in the DeepSeek release notice of
* 2026-09-10.
*/
const MODEL_PROFILES = Object.freeze([
	{
		id: "deepseek-v4-pro-official",
		matches: (route) => route.provider === OFFICIAL_DEEPSEEK && bare(route) === "deepseek-v4-pro",
		cap: "medium",
		notes: ["redirected", "overthinks"],
		verifiedAt: "2026-10-03",
		sources: [
			"E05",
			"E07",
			"E08",
			"E10",
			"E11",
			"api-docs.deepseek.com/news/news260910"
		]
	},
	{
		id: "deepseek-flash",
		matches: isDeepSeekFlashLine,
		cap: "medium",
		notes: ["overthinks"],
		verifiedAt: "2026-10-03",
		sources: [
			"E01",
			"E03",
			"E05",
			"E07",
			"E08",
			"E10",
			"E11",
			"E12",
			"E13"
		]
	},
	{
		id: "mimo-ultraspeed",
		matches: (route) => /mimo.*ultraspeed/.test(lowered(route)),
		cap: "low",
		notes: ["premiumVariant"],
		verifiedAt: "2026-10-03",
		sources: [
			"E01",
			"E02",
			"E13"
		]
	},
	{
		id: "mimo",
		matches: (route) => /mimo/.test(lowered(route)),
		cap: "low",
		notes: ["slowAtHighEffort"],
		verifiedAt: "2026-10-03",
		sources: [
			"E01",
			"E02",
			"E03",
			"E05",
			"E07",
			"E08",
			"E09",
			"E11",
			"E12",
			"E13"
		]
	},
	{
		id: "glm-flash",
		matches: (route) => /glm-5[.-]3-flash/.test(lowered(route)),
		cap: "high",
		notes: ["reasoningAlwaysOn"],
		verifiedAt: "2026-10-03",
		sources: [
			"E01",
			"E05",
			"E11"
		]
	},
	{
		id: "glm",
		matches: (route) => /glm-5[.-]3/.test(lowered(route)),
		cap: "high",
		notes: ["textOnly", "reasoningAlwaysOn"],
		verifiedAt: "2026-10-03",
		sources: [
			"E01",
			"E02",
			"E05",
			"E06",
			"E08"
		]
	},
	{
		id: "claude-large",
		matches: (route) => /claude-(sonnet|opus)/.test(lowered(route)),
		cap: "high",
		notes: ["maxEffortRegresses"],
		verifiedAt: "2026-10-03",
		sources: [
			"E02",
			"E04",
			"E09"
		]
	},
	{
		id: "claude-haiku",
		matches: (route) => /claude-haiku/.test(lowered(route)),
		cap: "medium",
		notes: [],
		verifiedAt: "2026-10-03",
		sources: [
			"E03",
			"E07",
			"E09",
			"E10"
		]
	},
	{
		id: "gemini-flash",
		matches: (route) => /gemini-.*flash/.test(lowered(route)),
		cap: "medium",
		notes: [],
		verifiedAt: "2026-10-03",
		sources: [
			"E07",
			"E10",
			"E13"
		]
	}
]);
/**
* The advice row for a route.
* @param route - provider and model id.
* @returns the first matching profile, or undefined for an unknown model.
*/
function profileOf(route) {
	return MODEL_PROFILES.find((profile) => profile.matches(route));
}
/**
* Position of a level in the canonical order.
* @param level - a reasoning level id.
* @returns its rank, or -1 for an id DSH does not define.
*/
function rankOf(level) {
	return EFFORT_ORDER.indexOf(level);
}
/**
* Whether a string is one of the canonical reasoning levels.
* @param value - candidate.
* @returns true for `off` through `max`.
*/
function isEffortLevel(value) {
	return typeof value === "string" && rankOf(value) !== -1;
}
/**
* The ceiling for a subagent on one route.
* @param route - the route the child will run on.
* @param override - the operator's configured ceiling, which beats the profile.
* @returns the highest level the plugin will pick on its own.
*/
function capFor(route, override) {
	if (override !== void 0 && isEffortLevel(override)) return override;
	return (route === void 0 ? void 0 : profileOf(route)?.cap) ?? "medium";
}
/**
* Decide the reasoning effort for one child. An explicit, supported level wins
* (the user chose it). Otherwise the level the route would use is kept when it
* is within the ceiling, and lowered to the highest offered level not above
* the ceiling when it is not; `off` is never picked on its own. A model's
* ladder may skip rungs (GLM offers low, high and max), hence "highest not
* above" instead of an exact match.
* @param input - ladder, current level, explicit level and ceiling.
* @returns the level to send (or undefined) and why.
*/
function chooseEffort(input) {
	const { ladder, current, explicit, cap } = input;
	if (ladder === void 0) return {
		effort: explicit,
		reason: explicit === void 0 ? "no-ladder" : "explicit"
	};
	if (ladder.length === 0) return {
		effort: void 0,
		reason: "no-reasoning",
		...explicit === void 0 ? {} : { dropped: explicit }
	};
	let dropped;
	if (explicit !== void 0) {
		if (ladder.includes(explicit)) return {
			effort: explicit,
			reason: "explicit"
		};
		dropped = explicit;
	}
	const note = dropped === void 0 ? {} : { dropped };
	const capRank = rankOf(cap);
	if (current !== void 0 && rankOf(current) !== -1 && capRank !== -1 && rankOf(current) <= capRank) return {
		effort: void 0,
		reason: "within-cap",
		...note
	};
	const usable = ladder.filter((level) => rankOf(level) > 0).sort((a, b) => rankOf(a) - rankOf(b));
	if (usable.length === 0) return {
		effort: void 0,
		reason: "no-reasoning",
		...note
	};
	const atOrBelow = capRank === -1 ? [] : usable.filter((level) => rankOf(level) <= capRank);
	return {
		effort: atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : usable[0],
		reason: "capped",
		...note
	};
}
//#endregion
//#region src/shared.ts
/** Route prefix owned by this plugin on the composition's web server. */
const ROUTE_PREFIX = "/dsh-orquestrator";
/** Session configuration route: `GET ?sessionId=<id>` reads, `POST` writes or clears. */
const CONFIG_ROUTE = `${ROUTE_PREFIX}/config`;
/** Subagent ledger route: `GET ?sessionId=<id>` lists the subagents started under that session, with their model and outcome. */
const SUBAGENTS_ROUTE = `${ROUTE_PREFIX}/subagents`;
/**
* The global skill this plugin registers with DSH's skill registry. The kebab-case name is the `/name` token DSH
* expands into the skill's instructions, and the token the dialog adds to a message when the user ticks the skill.
*/
const SKILL_NAME = "orchestrate-subagents";
Object.freeze({
	version: 1,
	subagentModel: null,
	workerEffort: null
});
/**
* Whether a configuration changes anything relative to stock DSH.
* @param config - a session configuration, or null/undefined for "none".
* @returns true when a different subagent model or an explicit reasoning level is set.
*/
function isActive(config) {
	return config != null && (config.subagentModel !== null || config.workerEffort !== null);
}
/**
* The reviewer block 0.2 to 0.4 sent and validated strictly, kept on the wire as a disabled no-op.
*
* The two halves of this plugin load at different moments: the host half when `dsh` starts, the browser half when
* the page loads. A user who updates the plugin and refreshes the page without restarting runs a new browser against
* an old host, and a tab opened before a restart runs an old browser against a new host. 0.2 to 0.4 refused a
* configuration without this block ("config does not match the expected shape") and, in the browser, an answer
* without it, so either mix could not save anything. Both ends therefore keep sending it. 0.5 reads and ignores it;
* it is never stored. Drop it once nobody runs 0.4 any more.
*/
const LEGACY_REVIEWER = Object.freeze({
	enabled: false,
	model: null,
	effort: null
});
/**
* Put a configuration in the shape every version of the plugin accepts.
* @param config - a validated configuration.
* @returns the same fields plus {@link LEGACY_REVIEWER}; the input is not modified.
*/
function toWireConfig(config) {
	return {
		...config,
		reviewer: LEGACY_REVIEWER
	};
}
/** Longest provider/model/effort id the validator admits (defensive bound). */
const MAX_ID_LENGTH = 256;
/** A plain object check that also excludes arrays. */
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A bounded, non-empty, control-character-free identifier string. */
function isId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}
/**
* Parse an optional reasoning-effort id from untrusted JSON. Absent and null
* both mean "the recommended level", so configurations written before the
* field existed still load.
* @param value - candidate value.
* @returns the id wrapped (null when none), or undefined when malformed.
*/
function parseEffort(value) {
	if (value === null || value === void 0) return { value: null };
	return isId(value) ? { value } : void 0;
}
/**
* Parse one model route from untrusted JSON.
* @param value - candidate value.
* @returns the normalized route, or undefined when malformed.
*/
function parseModelRoute(value) {
	if (!isRecord$1(value) || !isId(value["provider"]) || !isId(value["model"])) return void 0;
	const effort = value["reasoningEffort"];
	if (effort !== void 0 && !isId(effort)) return void 0;
	return effort === void 0 ? {
		provider: value["provider"],
		model: value["model"]
	} : {
		provider: value["provider"],
		model: value["model"],
		reasoningEffort: effort
	};
}
/**
* Parse a session configuration from untrusted JSON (request body, disk or the browser's memory).
* Records written by 0.4.0 and older carry a `reviewer` block (and 0.2.x a `remember` flag): the reviewer was removed
* in 0.5.0, so those fields are accepted and dropped, never a reason to lose the model the user picked.
* @param value - candidate value.
* @returns the normalized configuration, or undefined when malformed.
*/
function parseConfig(value) {
	if (!isRecord$1(value) || value["version"] !== 1) return void 0;
	const rawSubagent = value["subagentModel"];
	const subagentModel = rawSubagent === null || rawSubagent === void 0 ? null : parseModelRoute(rawSubagent);
	if (subagentModel === void 0) return void 0;
	const workerEffort = parseEffort(value["workerEffort"]);
	if (workerEffort === void 0) return void 0;
	return {
		version: 1,
		subagentModel,
		workerEffort: workerEffort.value
	};
}
/**
* Map a terminal stop reason of DSH's subagent seam to a state. The reason set is merge-extensible, so an unknown
* reason counts as a failure, as DSH's own consumers treat it.
* @param stopReason - `completed`, `aborted`, `error`, `max-tokens`, `refusal` or a reason a backend added.
* @returns the terminal state.
*/
function subagentStateOf(stopReason) {
	if (stopReason === "completed") return "done";
	if (stopReason === "aborted") return "stopped";
	return "failed";
}
const SUBAGENT_STATES = /* @__PURE__ */ new Set([
	"running",
	"done",
	"failed",
	"stopped"
]);
/** A finite, non-negative epoch-milliseconds value. */
function isTime(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/**
* Parse one subagent record from untrusted JSON.
* @param value - candidate record.
* @returns the normalized record, or undefined when malformed.
*/
function parseSubagentRecord(value) {
	if (!isRecord$1(value) || !isId(value["id"]) || !isId(value["backend"])) return void 0;
	const state = value["state"];
	if (typeof state !== "string" || !SUBAGENT_STATES.has(state)) return void 0;
	const parentId = value["parentId"] ?? null;
	if (parentId !== null && !isId(parentId)) return void 0;
	const rawRoute = value["route"] ?? null;
	const route = rawRoute === null ? null : parseModelRoute(rawRoute);
	if (route === void 0) return void 0;
	const stopReason = value["stopReason"] ?? null;
	if (stopReason !== null && !isId(stopReason)) return void 0;
	const endedAt = value["endedAt"] ?? null;
	if (!isTime(value["startedAt"]) || endedAt !== null && !isTime(endedAt)) return void 0;
	return {
		id: value["id"],
		parentId,
		backend: value["backend"],
		route,
		state,
		stopReason,
		startedAt: value["startedAt"],
		endedAt
	};
}
//#endregion
//#region src/config.ts
/**
* Deployment configuration of the host half. Every tunable is a validated
* `Config` field overridable from `cordis.patch.yml`; a malformed value fails
* loud at load (never a silent permissive fallback). Fields that belonged to
* the independent reviewer, removed in 0.5.0, are ignored with a warning
* instead of failing the load, so an existing patch file keeps working.
* @module dsh-orquestrator/config
*/
/** Every top-level field of the configuration. */
const KNOWN_FIELDS = /* @__PURE__ */ new Set([
	"defaults",
	"stateDir",
	"persist",
	"maxSessions",
	"effort",
	"limits",
	"children",
	"skill"
]);
/** Top-level fields that existed until 0.4.0 for the reviewer and the tool wrapper, and do nothing now. */
const REMOVED_FIELDS = /* @__PURE__ */ new Set([
	"tools",
	"reviewerProvider",
	"reviewerContext",
	"structuredVerdict",
	"workerHandoff",
	"maxWorkerReportChars",
	"retryOnTokenLimit",
	"workspaceChecks",
	"sensitivePaths"
]);
/** Where a field that belongs inside a block most often ends up when it is mis-indented to the top level. */
const MISPLACED = Object.freeze({
	explicitModel: "children.explicitModel",
	worker: "effort.worker",
	workerMaxTokens: "limits.workerMaxTokens",
	subagentModel: "defaults.subagentModel",
	workerEffort: "defaults.workerEffort",
	modelInvocable: "skill.modelInvocable"
});
/** A plain object check that also excludes arrays. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* The top-level fields the plugin does not know, with a hint where the field most likely belongs. A typo or a
* mis-indented key is otherwise ignored without a word, and the default quietly replaces the intent (a mis-indented
* `explicitModel: keep` runs as `override`).
* @param raw - the plugin's `config` from the loader.
* @returns one message per unknown field, empty when there is none.
*/
function unknownConfigFields(raw) {
	if (!isRecord(raw)) return [];
	return Object.keys(raw).filter((key) => !KNOWN_FIELDS.has(key) && !REMOVED_FIELDS.has(key)).map((key) => `unknown config field "${key}" is ignored${MISPLACED[key] === void 0 ? "" : ` (did you mean ${MISPLACED[key]}?)`}`);
}
/**
* The fields of a configuration written for 0.4.0 or older that belonged to the independent reviewer (and to the
* delegation-tool wrapper it needed). They are ignored; saying so beats a silent no-op.
* @param raw - the plugin's `config` from the loader.
* @returns one message per ignored field, empty when there is none.
*/
function removedConfigFields(raw) {
	if (!isRecord(raw)) return [];
	const found = [];
	for (const key of Object.keys(raw)) if (REMOVED_FIELDS.has(key)) found.push(key);
	if (isRecord(raw["defaults"]) && raw["defaults"]["reviewer"] !== void 0) found.push("defaults.reviewer");
	if (isRecord(raw["effort"]) && raw["effort"]["reviewer"] !== void 0) found.push("effort.reviewer");
	if (isRecord(raw["limits"]) && raw["limits"]["reviewerMaxTokens"] !== void 0) found.push("limits.reviewerMaxTokens");
	return found.map((field) => `config field "${field}" belonged to the independent reviewer, removed in 0.5.0, and is ignored`);
}
/** Default output-token ceiling: far below the 384K-943K some routes allow, far above any legitimate single step. */
const DEFAULT_LIMITS = Object.freeze({ worker: 64e3 });
/** Fail-loud helper: a configuration error names the field and the plugin. */
function invalid(field, detail) {
	return /* @__PURE__ */ new Error(`dsh-orquestrator: invalid config field "${field}": ${detail}`);
}
/** A positive safe integer, or the default when absent. */
function positiveInt(field, value, fallback) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid(field, "must be a positive integer");
	return value;
}
/** A boolean, or the default when absent. */
function bool(field, value, fallback) {
	if (value === void 0) return fallback;
	if (typeof value !== "boolean") throw invalid(field, "must be a boolean");
	return value;
}
/** A canonical reasoning level, or undefined when absent. */
function level(field, value) {
	if (value === void 0) return void 0;
	if (!isEffortLevel(value)) throw invalid(field, "must be one of off, minimal, low, medium, high, xhigh, max");
	return value;
}
/** An output-token ceiling: a positive integer, `false` (none), or the default when absent. */
function ceiling(field, value, fallback) {
	if (value === void 0) return fallback;
	if (value === false) return void 0;
	return positiveInt(field, value, fallback);
}
/**
* Validate the raw configuration and resolve every default.
* @param raw - the plugin's `config` from the loader (may be undefined).
* @returns the validated configuration.
* @throws {Error} naming the offending field when the value is malformed.
*/
function parsePluginConfig(raw) {
	const config = raw ?? {};
	let defaults = null;
	if (config.defaults !== void 0) {
		const subagentModel = config.defaults.subagentModel === void 0 ? null : parseModelRoute(config.defaults.subagentModel);
		if (subagentModel === void 0) throw invalid("defaults.subagentModel", "needs non-empty \"provider\" and \"model\"");
		const workerEffort = level("defaults.workerEffort", config.defaults.workerEffort) ?? null;
		if (subagentModel !== null || workerEffort !== null) defaults = {
			version: 1,
			subagentModel,
			workerEffort
		};
	}
	if (config.stateDir !== void 0 && (typeof config.stateDir !== "string" || config.stateDir.trim() === "")) throw invalid("stateDir", "must be a non-empty string");
	return {
		defaults,
		stateDir: config.stateDir,
		persist: bool("persist", config.persist, true),
		maxSessions: positiveInt("maxSessions", config.maxSessions, 500),
		effort: parseEffortPolicy(config.effort),
		limits: parseLimits(config.limits),
		guard: parseGuard(config.children),
		skill: parseSkill(config.skill)
	};
}
/** Resolve the `effort` block. */
function parseEffortPolicy(raw) {
	if (raw === void 0) return { enabled: true };
	if (raw === false) return { enabled: false };
	if (!isRecord(raw)) throw invalid("effort", "must be false or an object with worker");
	const worker = level("effort.worker", raw["worker"]);
	return {
		enabled: true,
		...worker === void 0 ? {} : { cap: worker }
	};
}
/** Resolve the `limits` block. */
function parseLimits(raw) {
	if (raw === void 0) return { worker: DEFAULT_LIMITS.worker };
	if (raw === false) return { worker: void 0 };
	if (!isRecord(raw)) throw invalid("limits", "must be false or an object");
	return { worker: ceiling("limits.workerMaxTokens", raw["workerMaxTokens"], DEFAULT_LIMITS.worker) };
}
/** Resolve the `children` block (the start guard). Unknown keys fail loud: a typo must not silently keep the default. */
function parseGuard(raw) {
	if (raw === void 0) return {
		enabled: true,
		explicitModel: "override"
	};
	if (raw === false) return {
		enabled: false,
		explicitModel: "override"
	};
	if (!isRecord(raw)) throw invalid("children", "must be false or an object");
	for (const key of Object.keys(raw)) if (key !== "explicitModel") throw invalid(`children.${key}`, "is not a known field (explicitModel)");
	const explicitModel = raw["explicitModel"] ?? "override";
	if (explicitModel !== "override" && explicitModel !== "keep") throw invalid("children.explicitModel", "must be \"override\" or \"keep\"");
	return {
		enabled: true,
		explicitModel
	};
}
/** Resolve the `skill` block (the global skill). Unknown keys fail loud: a typo must not silently keep the default. */
function parseSkill(raw) {
	if (raw === void 0) return {
		enabled: true,
		modelInvocable: true
	};
	if (raw === false) return {
		enabled: false,
		modelInvocable: true
	};
	if (!isRecord(raw)) throw invalid("skill", "must be false or an object");
	for (const key of Object.keys(raw)) if (key !== "modelInvocable") throw invalid(`skill.${key}`, "is not a known field (modelInvocable)");
	return {
		enabled: true,
		modelInvocable: bool("skill.modelInvocable", raw["modelInvocable"], true)
	};
}
//#endregion
//#region src/effort.ts
/**
* The effort and token policy of a configuration.
* @param config - the validated plugin configuration.
* @returns the policy the planner reads.
*/
function childPolicyOf(config) {
	return {
		enabled: config.effort.enabled,
		...config.effort.cap === void 0 ? {} : { cap: config.effort.cap },
		maxTokens: config.limits.worker
	};
}
/**
* The route, level and token ceiling the parent would hand to a child. Mirrors
* DSH's own resolution: the latest request header owns provider, model and
* effort once a request ran; creation options are the fallback.
* @param parent - the delegating agent.
* @returns detached options.
*/
function parentOptionsOf(parent) {
	const requested = parent.session.requestHeader?.()?.config;
	if (requested === void 0) return { ...parent.options };
	const { provider: _provider, model: _model, reasoningEffort: _effort, ...created } = parent.options;
	return {
		...created,
		...requested.provider === void 0 ? {} : { provider: requested.provider },
		...requested.model === void 0 ? {} : { model: requested.model },
		...requested.reasoningEffort === void 0 ? {} : { reasoningEffort: requested.reasoningEffort }
	};
}
/** The options exactly as the user picked them, without the policy. */
function untouched(route, explicitEffort) {
	const options = {
		...route === null ? {} : {
			provider: route.provider,
			model: route.model
		},
		...explicitEffort === void 0 ? {} : { reasoningEffort: explicitEffort }
	};
	return Object.keys(options).length === 0 ? void 0 : options;
}
/** A confirmed choice that cannot be honored (its model is gone): reported to the caller, never silently replaced by another model. */
var ChoiceUnusableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ChoiceUnusableError";
	}
};
/**
* Refuse to run a child on a route the user confirmed and the LLM runtime can no longer call. A model that merely could
* not be described is not enough to refuse: the route must also fail the check that gates storing a route
* (`resolveCallConfig`) when the runtime offers it, so an adapter that cannot describe a model it can call keeps
* working. Without that check the failed description stands as the reason.
* @param source - the LLM runtime.
* @param route - the route the user confirmed.
* @param plan - the plan made for it.
* @param signal - the caller's cancellation.
* @throws {ChoiceUnusableError} when the route cannot be used.
* @throws the cancellation reason when the caller cancelled.
*/
async function assertChoiceUsable(source, route, plan, signal) {
	if (plan.unresolved === void 0) return;
	let reason = plan.unresolved;
	if (source?.resolveCallConfig !== void 0) try {
		await abortable(source.resolveCallConfig({
			provider: route.provider,
			model: route.model
		}, signal), signal);
		return;
	} catch (error) {
		if (signal.aborted) throw abortReason(signal);
		reason = error instanceof Error ? error.message : String(error);
	}
	throw new ChoiceUnusableError(`dsh-orquestrator: the subagent model ${route.provider}/${route.model} cannot be used (${reason}). Open /orquestrar to pick another model, or cancel the dialog to run subagents as DSH does.`);
}
/** The error to raise for a cancelled call: always an Error, whatever the signal's reason was. */
function abortReason(signal) {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error(typeof reason === "string" && reason !== "" ? reason : "the call was aborted");
}
/**
* Wait for a lookup unless the caller cancels first. A lookup that ignores its signal (a custom adapter that does
* IO) must not leave a cancelled start pending.
* @param lookup - the pending lookup.
* @param signal - the caller's cancellation.
* @returns the lookup's value.
* @throws the cancellation reason as an Error, or the lookup's own failure.
*/
function abortable(lookup, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			lookup.catch(() => void 0);
			reject(abortReason(signal));
			return;
		}
		const onAbort = () => {
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		lookup.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
/**
* Plan one child. Never throws, except for the caller's cancellation: when
* the model cannot be described the plan degrades to the user's own pick,
* which is what the plugin did before, and says why in `unresolved`.
* @param input - the route, policy and LLM runtime.
* @returns the plan.
* @throws the cancellation reason when the caller cancelled while the model was being described.
*/
async function planChild(input) {
	const { source, parent, route, explicitEffort, policy, signal, logger } = input;
	const inherited = parentOptionsOf(parent);
	const unchanged = route === null || inherited.provider === route.provider && inherited.model === route.model;
	const target = route !== null ? {
		provider: route.provider,
		model: route.model
	} : inherited.provider !== void 0 && inherited.model !== void 0 ? {
		provider: inherited.provider,
		model: inherited.model
	} : void 0;
	const fallback = (why, unresolved) => ({
		options: untouched(route, explicitEffort),
		route: target,
		ladder: void 0,
		effective: explicitEffort,
		...unresolved === void 0 ? {} : { unresolved },
		summary: `${target === void 0 ? "inherited route" : `${target.provider}/${target.model}`}, effort left as picked (${why})`
	});
	if (!policy.enabled) return fallback("policy off");
	if (target === void 0 || source === void 0) return fallback("route or runtime unknown");
	let info;
	try {
		if (signal.aborted) throw abortReason(signal);
		info = await abortable(source.resolveModelInfo(target.provider, target.model, signal), signal);
	} catch (error) {
		if (signal.aborted) throw abortReason(signal);
		const reason = error instanceof Error ? error.message : String(error);
		logger.warn(`dsh-orquestrator: cannot describe ${target.provider}/${target.model} (${reason}); its effort is left as picked`);
		return fallback("model not describable", reason);
	}
	const ladder = info.reasoning === void 0 ? [] : info.reasoning.efforts.map((effort) => effort.id);
	const current = unchanged ? inherited.reasoningEffort ?? info.reasoning?.defaultEffort : info.reasoning?.defaultEffort;
	const cap = capFor(target, policy.cap);
	const choice = chooseEffort({
		ladder,
		current,
		explicit: explicitEffort,
		cap
	});
	if (choice.dropped !== void 0) logger.warn(`dsh-orquestrator: ${target.provider}/${target.model} does not offer reasoning effort "${choice.dropped}"; using the recommended level instead`);
	const options = {
		...route === null ? {} : {
			provider: route.provider,
			model: route.model
		},
		...choice.effort === void 0 ? {} : { reasoningEffort: choice.effort }
	};
	const limit = policy.maxTokens;
	const ceiling = inherited.maxTokens ?? info.defaultMaxTokens;
	if (limit !== void 0 && ceiling !== void 0 && ceiling > limit) options.maxTokens = info.defaultMaxTokens === void 0 ? limit : Math.min(limit, info.defaultMaxTokens);
	const effective = choice.effort ?? current;
	return {
		options: Object.keys(options).length === 0 ? void 0 : options,
		route: target,
		ladder,
		effective,
		summary: `${target.provider}/${target.model}, effort ${effective ?? "route default"} (${choice.reason}, ceiling ${cap}), max output ${options.maxTokens === void 0 ? "unchanged" : String(options.maxTokens)}`
	};
}
//#endregion
//#region src/guard.ts
/** Cordis' registered symbol under which a service proxy yields the instance behind it. */
const CORDIS_ORIGINAL = Symbol.for("cordis.original");
/**
* Registered key of the own, enumerable property that marks a request the guard already planned. Object spread copies
* enumerable own symbols, so a wrapper stacked above the guard that normalizes the request with `{ ...request }` cannot
* strip the mark. It is put on the copy the guard hands to DSH, never on the caller's own object, so a second live guard
* (another copy of the plugin) plans each child once and the newer configuration wins.
*/
const GOVERNED_KEY = Symbol.for("dsh-orquestrator.governed");
/**
* Whether the guard already planned a start request, or the one it was copied from.
* @param request - a request or continuable spec.
* @returns true for a request the guard produced.
*/
function isGoverned(request) {
	return request[GOVERNED_KEY] === true;
}
/** Mark the guard's own copy as planned (the copy is always extensible). */
function markGoverned(request) {
	Object.defineProperty(request, GOVERNED_KEY, {
		value: true,
		enumerable: true,
		configurable: true
	});
	return request;
}
/**
* The route a caller named for one child through `agentOptions`, completed from the route the child would otherwise
* have: the provider's own when it declares one (the SDK provider), else the parent's.
*/
function namedRoute(requested, parent, providerRoute) {
	if (requested === void 0 || requested.provider === void 0 && requested.model === void 0) return void 0;
	const inherited = providerRoute ?? parentOptionsOf(parent);
	const provider = requested.provider ?? inherited.provider;
	const model = requested.model ?? inherited.model;
	if (provider === void 0 || model === void 0) return void 0;
	return {
		provider,
		model,
		...requested.reasoningEffort === void 0 ? {} : { reasoningEffort: requested.reasoningEffort }
	};
}
/** Never raise a token limit the caller (an operator's tool row, a team roster) set: the smaller of the caller's and the plan's stands. */
function keepSmallerLimit(requested, options) {
	if (requested?.maxTokens === void 0) return options;
	return {
		...options,
		maxTokens: options.maxTokens === void 0 ? requested.maxTokens : Math.min(requested.maxTokens, options.maxTokens)
	};
}
/**
* The caller's own options with the plan on top; a smaller token limit the caller asked for stands.
* The effort comes from the plan alone: the planner already took the caller's level as the explicit one,
* kept it when the model offers it and dropped it when it does not, so spreading the caller's level back in
* would resurrect exactly the level the planner refused, and the child would fail its first model call.
*/
function mergeCaller(requested, planned) {
	const { reasoningEffort: _callerEffort, ...rest } = requested ?? {};
	return keepSmallerLimit(requested, {
		...rest,
		...planned
	});
}
/**
* Decide the `agentOptions` of a child.
*
* Three cases, by who named the route:
* - the user picked a subagent model and the caller named none (or `explicitModel` is `override`): the child gets the
*   user's route and effort, and the caller's route-specific options are dropped (an effort chosen for another model
*   must not travel to this one);
* - the caller named a model and the user picked none (or `explicitModel` is `keep`): the caller's model stands and
*   gets the same effort ceiling and token cap;
* - nobody named a route (an effort-only choice, such as `defaults.workerEffort` alone): the child stays on the
*   parent's route, under the ceilings.
* @param deps - host services and configuration.
* @param providerName - the provider the child will run on.
* @param input - parent, the caller's `agentOptions` and cancellation.
* @returns the options to start the child with, or undefined to leave the request exactly as it is.
* @throws when the call was cancelled while the model was being described.
*/
async function governedOptions(deps, providerName, input) {
	const { parent, agentOptions, signal } = input;
	const sessionId = parent?.session?.id;
	if (parent === void 0 || typeof sessionId !== "string") return void 0;
	const choice = deps.store.resolve(sessionId, deps.parentOf, deps.defaults);
	if (!isActive(choice)) return void 0;
	const provider = deps.subagents.getProvider(providerName);
	if (provider === void 0) return void 0;
	if (!provider.capabilities.agentOptions) {
		if (deps.warned === void 0 || !deps.warned.has(providerName)) {
			deps.warned?.add(providerName);
			deps.logger.warn(`dsh-orquestrator: provider "${providerName}" cannot run a child on another model or effort; its children keep the options DSH gives them`);
		}
		return;
	}
	const named = namedRoute(agentOptions, parent, provider.agentRouteDefaults);
	const keepNamed = named !== void 0 && (choice.subagentModel === null || deps.config.guard.explicitModel === "keep");
	const userRoute = !keepNamed && choice.subagentModel !== null;
	const route = keepNamed ? named : choice.subagentModel;
	if (route === null && provider.agentRouteDefaults !== void 0) return void 0;
	const explicitEffort = keepNamed ? named.reasoningEffort ?? (choice.subagentModel === null ? choice.workerEffort ?? void 0 : void 0) : route === null ? choice.workerEffort ?? agentOptions?.reasoningEffort : choice.workerEffort ?? route.reasoningEffort;
	const source = deps.models();
	const plan = await planChild({
		source,
		parent,
		route,
		policy: childPolicyOf(deps.config),
		signal,
		logger: deps.logger,
		explicitEffort
	});
	if (userRoute && route !== null) await assertChoiceUsable(source, route, plan, signal);
	if (plan.options === void 0) return agentOptions?.reasoningEffort === void 0 ? void 0 : mergeCaller(agentOptions, {});
	deps.logger.info(`dsh-orquestrator: child of session ${sessionId} on provider ${providerName}: ${plan.summary}`);
	return userRoute ? keepSmallerLimit(agentOptions, plan.options) : mergeCaller(agentOptions, plan.options);
}
/** Whether a value has the shape of a start request the guard can read. */
function isRequestLike(value) {
	return typeof value === "object" && value !== null;
}
/**
* Apply {@link governedOptions} to a start request, without failing the start because of the guard's own trouble.
* @param deps - host services and configuration.
* @param providerName - the provider the child will run on.
* @param request - the request (or continuable request) as the caller built it.
* @param signal - the caller's cancellation.
* @returns a marked copy with the planned `agentOptions`, or undefined when nothing changes.
* @throws when the caller cancelled, or when the confirmed subagent model cannot be used ({@link ChoiceUnusableError}).
*/
async function governRequest(deps, providerName, request, signal) {
	try {
		const options = await governedOptions(deps, providerName, {
			parent: request.parent,
			agentOptions: request.agentOptions,
			signal: signal ?? new AbortController().signal
		});
		return options === void 0 ? void 0 : markGoverned({
			...request,
			agentOptions: options
		});
	} catch (error) {
		if (error instanceof ChoiceUnusableError) throw error;
		if (signal?.aborted === true) throw error instanceof Error ? error : new Error(String(error));
		deps.logger.warn(`dsh-orquestrator: could not apply the confirmed choice to a child (${error instanceof Error ? error.message : String(error)}); DSH starts it with its own options`);
		return;
	}
}
/**
* Put an own wrapper over one method of the service instance.
* @param target - the service instance.
* @param name - the method to wrap.
* @param make - builds the wrapper from the original method and a liveness probe.
* @returns the restorer: puts the previous method back, or, when something else wrapped on top, leaves the chain and turns this wrapper inert.
*/
function wrapMethod(target, name, make) {
	const original = target[name];
	if (typeof original !== "function") throw new Error(`dsh-orquestrator: the subagents service has no ${name}() to guard`);
	const previous = Object.getOwnPropertyDescriptor(target, name);
	let live = true;
	const wrapper = make(original, () => live);
	Object.defineProperty(wrapper, "name", {
		value: name,
		configurable: true
	});
	Object.defineProperty(target, name, {
		value: wrapper,
		writable: true,
		configurable: true,
		enumerable: previous?.enumerable ?? false
	});
	return () => {
		live = false;
		if (target[name] !== wrapper) return;
		if (previous === void 0) delete target[name];
		else Object.defineProperty(target, name, previous);
	};
}
/**
* The instance behind a service proxy.
* @param service - what `ctx.get('subagents')` returned.
* @returns the instance every proxy reads, or the object itself when it is not a proxy.
*/
function serviceInstance(service) {
	const instance = service[CORDIS_ORIGINAL];
	return typeof instance === "object" && instance !== null ? instance : service;
}
/**
* Stand the guard in the doors of the delegation service.
* @param deps - host services and configuration.
* @returns the disposer that takes the guard out (idempotent).
* @throws {Error} when the service has no `start()` or `startContinuable()` or refuses an own property.
*/
function installGuard(given) {
	const deps = given.warned === void 0 ? {
		...given,
		warned: /* @__PURE__ */ new Set()
	} : given;
	const target = serviceInstance(deps.subagents);
	const restorers = [];
	const restoreAll = () => {
		for (const restore of [...restorers].reverse()) restore();
		restorers.length = 0;
	};
	try {
		restorers.push(wrapMethod(target, "start", (original, live) => async function start(providerName, request) {
			if (!live() || !isRequestLike(request) || isGoverned(request)) return Reflect.apply(original, this, [providerName, request]);
			const governed = await governRequest(deps, providerName, request, request.signal);
			return Reflect.apply(original, this, [providerName, governed ?? request]);
		}));
		restorers.push(wrapMethod(target, "startContinuable", (original, live) => async function startContinuable(spec) {
			if (!live() || !isRequestLike(spec) || !isRequestLike(spec.request) || isGoverned(spec) || isGoverned(spec.request)) return Reflect.apply(original, this, [spec]);
			const governed = await governRequest(deps, spec.provider, spec.request, spec.signal);
			return Reflect.apply(original, this, [governed === void 0 ? spec : {
				...spec,
				request: governed
			}]);
		}));
	} catch (error) {
		restoreAll();
		throw error;
	}
	deps.logger.info(`dsh-orquestrator: start guard on (every child of a session with a confirmed choice; a model the caller names itself: ${deps.config.guard.explicitModel})`);
	return restoreAll;
}
//#endregion
//#region src/routes.ts
/** POST bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 65536;
/** Longest session id the routes admit. */
const MAX_SESSION_ID_LENGTH = 256;
/** Uniform JSON answer; state is live (no-store). */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}
/** Structured error answer. */
function sendError(res, status, payload) {
	sendJson(res, status, payload);
}
/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			req.resume();
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString("utf8");
}
/** Parse a `sessionId` value; undefined when absent or unusable. */
function parseSessionId(value) {
	if (typeof value !== "string" || value === "" || value.length > MAX_SESSION_ID_LENGTH) return void 0;
	return value;
}
/** The distinct routes a configuration names (each validated once). */
function routesOf(config) {
	const routes = [];
	if (config.subagentModel !== null) routes.push(config.subagentModel);
	return routes;
}
/**
* Ask the trust fence about a request; a rejection is answered with its 401/403 and no body, like the host's own
* denials.
* @returns true when the request was refused and answered, so the caller must stop.
*/
function refusedByFence(deps, req, res) {
	const rejection = deps.connection.requestRejection(req);
	if (rejection === void 0) return false;
	res.statusCode = rejection;
	res.end();
	return true;
}
/**
* Register the plugin's routes as effect-ready registrations on the
* composition's web server: the configuration route and, when a ledger is
* given, the subagents route. Every request passes the trust fence before any
* logic runs, and the fence's 401/403 is answered without a body, like the
* host's own denials.
* @param webServer - the composition's web-server service.
* @param deps - store, trust fence, optional LLM runtime, optional subagent ledger and optional skill offer.
* @returns one disposer that removes every route that was registered. When the
*   second registration throws, the first is removed again and the error is
*   rethrown: no half-registered state.
*/
function registerRoutes(webServer, deps) {
	const timeoutSignal = deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
	const now = deps.now ?? Date.now;
	/** A config answer plus the skill the host offers for its conversation, when it offers one; otherwise the answer exactly as older hosts wrote it. */
	const withSkill = (payload) => {
		const offer = deps.skill?.(payload.sessionId);
		return offer === void 0 ? payload : {
			...payload,
			skill: offer
		};
	};
	const disposeConfig = webServer.register({
		kind: "exact",
		path: CONFIG_ROUTE,
		handler: async (req, res) => {
			if (refusedByFence(deps, req, res)) return;
			if (req.method === "GET") {
				const sessionId = parseSessionId(new URL(String(req.url), "http://localhost").searchParams.get("sessionId"));
				if (sessionId === void 0) {
					sendError(res, 400, {
						code: "bad-request",
						message: "sessionId query parameter is required"
					});
					return;
				}
				const stored = deps.store.get(sessionId);
				const payload = {
					sessionId,
					config: stored === void 0 ? null : toWireConfig(stored)
				};
				sendJson(res, 200, withSkill(payload));
				return;
			}
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.setHeader("allow", "GET, POST");
				res.end();
				return;
			}
			if (String(req.headers["content-type"]).split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
				sendError(res, 415, {
					code: "bad-request",
					message: "content-type must be application/json"
				});
				return;
			}
			let text;
			try {
				text = await readBoundedBody(req);
			} catch {
				sendError(res, 400, {
					code: "bad-request",
					message: "request body unreadable"
				});
				return;
			}
			if (text === null) {
				sendError(res, 413, {
					code: "bad-request",
					message: "request body is too large"
				});
				return;
			}
			let body;
			try {
				body = JSON.parse(text);
			} catch {
				sendError(res, 400, {
					code: "bad-request",
					message: "request body must be JSON"
				});
				return;
			}
			const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
			const sessionId = parseSessionId(record["sessionId"]);
			if (sessionId === void 0) {
				sendError(res, 400, {
					code: "bad-request",
					message: "body needs a string \"sessionId\""
				});
				return;
			}
			if (!("config" in record)) {
				sendError(res, 400, {
					code: "bad-request",
					message: "body needs \"config\" (an object, or null to clear)"
				});
				return;
			}
			if (record["config"] === null) {
				deps.store.clear(sessionId);
				sendJson(res, 200, withSkill({
					sessionId,
					config: null
				}));
				return;
			}
			const config = parseConfig(record["config"]);
			if (config === void 0) {
				sendError(res, 422, {
					code: "invalid-config",
					message: "config does not match the expected shape"
				});
				return;
			}
			if (deps.llm !== void 0) for (const route of routesOf(config)) try {
				await deps.llm.resolveCallConfig({
					provider: route.provider,
					model: route.model,
					...route.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort }
				}, timeoutSignal(15e3));
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				sendError(res, 422, {
					code: "invalid-model",
					message: `${route.provider}/${route.model}: ${detail}`
				});
				return;
			}
			deps.store.set(sessionId, config);
			const payload = {
				sessionId,
				config: toWireConfig(config)
			};
			sendJson(res, 200, withSkill(payload));
		}
	});
	const ledger = deps.ledger;
	if (ledger === void 0) return disposeConfig;
	let disposeSubagents;
	try {
		disposeSubagents = webServer.register({
			kind: "exact",
			path: SUBAGENTS_ROUTE,
			handler: (req, res) => {
				if (refusedByFence(deps, req, res)) return;
				if (req.method !== "GET") {
					res.statusCode = 405;
					res.setHeader("allow", "GET");
					res.end();
					return;
				}
				const sessionId = parseSessionId(new URL(String(req.url), "http://localhost").searchParams.get("sessionId"));
				if (sessionId === void 0) {
					sendError(res, 400, {
						code: "bad-request",
						message: "sessionId query parameter is required"
					});
					return;
				}
				sendJson(res, 200, {
					sessionId,
					subagents: ledger.descendantsOf(sessionId),
					now: now()
				});
			}
		});
	} catch (error) {
		try {
			disposeConfig();
		} catch {}
		throw error;
	}
	return () => {
		try {
			disposeSubagents();
		} finally {
			disposeConfig();
		}
	};
}
//#endregion
//#region src/skill.generated.ts
/**
* GENERATED by scripts/gen-skill.mjs from skills/orchestrate-subagents/SKILL.md. Do not edit by hand:
* edit the Markdown and run `node scripts/gen-skill.mjs`.
*/
const SKILL_SOURCE = {
	name: "orchestrate-subagents",
	description: "Coordinator rules for the main agent when it orchestrates subagents; a subagent never loads this. Load it when the user asks to delegate, parallelize or orchestrate work, when a task has several steps over code, files or research, or when the message carries /orchestrate-subagents. Skip it for a plain question or a one-step answer.",
	content: "# Orchestrate with subagents\n\nYou are the **orchestrator**. You plan, delegate, check and report. Subagents read, change and run things. If another agent handed you a brief, or your prompt names a parent agent, you are a subagent and this skill does not apply: do your piece, answer in the format you were given, and stop. If you have no delegation tool, say so in one line and ask the user how to proceed.\n\n## The rules\n\n1. **Break the task into small pieces first.** Before any tool call, write a numbered plan: each piece is one deliverable that a subagent can finish and prove on its own, with what it depends on. Prefer many small pieces over a few large ones, but each must be worth a subagent: batch tiny items of one shape (a handful per piece) instead of one agent per item, and merge a piece whose brief would be longer than its work into a neighbor. Do not skip this because the task looks small: a one-line change is one piece with one verifier. A question that needs no files and no tools (a definition, an opinion) you answer directly. Ask the user only when a requirement is ambiguous in a way no subagent can settle.\n2. **Start everything that can run together, together.** Every piece with no unmet dependency starts in the same step: several `subagent` calls in one message. Run slow pieces in the background; each finish arrives as a notice that carries the result or names the job to read with `job_output`. When nothing else can proceed, end your turn and wait for the notices: do not call status tools (`list_agents`, `job_list`, `get_goal`) or message a running subagent to check on it. A single piece you must wait for runs in the foreground. Use a `workflow` script only for many pieces of one shape (a dozen or more; it is coordination, not project code), and `subagent_fork` only when a piece needs this conversation's context. Serialize only a real dependency, and say which one. If starts are refused for capacity, start the rest as others finish.\n3. **Parallel pieces share one working tree.** Every file has one owner. A file that several pieces need (shared helpers, config, the lockfile) is a piece of its own, done before the pieces that need it. Writers and their verifiers run only their own piece's tests; typecheck, linter and the full suite run in the final verifier, after the last writer. Git commands that change the tree or the index (`add`, `commit`, `stash`, `checkout`, `reset`) and changes to dependencies happen only when the task asks for them, as a serial piece of their own. Before changing code that has tests, one subagent records the baseline (tests, typecheck, linter) on the untouched tree, so a later failure is known to be new or old.\n4. **Do not read code yourself.** Not source files, diffs, logs, stack traces or command output. They fill your context with what only one piece needs, and your later decisions get worse. Send a subagent to read and answer a question (see \"Reading by delegation\"). Reading the reports that come back, and what the user wrote, is your job.\n5. **Do not write or run anything yourself.** Edits, builds, tests and shell commands belong to subagents. Your own tools are for coordination: the task list, starting, collecting, steering and stopping subagents, and asking the user.\n6. **Verify with a different subagent.** A result is not done because its author says so. Every piece that changes something gets its own verifier, started after the piece finishes, with a clean context (see \"Verifier briefs\"). A read-only report gets a different reader who tries to refute it only when a change or a decision rests on it; other lookups and baselines need none. Independent pieces get their verifiers in parallel; a final verifier then checks the whole change together (with a single piece, its verifier is the final one). A docs-only change needs the diff check and any docs lint, not the whole suite. If two verifiers disagree, the claim is unconfirmed: ask one fresh verifier that single question, with both observations.\n7. **Repair in rounds, then stop.** A failed check goes back as a precise fix brief (the defect, where it is, how to reproduce it) to the piece's author if it is still available, else to a new subagent. At most two repair rounds per piece; then report what is still broken instead of looping. A subagent that fails or returns nonsense is re-briefed smaller once, then reported; verifiers are not themselves verified. Do not do the piece yourself.\n8. **Report from evidence.** Finish with what was done, which command or check proved each part and its result, what was not verified or was skipped, and what needs the user's decision. Report as unverified whatever no verifier confirmed. Answer in the language the user wrote.\n\n## Briefing a subagent\n\nA subagent sees none of this conversation, so every brief is self-contained:\n\n- **Goal** in one sentence, and why it matters.\n- **Where**: exact paths, or the question that locates them. **Out of scope**: everything outside the piece; if another file must change, it says so in its report and leaves the file alone.\n- **Context** it cannot guess: decisions already made, conventions and constraints you were told or a reader reported, never your own assumption about the environment.\n- **Done when**: acceptance criteria it can check, ideally as commands (tests, typecheck, linter).\n- **Report**: the format below, and the length limit.\n\n## Reading by delegation\n\nWhen you need to understand code, send a question, not \"look at the repo\". For example: \"Where is login rate limiting enforced? Report the `path:line` of each place, a three-line summary of each, who calls it, and what you did not look at.\" Always ask for:\n\n- **Locations** as `path:line`, never whole files; at most ten quoted lines, only where the exact text matters.\n- **Facts apart from guesses**: every guess marked `GUESS`.\n- **A size limit**, so a report costs you little: at most 40 lines.\n\nIf a report is vague, or two reports disagree, send a sharper question. Do not open the file yourself. When you do not know the layout, slice by question (for example identity, tokens, enforcement, configuration) and add one reader that maps the layout; do not scout first. Split a large area across several readers in parallel and merge their answers.\n\n## Verifier briefs\n\nGive a verifier the **requirements and where to look**, not the author's report or reasoning, so it cannot inherit the author's blind spots. For a read-only report, give it the claims and where they cite, and ask it to refute them. Tell it to try to break the result: run the checks its piece can affect (its own tests; typecheck, linter and the full suite belong to the final verifier), execute the changed behaviour, check every acceptance criterion, and look for regressions and for what the author should have touched and did not. A verifier fixes nothing. It returns `PASS` or `FAIL` per criterion with evidence (the command and its result, or `path:line` and the symptom), and a list of concrete defects: where, what happens, how to reproduce. \"Looks fine\" is not a result; \"nothing found\" must say what was checked. Running something beats reading it.\n\n## Report format for every subagent\n\nEnd the report, in this order, with: `RESULT:` one line. `EVIDENCE:` the commands run and their outcome, or `path:line` references. `CHANGED:` the files touched (none for readers and verifiers). `OPEN:` doubts, skipped work, risks. Mark guesses `GUESS`. Stay under 40 lines."
};
//#endregion
//#region src/skill.ts
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
/** The origin bucket DSH shows for the skill: the plugin that registered it. */
const SKILL_ORIGIN = "dsh-orquestrator";
const SOURCE = SKILL_SOURCE;
/**
* Where the skill's Markdown lies on disk: `skills/orchestrate-subagents/SKILL.md` next to `src/` (development) and
* next to `lib/` (the installed package), which is the same relative URL from both.
* @returns the absolute path, or undefined when the file is not there (a package built without it) or the module
*   does not live at a `file:` URL. It never throws.
*/
function bundledSkillPath() {
	try {
		const path = fileURLToPath(new URL("../skills/orchestrate-subagents/SKILL.md", import.meta.url));
		return existsSync(path) ? path : void 0;
	} catch {
		return;
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
function skillRegistration(settings, path) {
	return {
		name: SOURCE.name,
		description: SOURCE.description,
		content: SOURCE.content,
		source: SKILL_ORIGIN,
		invocation: {
			modelInvocable: settings.modelInvocable,
			userInvocable: true
		},
		...SOURCE.whenToUse === void 0 ? {} : { whenToUse: SOURCE.whenToUse },
		...path === void 0 ? {} : { path }
	};
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
function registerOrchestrationSkill(skills, settings, logger) {
	let unregister;
	try {
		unregister = skills.register(skillRegistration(settings, bundledSkillPath()));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.warn(`dsh-orquestrator: could not register the global skill "${SOURCE.name}": ${reason}; the dialog will not offer it`);
		return {
			available: false,
			dispose() {}
		};
	}
	logger.info(`dsh-orquestrator: registered the global skill "${SOURCE.name}" (model-invocable: ${settings.modelInvocable ? "yes" : "no"})`);
	let disposed = false;
	return {
		available: true,
		dispose() {
			if (disposed) return;
			disposed = true;
			unregister();
		}
	};
}
//#endregion
//#region src/state-file.ts
/**
* Reading and writing the plugin's small JSON state files (`sessions.json`, `subagents.json`) in a directory it does
* not fully control: anything that can write the state directory (a subagent under a full-access preset, another
* user's process) must not be able to make the plugin follow a link, overwrite another file, hang on a pipe or load
* a gigabyte of JSON.
*
* Reading opens the path without following a symbolic link and without waiting for a writer, then checks what was
* opened (a regular file, not larger than a bound) before reading a byte. Writing goes through a temp file that this
* process creates itself, exclusively, and renames over the target, so a write never ends up in a file the process
* did not create. The callers decide what to say about a refusal and what to do with a corrupt file.
* @module dsh-orquestrator/state-file
*/
/** Largest state file the plugin reads, in bytes. A real one holds at most a few thousand small records (under a megabyte). */
const MAX_STATE_FILE_BYTES = 16777216;
/**
* Read a state file without trusting what is at the path.
* @param file - the state file path.
* @param maxBytes - the largest size accepted.
* @returns the text, or why there is none. Never throws, and never blocks on a pipe.
*/
function readStateFile(file, maxBytes = MAX_STATE_FILE_BYTES) {
	let fd;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT") return { kind: "missing" };
		if (code === "ELOOP" || code === "EMLINK") return {
			kind: "refused",
			reason: "it is a symbolic link"
		};
		return {
			kind: "failed",
			error
		};
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return {
			kind: "refused",
			reason: "it is not a regular file"
		};
		if (stat.size > maxBytes) return {
			kind: "refused",
			reason: `it is larger than ${String(maxBytes)} bytes`
		};
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let length = 0;
		for (;;) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
			if (length === buffer.length) return {
				kind: "refused",
				reason: "it changed while it was read"
			};
		}
		return {
			kind: "text",
			text: buffer.toString("utf8", 0, length)
		};
	} catch (error) {
		return {
			kind: "failed",
			error
		};
	} finally {
		closeSync(fd);
	}
}
/**
* Write a state file atomically and owner-only: the directory is created with mode 0700, the content goes to a temp
* file named after the process (two DSH processes sharing a directory never interleave writes), and a rename puts it
* in place. Whatever is at the temp name is removed first, and the temp file is created exclusively (`wx`), so a
* symbolic link planted there is never followed: it is the link that goes, not its target.
* @param file - the state file path.
* @param body - the complete new content.
* @throws whatever the file system refuses with; the temp file is not left behind.
*/
function writeStateFile(file, body) {
	const tmp = `${file}.${String(process.pid)}.tmp`;
	try {
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		rmSync(tmp, { force: true });
		const fd = openSync(tmp, "wx", 384);
		try {
			fchmodSync(fd, 384);
			writeFileSync(fd, body);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, file);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw error;
	}
}
//#endregion
//#region src/store.ts
/**
* Per-session orchestration choices: in memory, optionally persisted to one
* small JSON file under the DSH home (atomic tmp+rename, mode 0600). The file
* holds no secret (only provider/model ids the user picked), but it is
* user-private state, so it is created owner-only like the rest of `$DSH_HOME`.
* @module dsh-orquestrator/store
*/
/** Persisted file schema version. */
const FILE_VERSION$1 = 1;
/** Longest parent chain a lineage lookup walks (recursion guard). */
const MAX_LINEAGE_HOPS = 8;
/**
* Default state file under the DSH home.
* @param stateDir - explicit directory override.
* @returns absolute path of `sessions.json`.
*/
function defaultStateFile(stateDir) {
	const dir = stateDir ?? join(process.env["DSH_HOME"] ?? join(homedir(), ".dsh"), "dsh-orquestrator");
	return join(dir, "sessions.json");
}
/** The store of per-session orchestration choices. */
var ConfigStore = class {
	entries = /* @__PURE__ */ new Map();
	file;
	maxSessions;
	now;
	logger;
	/**
	* @param options - persistence target, capacity, clock and logger.
	*/
	constructor(options) {
		this.file = options.file;
		this.maxSessions = options.maxSessions;
		this.now = options.now ?? Date.now;
		this.logger = options.logger;
		this.load();
	}
	/**
	* Read one session's stored choice.
	* @param sessionId - session identity.
	* @returns the stored configuration, or undefined when none.
	*/
	get(sessionId) {
		return this.entries.get(sessionId)?.config;
	}
	/**
	* Store (or replace) one session's choice and persist.
	* @param sessionId - session identity.
	* @param config - validated configuration.
	*/
	set(sessionId, config) {
		this.entries.delete(sessionId);
		this.entries.set(sessionId, {
			config,
			updatedAt: this.now()
		});
		this.prune();
		this.save();
	}
	/**
	* Forget one session's choice and persist.
	* @param sessionId - session identity.
	* @returns whether an entry existed.
	*/
	clear(sessionId) {
		const existed = this.entries.delete(sessionId);
		if (existed) this.save();
		return existed;
	}
	/** Number of stored sessions. */
	get size() {
		return this.entries.size;
	}
	/**
	* Resolve the configuration governing one agent: its own session's choice,
	* else the nearest ancestor's (a subagent delegating further inherits the
	* user's choice for the whole task tree), else the deployment default.
	* @param sessionId - the calling agent's session id.
	* @param parentOf - resolver of a session's direct parent id.
	* @param fallback - deployment default (headless), or null for stock behavior.
	* @returns the governing configuration, or null when none applies.
	*/
	resolve(sessionId, parentOf, fallback) {
		let current = sessionId;
		for (let hop = 0; current !== void 0 && hop <= MAX_LINEAGE_HOPS; hop += 1) {
			const found = this.get(current);
			if (found !== void 0) return found;
			current = parentOf(current);
		}
		return fallback;
	}
	/** Drop the least recently updated entries beyond capacity. */
	prune() {
		while (this.entries.size > this.maxSessions) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) return;
			this.entries.delete(oldest.value);
		}
	}
	/**
	* Load the state file. A missing file is empty; a corrupt one is set aside; one that must not be read (a link, a
	* pipe, a directory, anything over the size bound) is only reported, and the next write replaces it.
	*/
	load() {
		if (this.file === void 0) return;
		const read = readStateFile(this.file);
		if (read.kind === "missing") return;
		if (read.kind !== "text") {
			this.logger?.warn(`dsh-orquestrator: cannot read ${this.file}: ${read.kind === "refused" ? read.reason : String(read.error)}`);
			return;
		}
		try {
			const parsed = JSON.parse(read.text);
			if (typeof parsed !== "object" || parsed === null || parsed.version !== FILE_VERSION$1) throw new Error("unsupported state file version");
			const sessions = parsed.sessions;
			if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) throw new Error("missing sessions map");
			const loaded = [];
			for (const [id, value] of Object.entries(sessions)) {
				const config = parseConfig(value?.config);
				const updatedAt = value?.updatedAt;
				if (config === void 0 || typeof updatedAt !== "number") continue;
				loaded.push([id, {
					config,
					updatedAt
				}]);
			}
			loaded.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
			for (const [id, entry] of loaded.slice(Math.max(0, loaded.length - this.maxSessions))) this.entries.set(id, entry);
		} catch (error) {
			const aside = `${this.file}.corrupt-${String(this.now())}`;
			try {
				renameSync(this.file, aside);
				this.logger?.warn(`dsh-orquestrator: state file was unreadable (${String(error)}); moved to ${aside}`);
			} catch (renameError) {
				this.logger?.warn(`dsh-orquestrator: state file unreadable and could not be set aside: ${String(renameError)}`);
			}
		}
	}
	/** Persist atomically (see {@link writeStateFile}), owner-only. Failures are logged, never thrown. */
	save() {
		if (this.file === void 0) return;
		const body = `${JSON.stringify({
			version: FILE_VERSION$1,
			sessions: Object.fromEntries(this.entries)
		}, null, 2)}\n`;
		try {
			writeStateFile(this.file, body);
		} catch (error) {
			this.logger?.warn(`dsh-orquestrator: cannot persist ${this.file}: ${String(error)}`);
		}
	}
};
//#endregion
//#region src/subagents.ts
/**
* The subagent ledger: what the host knows about the children DSH ran, kept for the browser's subagent dropdown.
*
* DSH records no outcome for a subagent (done or failed) and does not show which model it runs on. It does announce
* every in-process child, one-shot and continuable alike, with `subagent/start` and `subagent/end`. A listener on the
* root context sees every delegation, so the tracker below turns those two events into one small record per child
* (parent session, backend, model route, state, stop reason of the latest run) and the browser reads the records
* through `GET /dsh-orquestrator/subagents?sessionId=<id>`.
*
* Remote backends (`acp`, `codex`, ...) have no session of their own and are absent from the web catalog, so they are
* not tracked. The ledger lives in memory, optionally persisted like the session store (one owner-only JSON file,
* read and written through `state-file.ts`, which does not trust what is in the state directory), pruned
* least-recently-updated first, and its writes are debounced: a workflow can start dozens of agents at once and must
* cost one write, not dozens.
*
* Two DSH processes may share a state directory (`dsh web` next to a headless run), and each writes the whole file.
* So before every write the ledger folds in what the file holds that this process does not know, or knows older: the
* records another process wrote survive this process's next write. A child that is running here is never overruled by
* the file, because it is alive here.
* @module dsh-orquestrator/subagents
*/
/** Persisted file schema version. */
const FILE_VERSION = 1;
/** Wait before a burst of updates is written, in milliseconds. */
const DEFAULT_SAVE_DELAY_MS = 250;
/** Deepest descendant level `descendantsOf` reports; a bound on top of the visited set. */
const MAX_DESCENDANT_DEPTH = 16;
/** Stop reason a persisted `running` record gets when it is loaded: the process that was running the child is gone. */
const INTERRUPTED = "interrupted";
/** The same warning is not logged again within this many milliseconds (a failing disk would otherwise log on every write). */
const WARN_INTERVAL_MS = 6e4;
/** Most distinct warnings remembered for that limit. */
const MAX_REMEMBERED_WARNINGS = 16;
/** Most records the ledger keeps unless told otherwise; the least recently updated are pruned first. */
const DEFAULT_MAX_SUBAGENTS = 2e3;
/**
* Default ledger file, next to the session store's `sessions.json`.
* @param stateDir - explicit directory override (the same one the session store takes).
* @returns absolute path of `subagents.json`.
*/
function defaultLedgerFile(stateDir) {
	return join(dirname(defaultStateFile(stateDir)), "subagents.json");
}
/** A copy a caller may keep or change without touching the ledger. */
function copyRecord(record) {
	return {
		...record,
		route: record.route === null ? null : { ...record.route }
	};
}
/** When a record last changed: its end, else its start. This is what recency means. */
function changedAt(record) {
	return record.endedAt ?? record.startedAt;
}
/** Least recently changed first. */
function byChange(a, b) {
	return changedAt(a) - changedAt(b);
}
/** Oldest start first; children that started in the same millisecond order by id. */
function byStart(a, b) {
	if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}
/**
* Whether what the file says about a child replaces what this process has. A child running here is alive here, so the
* file never overrules it; otherwise the later change wins, and a tie keeps this process's record.
*/
function supersedes(theirs, mine) {
	if (mine.state === "running") return false;
	return changedAt(theirs) > changedAt(mine);
}
/**
* The ledger of the subagents the host saw start: one record per child session id, kept in recency order (every
* start and finish moves its record to the newest end, like the session store) so the pruned ones are always the
* ones nothing touched for longest.
*/
var SubagentLedger = class {
	records = /* @__PURE__ */ new Map();
	/** The run (`runId`) each child that was started with one is in. In memory only: a run is a fact of this process. */
	runs = /* @__PURE__ */ new Map();
	file;
	maxRecords;
	now;
	bootedAt;
	logger;
	saveDelayMs;
	/** Warnings logged lately, by text, with the time they were: the same one is not repeated within the interval. */
	warned = /* @__PURE__ */ new Map();
	timer;
	dirty = false;
	/**
	* Load the persisted records when a file is given. A missing file starts empty. A file that is corrupt or of an
	* unsupported version is set aside as `<file>.corrupt-<now>` with a warning, and the ledger starts empty. A file that
	* cannot be read, is not a regular file (a link, a pipe, a directory) or is larger than 16 MiB is only reported, and
	* the first write replaces it. Records that were still running and started before this process did belong to a
	* process that is gone: each becomes `stopped` with the stop reason `interrupted`, ended now.
	* @param options - persistence target, capacity, clock, process start, logger and write delay. An unusable capacity,
	*   process start or delay falls back to its default.
	*/
	constructor(options = {}) {
		this.file = options.file;
		const capacity = options.maxRecords;
		this.maxRecords = capacity !== void 0 && Number.isInteger(capacity) && capacity >= 1 ? capacity : DEFAULT_MAX_SUBAGENTS;
		this.now = options.now ?? Date.now;
		const booted = options.bootedAt;
		this.bootedAt = booted !== void 0 && Number.isFinite(booted) ? booted : Date.now() - process.uptime() * 1e3;
		this.logger = options.logger;
		const delay = options.saveDelayMs;
		this.saveDelayMs = delay !== void 0 && Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_SAVE_DELAY_MS;
		this.load();
	}
	/**
	* Record that a child started. A child that is already known (a continuable child that is resumed starts again)
	* goes back to `running`: its start time is now, its end and stop reason are cleared, and the backend, parent and
	* route this start gives replace the old ones. A parent or route this start does not know keeps the one known.
	* @param info - the child's session id, the session that started it, the backend that runs it, its model route and,
	*   when the event carries one, the id of this run: an end that names another run is not this run's end.
	*/
	start(info) {
		const known = this.records.get(info.id);
		if (info.runId === void 0) this.runs.delete(info.id);
		else this.runs.set(info.id, info.runId);
		this.put({
			id: info.id,
			parentId: info.parentId ?? known?.parentId ?? null,
			backend: info.backend,
			route: parseModelRoute(info.route) ?? known?.route ?? null,
			state: "running",
			stopReason: null,
			startedAt: this.now(),
			endedAt: null
		});
	}
	/**
	* Record that a child's run ended. The state follows the stop reason (`completed` is done, `aborted` is stopped,
	* every other reason is a failure). The parent and backend stay; the route is replaced only when the outcome names
	* one. A child the ledger never saw start is ignored: the plugin may have loaded mid-run, and a record without a
	* parent could never be found again. So is the end of a run that is not the child's current one: a continuable child
	* that was resumed has started again, and the end of its earlier run must not close the new one.
	* @param id - the child's session id.
	* @param outcome - the terminal stop reason, the route the child last requested when it is known, and the id of the
	*   run that ended when the event carries one.
	*/
	finish(id, outcome) {
		const known = this.records.get(id);
		if (known === void 0) return;
		const current = this.runs.get(id);
		if (outcome.runId !== void 0 && current !== void 0 && outcome.runId !== current) return;
		this.put({
			...known,
			route: parseModelRoute(outcome.route) ?? known.route,
			state: subagentStateOf(outcome.stopReason),
			stopReason: outcome.stopReason,
			endedAt: this.now()
		});
	}
	/**
	* Read one record.
	* @param id - the child's session id.
	* @returns a copy of the record, or undefined when none.
	*/
	get(id) {
		const record = this.records.get(id);
		return record === void 0 ? void 0 : copyRecord(record);
	}
	/** Number of records kept. */
	get size() {
		return this.records.size;
	}
	/**
	* The subagents started under one session, direct and deeper, up to {@link MAX_DESCENDANT_DEPTH} levels, never the
	* session itself. A parent chain that loops back on itself, or a record that is its own parent, ends the walk
	* instead of repeating. The order is that of the LATEST start of each child: a continuable child that is resumed
	* starts again, so it moves to the end, and the cap keeps the children that were active most recently.
	* @param rootId - the session whose subagents are wanted.
	* @returns copies of the records, oldest start first (equal starts by id); when more than
	*   {@link MAX_SUBAGENTS_PER_RESPONSE} qualify, the newest ones, still oldest first.
	*/
	descendantsOf(rootId) {
		const childrenOf = /* @__PURE__ */ new Map();
		for (const record of this.records.values()) {
			if (record.parentId === null) continue;
			const siblings = childrenOf.get(record.parentId);
			if (siblings === void 0) childrenOf.set(record.parentId, [record]);
			else siblings.push(record);
		}
		const visited = /* @__PURE__ */ new Set([rootId]);
		const found = [];
		let level = [rootId];
		for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && level.length > 0; depth += 1) {
			const next = [];
			for (const parentId of level) for (const child of childrenOf.get(parentId) ?? []) {
				if (visited.has(child.id)) continue;
				visited.add(child.id);
				found.push(child);
				next.push(child.id);
			}
			level = next;
		}
		found.sort(byStart);
		return (found.length > 500 ? found.slice(found.length - 500) : found).map(copyRecord);
	}
	/**
	* Write now what a pending delayed write would have written. Does nothing when no file is set or nothing changed
	* since the last write that succeeded: a write that failed is tried again here.
	*/
	flush() {
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		if (this.file === void 0 || !this.dirty) return;
		this.save();
	}
	/** Store one record as the most recently updated, prune and schedule the write. */
	put(record) {
		this.records.delete(record.id);
		this.records.set(record.id, record);
		this.prune();
		this.schedule();
	}
	/** Drop the least recently updated records beyond capacity. */
	prune() {
		while (this.records.size > this.maxRecords) {
			const oldest = this.records.keys().next();
			if (oldest.done === true) return;
			this.records.delete(oldest.value);
			this.runs.delete(oldest.value);
		}
	}
	/** Log a warning, unless the same one was logged within the last minute. */
	warn(message) {
		const at = this.now();
		const last = this.warned.get(message);
		if (last !== void 0 && at - last < WARN_INTERVAL_MS) return;
		if (this.warned.size >= MAX_REMEMBERED_WARNINGS) this.warned.clear();
		this.warned.set(message, at);
		this.logger?.warn(message);
	}
	/** Mark the ledger changed and make sure one write is pending; a burst of updates shares it. */
	schedule() {
		if (this.file === void 0) return;
		this.dirty = true;
		if (this.timer !== void 0) return;
		const timer = setTimeout(() => {
			this.timer = void 0;
			if (this.dirty) this.save();
		}, this.saveDelayMs);
		const handle = timer;
		if (typeof handle.unref === "function") handle.unref();
		this.timer = timer;
	}
	/**
	* What the state file holds right now: its records, valid ones only, least recently changed first, at most
	* `maxRecords` of them (the newest), so that a huge file costs one sort and not a pruning loop that is quadratic.
	* @returns undefined when there is nothing to use: no file, a file that was refused or could not be read (a warning
	*   says so), or a corrupt one (set aside, with a warning).
	*/
	readRecords() {
		if (this.file === void 0) return void 0;
		const read = readStateFile(this.file);
		if (read.kind === "missing") return void 0;
		if (read.kind !== "text") {
			this.warn(`dsh-orquestrator: cannot read ${this.file}: ${read.kind === "refused" ? read.reason : String(read.error)}`);
			return;
		}
		try {
			const parsed = JSON.parse(read.text);
			if (typeof parsed !== "object" || parsed === null || parsed.version !== FILE_VERSION) throw new Error("unsupported subagent ledger version");
			const subagents = parsed.subagents;
			if (typeof subagents !== "object" || subagents === null || Array.isArray(subagents)) throw new Error("missing subagents map");
			const records = [];
			for (const [id, value] of Object.entries(subagents)) {
				const record = parseSubagentRecord(value);
				if (record === void 0 || record.id !== id) continue;
				records.push(record);
			}
			records.sort(byChange);
			return records.slice(Math.max(0, records.length - this.maxRecords));
		} catch (error) {
			const aside = `${this.file}.corrupt-${String(this.now())}`;
			try {
				renameSync(this.file, aside);
				this.warn(`dsh-orquestrator: subagent ledger state file was unreadable (${String(error)}); moved to ${aside}`);
			} catch (renameError) {
				this.warn(`dsh-orquestrator: subagent ledger state file unreadable and could not be set aside: ${String(renameError)}`);
			}
			return;
		}
	}
	/** Load the state file. A child that was running when its process went away is marked interrupted. */
	load() {
		const records = this.readRecords();
		if (records === void 0) return;
		const at = this.now();
		for (const record of records) {
			const orphan = record.state === "running" && (record.startedAt < this.bootedAt || record.startedAt > at);
			this.records.set(record.id, orphan ? {
				...record,
				state: "stopped",
				stopReason: INTERRUPTED,
				endedAt: at
			} : record);
		}
	}
	/**
	* Fold in what the file holds that another process wrote since this one last did: a child this process does not
	* know, or knows older. Without it, two processes on one state directory would each write their own view and drop the
	* other's records. The file is read with the same bounds as at load, and the result is pruned to capacity.
	*/
	mergeFromFile() {
		const theirs = this.readRecords();
		if (theirs === void 0) return;
		let adopted = false;
		for (const record of theirs) {
			const mine = this.records.get(record.id);
			if (mine !== void 0 && !supersedes(record, mine)) continue;
			this.records.set(record.id, record);
			adopted = true;
		}
		if (!adopted) return;
		const ordered = [...this.records.values()].sort(byChange);
		this.records.clear();
		for (const record of ordered) this.records.set(record.id, record);
		this.prune();
	}
	/**
	* Write the ledger, after folding in the file. Failures are logged (once a minute at most), never thrown: this runs
	* from a timer. The ledger stays dirty after a failure, so the next change or a flush tries again.
	*/
	save() {
		if (this.file === void 0) return;
		try {
			this.mergeFromFile();
		} catch (error) {
			this.warn(`dsh-orquestrator: could not merge ${this.file} into the subagent ledger: ${String(error)}`);
		}
		try {
			writeStateFile(this.file, `${JSON.stringify({
				version: FILE_VERSION,
				subagents: Object.fromEntries(this.records)
			}, null, 2)}\n`);
			this.dirty = false;
			this.warned.clear();
		} catch (error) {
			this.warn(`dsh-orquestrator: cannot persist ${this.file}: ${String(error)}`);
		}
	}
};
/** The route in an agent's options or logged request config, when it names both a provider and a model. */
function routeOf(config) {
	const provider = config?.provider;
	const model = config?.model;
	if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return null;
	const effort = config?.reasoningEffort;
	return typeof effort === "string" && effort !== "" ? {
		provider,
		model,
		reasoningEffort: effort
	} : {
		provider,
		model
	};
}
/** A thrown value as one line of text, without letting its own coercion escape. */
function describeError(error) {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unreadable error";
	}
}
/**
* Feed the ledger from DSH's `subagent/start` and `subagent/end` events. Only in-process children (`local`) are
* tracked: a remote backend's child has no session of its own and is absent from the web catalog. At start the
* child's parent session and model route are read from the live agent (a child the registry does not know is still
* recorded, with neither); at end the state follows the stop reason and, when the agent is still registered, the
* route it actually requested last replaces the one it was created with. A handler never throws: trouble is logged.
*
* Each event carries the `runId` that pairs a start with its end, and the ledger is told, so that the end of an
* earlier run of a resumed child never closes the run that is going on.
*
* What the end can know depends on the kind of child. A one-shot child is still registered when its end is emitted, so
* the route it last requested is read then. A continuable child (the default of the standard preset's `subagent` tools)
* is released before its end is emitted, so the agent is gone and its record keeps the route read at the start of the run.
* @param deps - event source, agent registry, ledger and logger.
* @returns one disposer that removes both listeners and writes any pending change.
*/
function installSubagentTracker(deps) {
	const { ctx, ledger } = deps;
	const contained = (body) => {
		try {
			body();
		} catch (error) {
			deps.logger.warn(`dsh-orquestrator: subagent tracker: ${describeError(error)}`);
		}
	};
	const offStart = ctx.on("subagent/start", (info) => {
		contained(() => {
			if (info.local !== true) return;
			const agent = deps.agents()?.get(info.id);
			ledger.start({
				id: info.id,
				parentId: agent?.session.header.parentSession ?? null,
				backend: info.provider,
				route: routeOf(agent?.options),
				runId: info.runId
			});
		});
	});
	let offEnd;
	try {
		offEnd = ctx.on("subagent/end", (info) => {
			contained(() => {
				if (info.local !== true) return;
				const agent = deps.agents()?.get(info.id);
				const route = routeOf(agent?.session.requestHeader?.()?.config);
				ledger.finish(info.id, {
					stopReason: info.stopReason,
					runId: info.runId,
					...route === null ? {} : { route }
				});
			});
		});
	} catch (error) {
		offStart();
		throw error;
	}
	return () => {
		try {
			offStart();
		} finally {
			try {
				offEnd();
			} finally {
				ledger.flush();
			}
		}
	};
}
//#endregion
//#region src/index.ts
/** Cordis plugin name; stable per composition. */
const name = "dsh-orquestrator";
/**
* Required service: `subagents` (child runs), the one the guard stands in. It
* therefore works in every profile (web, headless, tui, sdk). The web-only
* pieces, the config route and its trust fence, are attached through a nested
* `ctx.inject` and simply do not exist where there is no web server. `logger`
* is deliberately absent: it is not a Cordis Service, so injecting it would
* leave the fiber pending forever.
*/
const inject = ["subagents"];
/**
* Plugin body: parse config fail-loud, then register the route and the start guard as effects.
* @param ctx - host context carrying the web composition.
* @param config - deployment configuration; defaults live in the parser.
*/
function apply(ctx, config) {
	const parsed = parsePluginConfig(config);
	for (const problem of removedConfigFields(config)) ctx.logger.warn(`dsh-orquestrator: ${problem}`);
	for (const problem of unknownConfigFields(config)) ctx.logger.warn(`dsh-orquestrator: ${problem}`);
	const subagents = ctx.get("subagents");
	if (subagents === void 0) throw new Error("dsh-orquestrator: the required `subagents` service is missing; this plugin needs a composition with delegation");
	const store = new ConfigStore({
		...parsed.persist ? { file: defaultStateFile(parsed.stateDir) } : {},
		maxSessions: parsed.maxSessions,
		logger: ctx.logger
	});
	const ledger = new SubagentLedger({
		...parsed.persist ? { file: defaultLedgerFile(parsed.stateDir) } : {},
		logger: ctx.logger
	});
	let skillAvailable = false;
	const loaderMounted = (sessionId) => {
		try {
			const tools = ctx.get("tools");
			if (tools === void 0 || typeof tools.get !== "function") return true;
			const agent = ctx.get("agents")?.get(sessionId);
			return agent === void 0 ? true : tools.get("skill", agent) !== void 0;
		} catch {
			return true;
		}
	};
	const skillOffer = (sessionId) => parsed.skill.enabled ? {
		name: SKILL_NAME,
		available: skillAvailable && loaderMounted(sessionId)
	} : void 0;
	const parentOf = (sessionId) => {
		return ctx.get("agents")?.get(sessionId)?.session.header.parentSession;
	};
	const models = () => ctx.get("llm");
	ctx.inject(["webServer", "connection"], (web) => {
		const webServer = web.get("webServer");
		const connection = web.get("connection");
		web.effect(() => registerRoutes(webServer, {
			store,
			connection,
			ledger,
			skill: skillOffer,
			get llm() {
				return web.get("llm");
			}
		}), "dsh-orquestrator: routes");
	});
	if (parsed.skill.enabled) ctx.inject(["skills"], (scope) => {
		const skills = scope.get("skills");
		scope.effect(() => {
			const registration = registerOrchestrationSkill(skills, { modelInvocable: parsed.skill.modelInvocable }, ctx.logger);
			skillAvailable = registration.available;
			return () => {
				skillAvailable = false;
				registration.dispose();
			};
		}, "dsh-orquestrator: skill");
	});
	if (parsed.guard.enabled) ctx.effect(() => installGuard({
		subagents,
		store,
		defaults: parsed.defaults,
		parentOf,
		config: parsed,
		models,
		logger: ctx.logger
	}), "dsh-orquestrator: start guard");
	try {
		ctx.effect(() => installSubagentTracker({
			ctx,
			agents: () => ctx.get("agents"),
			ledger,
			logger: ctx.logger
		}), "dsh-orquestrator: subagent tracker");
	} catch (error) {
		ctx.logger.warn(`dsh-orquestrator: could not install the subagent tracker (${error instanceof Error ? error.message : String(error)}); the model and state of subagents will not be shown, nothing else is affected`);
	}
	ctx.logger.info(`dsh-orquestrator: ready (persisted sessions: ${String(store.size)}; effort ceilings: ${parsed.effort.enabled ? "on" : "off"}; start guard: ${parsed.guard.enabled ? `on, explicit models ${parsed.guard.explicitModel}` : "off"}; skill: ${parsed.skill.enabled ? `on, ${parsed.skill.modelInvocable ? "in the model catalog" : "token only"}` : "off"}; tracked subagents: ${String(ledger.size)})`);
}
//#endregion
export { apply, inject, name };
