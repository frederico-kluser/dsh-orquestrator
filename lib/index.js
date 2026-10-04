import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
/** Session configuration route: `GET ?sessionId=<id>` reads, `POST` writes or clears. */
const CONFIG_ROUTE = `/dsh-orquestrator/config`;
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
	"children"
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
	workerEffort: "defaults.workerEffort"
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
		guard: parseGuard(config.children)
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
* Register the configuration route as an effect-ready registration on the
* composition's web server. Every request passes the trust fence before any
* logic runs, and the fence's 401/403 is answered without a body, like the
* host's own denials.
* @param webServer - the composition's web-server service.
* @param deps - store, trust fence and optional LLM runtime.
* @returns a disposer that removes the route.
*/
function registerRoutes(webServer, deps) {
	const timeoutSignal = deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
	return webServer.register({
		kind: "exact",
		path: CONFIG_ROUTE,
		handler: async (req, res) => {
			const rejection = deps.connection.requestRejection(req);
			if (rejection !== void 0) {
				res.statusCode = rejection;
				res.end();
				return;
			}
			if (req.method === "GET") {
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
					config: deps.store.get(sessionId) ?? null
				});
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
				sendJson(res, 200, {
					sessionId,
					config: null
				});
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
			sendJson(res, 200, {
				sessionId,
				config
			});
		}
	});
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
const FILE_VERSION = 1;
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
	/** Load the state file; a missing file is empty, a corrupt one is set aside. */
	load() {
		if (this.file === void 0) return;
		let raw;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			this.logger?.warn(`dsh-orquestrator: cannot read ${this.file}: ${String(error)}`);
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || parsed.version !== FILE_VERSION) throw new Error("unsupported state file version");
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
			for (const [id, entry] of loaded) this.entries.set(id, entry);
			this.prune();
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
	/** Persist atomically (tmp + rename), owner-only. Failures are logged, never thrown. */
	save() {
		if (this.file === void 0) return;
		const sessions = {};
		for (const [id, entry] of this.entries) sessions[id] = entry;
		const body = `${JSON.stringify({
			version: FILE_VERSION,
			sessions
		}, null, 2)}\n`;
		const tmp = `${this.file}.${String(process.pid)}.tmp`;
		try {
			mkdirSync(dirname(this.file), {
				recursive: true,
				mode: 448
			});
			writeFileSync(tmp, body, { mode: 384 });
			chmodSync(tmp, 384);
			renameSync(tmp, this.file);
		} catch (error) {
			this.logger?.warn(`dsh-orquestrator: cannot persist ${this.file}: ${String(error)}`);
		}
	}
};
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
			get llm() {
				return web.get("llm");
			}
		}), "dsh-orquestrator: routes");
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
	ctx.logger.info(`dsh-orquestrator: ready (persisted sessions: ${String(store.size)}; effort ceilings: ${parsed.effort.enabled ? "on" : "off"}; start guard: ${parsed.guard.enabled ? `on, explicit models ${parsed.guard.explicitModel}` : "off"})`);
}
//#endregion
export { apply, inject, name };
