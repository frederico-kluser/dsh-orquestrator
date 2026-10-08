window.__ModuleLoader__.load({
	id: "dsh-orquestrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared.ts
		/** Route prefix owned by this plugin on the composition's web server. */
		const ROUTE_PREFIX = "/dsh-orquestrator";
		/** Session configuration route: `GET ?sessionId=<id>` reads, `POST` writes or clears. */
		const CONFIG_ROUTE = `${ROUTE_PREFIX}/config`;
		/** Subagent ledger route: `GET ?sessionId=<id>` lists the subagents started under that session, with their model and outcome. */
		const SUBAGENTS_ROUTE = `${ROUTE_PREFIX}/subagents`;
		/** The inert configuration: exactly the stock DSH behavior. */
		const OFF_CONFIG = Object.freeze({
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
		* Build the configuration a modal confirmation produces.
		* @param input - the modal's fields.
		* @returns a normalized configuration.
		*/
		function buildConfig(input) {
			return {
				version: 1,
				subagentModel: input.subagentModel,
				workerEffort: input.workerEffort ?? null
			};
		}
		/**
		* Stable identity of a route, for equality checks and select option ids.
		* @param route - a model route.
		* @returns `provider/model`.
		*/
		function routeKey(route) {
			return `${route.provider}/${route.model}`;
		}
		/** The skill-name grammar of DSH's registry (`isSkillName`): lowercase words joined by single hyphens. */
		const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
		/**
		* Parse the host's skill offer from untrusted JSON.
		* @param value - candidate `skill` field of a configuration payload.
		* @returns the offer, or null when the field is absent or malformed (a host that predates the skill never sends it).
		*/
		function parseSkillOffer(value) {
			if (!isRecord$1(value)) return null;
			const name = value["name"];
			const available = value["available"];
			if (typeof name !== "string" || name.length > 64 || !SKILL_NAME_PATTERN.test(name) || typeof available !== "boolean") return null;
			return {
				name,
				available
			};
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
		/**
		* Parse the subagent ledger answer from untrusted JSON. A malformed record is dropped, never a reason to lose the others.
		* @param value - candidate payload.
		* @returns the payload, or undefined when it is not an object with a session id and a list.
		*/
		function parseSubagentsPayload(value) {
			if (!isRecord$1(value) || !isId(value["sessionId"]) || !Array.isArray(value["subagents"])) return void 0;
			const subagents = [];
			for (const candidate of value["subagents"].slice(0, 500)) {
				const record = parseSubagentRecord(candidate);
				if (record !== void 0) subagents.push(record);
			}
			return isTime(value["now"]) ? {
				sessionId: value["sessionId"],
				subagents,
				now: value["now"]
			} : {
				sessionId: value["sessionId"],
				subagents
			};
		}
		//#endregion
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
		* Notes to show next to a route.
		* @param route - the route.
		* @returns the note ids, possibly none.
		*/
		function notesFor(route) {
			return profileOf(route)?.notes ?? [];
		}
		//#endregion
		//#region src/client/catalog.ts
		/** The initial, empty state. */
		const LOADING_CATALOG = {
			status: "loading",
			groups: [],
			current: null,
			error: null
		};
		/**
		* Load the catalog for one session.
		* @param sources - resolvers for the model-directory service and the remote catalog call.
		* @param sessionId - the session whose current route to report.
		* @returns a ready state, or an error state when no source could answer. Never throws.
		*/
		async function loadCatalog$1(sources, sessionId) {
			let failure = null;
			const describe = (error) => error instanceof Error ? error.message : String(error);
			try {
				const directories = sources.modelDirectories?.();
				if (directories !== void 0) {
					const state = await directories.directoryFor(sessionId).load();
					if (state.status !== "error" && state.groups.length > 0) return {
						status: "ready",
						groups: state.groups,
						current: state.current,
						error: null
					};
					failure = state.error;
				}
			} catch (error) {
				failure = describe(error);
			}
			try {
				const remote = sources.remoteSession?.();
				if (remote !== void 0) {
					const response = await remote.modelCatalog();
					if (response.ok) return {
						status: "ready",
						groups: response.value.groups,
						current: response.value.default,
						error: null
					};
					failure = response.error.message;
				}
			} catch (error) {
				failure = describe(error);
			}
			return {
				status: "error",
				groups: [],
				current: null,
				error: failure ?? "no model catalog is available"
			};
		}
		/**
		* Human-readable name of a route, as the catalog names it.
		* @param groups - the catalog groups.
		* @param route - a provider/model pair.
		* @returns the model's display name, or the raw model id when the catalog lacks it.
		*/
		function modelName(groups, route) {
			return groups.find((candidate) => candidate.id === route.provider)?.models.find((model) => model.id === route.model)?.name ?? route.model;
		}
		/**
		* The reasoning levels one route offers.
		* @param groups - the catalog groups.
		* @param route - a provider/model pair.
		* @returns the ladder, or undefined when the route is unknown or has no reasoning levels.
		*/
		function ladderOf(groups, route) {
			return groups.find((candidate) => candidate.id === route.provider)?.models.find((model) => model.id === route.model)?.reasoning;
		}
		//#endregion
		//#region src/client/config-client.ts
		/**
		* Browser HTTP carrier for the per-session configuration route. The browser's
		* same-origin session (cookies, Host/Origin) is what the host's connection
		* trust fence authenticates, exactly like the built-in `/api` traffic.
		* @module dsh-orquestrator/client/config-client
		*/
		/** Per-request deadline: the route is local, so a slow answer means it is not there. */
		const REQUEST_TIMEOUT_MS$1 = 8e3;
		/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
		function hostBase() {
			const origin = globalThis.location?.origin;
			return origin !== void 0 && origin !== "null" ? origin : "http://dsh.internal";
		}
		/** One failed call: the HTTP status plus the server's structured code. */
		var ConfigHttpError = class extends Error {
			/** HTTP status of the failed call (0 for a network failure). */
			status;
			/** The server's structured error code, when present. */
			code;
			/**
			* @param status - HTTP status of the failed call (0 for a network failure).
			* @param code - the server's structured error code, when present.
			* @param message - server message, when present.
			*/
			constructor(status, code, message) {
				super(message ?? `HTTP ${String(status)}`);
				this.name = "ConfigHttpError";
				this.status = status;
				this.code = code;
			}
		};
		/** HTTP carrier of the per-session configuration. */
		var ConfigClient = class {
			fetcher;
			base;
			/**
			* @param fetcher - HTTP carrier; defaults to the global `fetch`.
			* @param base - resolver of the host base URL.
			*/
			constructor(fetcher = (input, init) => fetch(input, init), base = hostBase) {
				this.fetcher = fetcher;
				this.base = base;
			}
			/**
			* Read a session's stored configuration.
			* @param sessionId - the session.
			* @returns the stored configuration, or null when none.
			* @throws {ConfigHttpError} when the route is unreachable or refuses.
			*/
			async load(sessionId) {
				return (await this.loadState(sessionId)).config;
			}
			/**
			* Read what the host says about a session in one request: its stored
			* configuration and the skill the host offers.
			* @param sessionId - the session.
			* @returns the stored configuration (null when none) and the skill offer (null when the host does not say).
			* @throws {ConfigHttpError} when the route is unreachable or refuses.
			*/
			async loadState(sessionId) {
				const url = new URL(CONFIG_ROUTE, this.base());
				url.searchParams.set("sessionId", sessionId);
				const payload = await this.call(url, { headers: { accept: "application/json" } });
				return {
					config: payload.config,
					skill: payload.skill
				};
			}
			/**
			* Store (or clear, with null) a session's configuration.
			* @param sessionId - the session.
			* @param config - the configuration, or null to clear.
			* @returns the configuration as the host stored it.
			* @throws {ConfigHttpError} when the route is unreachable or refuses.
			*/
			async save(sessionId, config) {
				const body = {
					sessionId,
					config: config === null ? null : toWireConfig(config)
				};
				return (await this.call(new URL(CONFIG_ROUTE, this.base()), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				})).config;
			}
			/** One request: bounded time, structured failure, validated success body. */
			async call(url, init) {
				let response;
				try {
					response = await this.fetcher(url, {
						...init,
						signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$1)
					});
				} catch (cause) {
					throw new ConfigHttpError(0, void 0, cause instanceof Error ? cause.message : String(cause));
				}
				const body = await response.json().catch(() => void 0);
				if (!response.ok || body === void 0 || !("config" in body)) throw new ConfigHttpError(response.status, body?.code, body?.message);
				const config = body.config === null ? null : parseConfig(body.config);
				if (config === void 0) throw new ConfigHttpError(response.status, "internal", "the host answered a malformed configuration");
				return {
					sessionId: String(body.sessionId ?? ""),
					config,
					skill: parseSkillOffer(body.skill)
				};
			}
		};
		//#endregion
		//#region src/client/observable.ts
		/**
		* Create a store.
		* @param initial - the first snapshot.
		* @returns the store; `set` notifies subscribers only when the value changed.
		*/
		function createStore(initial) {
			let value = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => value,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(next) {
					if (Object.is(next, value)) return;
					value = next;
					for (const listener of [...listeners]) try {
						listener();
					} catch (error) {
						console.error("dsh-orquestrator: store subscriber failed", error);
					}
				}
			};
		}
		//#endregion
		//#region src/client/dialogs.ts
		/** Coordinates the page's single modal. */
		var DialogHost = class {
			/** The dialog on screen, or null. */
			current;
			/** Bumps whenever a presenter registers or leaves, so mounted composers re-check who presents. */
			presence;
			currentStore = createStore(null);
			presenceStore = createStore(0);
			queue = [];
			presenters = /* @__PURE__ */ new Map();
			nextId = 1;
			constructor() {
				this.current = this.currentStore;
				this.presence = this.presenceStore;
			}
			/**
			* Raise a dialog. Resolves with the user's answer; an aborted signal
			* resolves as a cancel (a superseded send must not leave a dialog behind), and
			* so does a session that has no composer mounted to render the dialog.
			* @param input - session, mode, preview, initial values, skill offer and persistence.
			* @param signal - optional cancellation of the surrounding operation.
			* @returns the answer.
			*/
			request(input, signal) {
				return new Promise((resolvePromise) => {
					let done = false;
					const settle = (result) => {
						if (done) return;
						done = true;
						signal?.removeEventListener("abort", onAbort);
						try {
							input.onAnswer?.(result);
						} catch {}
						resolvePromise(result);
					};
					const pending = {
						id: this.nextId++,
						input,
						shown: void 0,
						settle
					};
					const onAbort = () => {
						this.finish(pending, { kind: "cancel" });
					};
					if (signal?.aborted === true) {
						settle({ kind: "cancel" });
						return;
					}
					signal?.addEventListener("abort", onAbort, { once: true });
					this.queue.push(pending);
					this.advance();
				});
			}
			/**
			* Register a mounted composer as able to render dialogs for a session.
			* @param sessionId - the composer's session.
			* @param token - a unique token identifying the mount.
			* @returns the unregister function.
			*/
			registerPresenter(sessionId, token) {
				const tokens = this.presenters.get(sessionId) ?? /* @__PURE__ */ new Set();
				tokens.add(token);
				this.presenters.set(sessionId, tokens);
				this.presenceStore.set(this.presenceStore.getSnapshot() + 1);
				return () => {
					const set = this.presenters.get(sessionId);
					if (set === void 0) return;
					set.delete(token);
					if (set.size === 0) this.presenters.delete(sessionId);
					this.presenceStore.set(this.presenceStore.getSnapshot() + 1);
					this.advance();
				};
			}
			/**
			* Whether any mounted composer can render a dialog for the session.
			* @param sessionId - the session.
			* @returns true when at least one presenter is registered.
			*/
			hasPresenter(sessionId) {
				return (this.presenters.get(sessionId)?.size ?? 0) > 0;
			}
			/**
			* The sessions that have a composer mounted right now: the conversations visible on this page.
			* @returns the session ids, in registration order.
			*/
			presenterSessionIds() {
				return [...this.presenters.keys()];
			}
			/**
			* Whether a given mount is THE presenter of the session (the first one
			* registered renders; later mounts of the same session stay silent so the
			* dialog never doubles).
			* @param sessionId - the session.
			* @param token - the mount's token.
			* @returns true when the token is the session's presenter.
			*/
			isPresenter(sessionId, token) {
				const first = this.presenters.get(sessionId)?.values().next();
				return first?.done === false && first.value === token;
			}
			/** Finish one request and start the next queued one. */
			finish(pending, result) {
				const index = this.queue.indexOf(pending);
				if (index >= 0) this.queue.splice(index, 1);
				if (pending.shown !== void 0 && this.currentStore.getSnapshot() === pending.shown) this.currentStore.set(null);
				pending.settle(result);
				this.advance();
			}
			/**
			* Bring the queue up to date: cancel every request whose session has no composer left to render it (the one on
			* screen and the ones waiting alike), then put the head of the rest on screen when nothing is.
			*/
			advance() {
				const onScreen = this.currentStore.getSnapshot();
				for (const pending of [...this.queue]) {
					if (this.hasPresenter(pending.input.sessionId)) continue;
					this.queue.splice(this.queue.indexOf(pending), 1);
					if (pending.shown !== void 0 && pending.shown === onScreen) this.currentStore.set(null);
					pending.settle({ kind: "cancel" });
				}
				while (this.currentStore.getSnapshot() === null) {
					const head = this.queue[0];
					if (head === void 0) return;
					let request;
					try {
						request = this.render(head);
					} catch {
						this.queue.shift();
						head.settle({ kind: "cancel" });
						continue;
					}
					head.shown = request;
					this.currentStore.set(request);
				}
			}
			/** The request as the renderer sees it, with the pre-fill read now. */
			render(pending) {
				const { input } = pending;
				return {
					id: pending.id,
					sessionId: input.sessionId,
					mode: input.mode,
					preview: input.preview,
					initial: typeof input.initial === "function" ? input.initial() : input.initial,
					skill: input.skill,
					skillInMessage: input.skillInMessage,
					initialSkill: typeof input.initialSkill === "function" ? input.initialSkill() : input.initialSkill,
					save: input.save,
					resolve: (result) => {
						this.finish(pending, result);
					}
				};
			}
		};
		//#endregion
		//#region src/client/skill-token.ts
		/** Whether a part is a text part. */
		function isTextPart(part) {
			return part.type === "text" && typeof part.text === "string";
		}
		/** Escape a string for literal use inside a regular expression. */
		function escapeRegExp(text) {
			return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
		/**
		* Whether a prompt already carries a skill's token.
		* @param content - the prompt parts.
		* @param name - the skill name (kebab-case), without the leading slash.
		* @returns true when some text part contains `/name` as a whole word, that is
		* preceded by whitespace or the start of the text and followed by whitespace or
		* the end of it (so `/name-more`, `a/name`, `//name` and `/name,` do not count).
		*/
		function hasSkillToken(content, name) {
			const token = new RegExp(`(^|\\s)/${escapeRegExp(name)}(?=\\s|$)`);
			return content.some((part) => isTextPart(part) && token.test(part.text));
		}
		/**
		* Put a skill's token at the end of a prompt's text, on a line of its own.
		*
		* The last text part gets the token after its text: on a new line, or right
		* after the whitespace the text already ends with (just the token when that
		* text is empty or only whitespace). A prompt with no text part at all, such as
		* one that carries only attachments, gets a new text part holding the token in
		* front of the original parts. A prompt that already carries the token is
		* returned as it is, so applying the skill twice never doubles the token.
		*
		* The end, not the start, because DSH names a conversation after the first words
		* of its first message: a token in front would put `/orchestrate-subagents` in
		* the title of every conversation that applies the skill.
		* @param content - the prompt parts; never modified.
		* @param name - the skill name (kebab-case), without the leading slash.
		* @returns a new array, in the same order, whose parts are the input's own
		* objects except the one text part that was rewritten (a copy) or the one that
		* was added.
		*/
		function withSkillToken(content, name) {
			if (hasSkillToken(content, name)) return [...content];
			const token = `/${name}`;
			const last = content.findLastIndex(isTextPart);
			if (last === -1) return [{
				type: "text",
				text: token
			}, ...content];
			return content.map((part, index) => {
				if (index !== last || !isTextPart(part)) return part;
				return {
					...part,
					text: appendToken(part.text, token)
				};
			});
		}
		/** The text with the token after it: on a new line, unless the text is empty or already ends with whitespace. */
		function appendToken(text, token) {
			if (text.trim() === "") return token;
			return /\s$/.test(text) ? `${text}${token}` : `${text}\n${token}`;
		}
		//#endregion
		//#region src/client/gate.ts
		/**
		* The prompt gate: the seam between "the user pressed send" and "the prompt
		* reaches the host". Every browser-authored message goes through
		* `SessionFace.prompt`, so the gate wraps that one method on the mounted
		* session face. Before EVERY message the user sends from the composer it
		* raises the modal and waits for the answer — plain text, `@file` references
		* or `/skill` invocations, in any conversation, however the send is labelled
		* (queue or steer). The operator's rule (0.6.0): the modal always asks, and
		* only an empty send passes straight through. Early builds skipped `/` lines,
		* running turns and subagent conversations, so every task that began with a
		* skill invocation never saw the dialog.
		*
		* The gate is fail-open by construction: any problem (no composer mounted to
		* show the dialog, an exception here) sends the prompt exactly as stock DSH
		* would. It can delay a send, and only a cancel drops one. A missing or
		* unreadable host route still asks: a dialog whose save fails out loud beats a
		* modal that never appears.
		*
		* The answer can also change what is sent. When the host offers the global
		* orchestration skill and the user leaves its checkbox ticked, the prompt goes
		* out carrying the skill's `/name` token, which is what makes the host load the
		* skill for that message. Unticked, or with no skill on offer, the prompt goes
		* out untouched. A message that already carries the token keeps it (the host
		* loads the skill whatever the box says), so the dialog shows the box ticked
		* and locked for it.
		*
		* A cancel is not a send: Cancel, the ✕, Escape and a mask click abort the
		* message. The gate then never calls the host's `prompt`, and answers the
		* composer with a failure result (`ok: false`, no message text) instead of an
		* acceptance. That is the one answer the composer's submit machine treats as a
		* non-send: it puts the typed draft back in the editor and surfaces no notice
		* (`onSinkSettled` returns nothing when neither the outcome nor the rejection
		* carries a message: `packages/client/ui-conversation/src/client/input/machine.ts`),
		* and `sendSession` maps it to `{ kind: 'error' }` without touching the
		* transcript (`packages/client/ui-conversation/src/client/service.ts`). A
		* rejected promise would also restore the draft, but it surfaces a toast; an
		* `ok: true` acceptance would clear the draft and lose the text. Nothing is
		* stored: the gate's answer carries no choice, so neither memory is written.
		*
		* The composer registers a local echo of the send before it calls `prompt`
		* (`beginSubmission`, `ISession`), and that echo is what paints the pending
		* bubble while the dialog is up. A send that never reaches `prompt` must retire
		* it (the documented `SubmissionHandle.abandon`: "retire the echo as failed
		* when the caller cannot reach prompt()"), or the bubble would stay in the
		* conversation for a message that will never run. The gate therefore reads that
		* one seam too, and abandons the echo of the exact send it aborted — and only
		* that one: every other outcome hands the send to the original `prompt`, which
		* retires its own echo when it fails and on acceptance.
		*
		* Sends of one conversation pass the gate one at a time, in the order they were
		* made: a second send waits for the first to be answered, so the dialogs come up
		* in that order and each opens with what the one before it left behind.
		* @module dsh-orquestrator/client/gate
		*/
		/** Longest task preview shown in the dialog. */
		const PREVIEW_CHARS = 240;
		/** How often {@link attachWhenAvailable} looks for a session face that is not there yet. */
		const ATTACH_POLL_MS = 500;
		/**
		* How many unsettled send echoes are remembered at once. One send keeps its echo from `beginSubmission` until its
		* `prompt` settles; the bound only covers a caller that registers an echo and never sends it, and it can never mix
		* two sends up (the identity is a fresh one per send).
		*/
		const ECHO_MEMORY = 16;
		/**
		* What one `prompt` call resolves with when the dialog aborted the send. `ok: false` is exactly the composer's
		* non-send branch: `sendSession` maps it to `{ kind: 'error' }` without a transcript change, the submit machine puts
		* the draft back and, because neither the outcome nor a rejection carries a message, surfaces no notice at all. The
		* `error` field is well formed for any other caller that reads `result.error` (for example `conversation.send`).
		*/
		const ABORTED_SEND = Object.freeze({
			ok: false,
			error: Object.freeze({
				code: "dsh-orquestrator/send-aborted",
				message: "the orchestration dialog aborted this send: nothing was sent and the text is still in the composer"
			})
		});
		/**
		* Read the echo seam off a patch target.
		* @param target - the patched object (a session class prototype, or a single face).
		* @returns the method that registers a send's echo, or undefined when the face has none.
		*/
		function echoSeamOf(target) {
			const candidate = target.beginSubmission;
			return typeof candidate === "function" ? candidate : void 0;
		}
		/**
		* Narrow what `beginSubmission` answered to something that can be retired.
		* @param registered - whatever the seam returned.
		* @returns the echo handle, or undefined for a shape this gate does not know (then nothing is retired).
		*/
		function echoOf(registered) {
			if (typeof registered !== "object" || registered === null) return void 0;
			const candidate = registered;
			if (candidate.requestId === void 0 || typeof candidate.abandon !== "function") return void 0;
			return candidate;
		}
		/**
		* Join the text parts of a prompt.
		* @param content - the prompt parts.
		* @returns the concatenated text.
		*/
		function textOf(content) {
			return content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
		}
		/**
		* Collapse a task into a one-line preview.
		* @param text - the prompt text.
		* @returns whitespace-collapsed, bounded text.
		*/
		function previewOf(text) {
			const flat = text.replace(/\s+/g, " ").trim();
			return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, 239)}\u2026`;
		}
		/**
		* Choose where the wrapper goes: the prototype that owns `prompt` when the
		* face is an instance of a real class, else the face itself. Never
		* `Object.prototype` or a prototype without an own function `prompt`.
		* @param face - a session face.
		* @returns the object to patch.
		*/
		function patchTargetOf(face) {
			const proto = Object.getPrototypeOf(face);
			if (typeof proto === "object" && proto !== null && proto !== Object.prototype && Object.prototype.hasOwnProperty.call(proto, "prompt") && typeof proto.prompt === "function" && !Object.prototype.hasOwnProperty.call(face, "prompt")) return proto;
			return face;
		}
		/**
		* Whether the face is an addressed subagent conversation: the user is typing to a child, not to the agent that
		* coordinates. The orchestration skill is for the coordinator (it says so itself), so it is never offered there.
		* @param face - the session face sending the prompt.
		* @returns true for a subagent conversation; false for anything else, including a face that cannot say.
		*/
		function isSubagentConversation(face) {
			try {
				const subagent = face.getSnapshot().subagent;
				return subagent !== null && subagent !== void 0;
			} catch {
				return false;
			}
		}
		/**
		* Wait until the sends ahead of this one have been answered. A send that is aborted stops waiting: it has nothing
		* left to ask, and it must not sit behind another message's dialog.
		* @param turn - settles when everything ahead is done.
		* @param signal - cancellation of the surrounding send.
		*/
		async function untilTurn(turn, signal) {
			if (signal === void 0) {
				await turn;
				return;
			}
			if (signal.aborted) return;
			let stop = () => {};
			const aborted = new Promise((resolve) => {
				stop = resolve;
				signal.addEventListener("abort", stop, { once: true });
			});
			try {
				await Promise.race([turn, aborted]);
			} finally {
				signal.removeEventListener("abort", stop);
			}
		}
		/** The gate. */
		var PromptGate = class {
			/** Patched objects (a session class prototype, or a single face) with their attach counts. */
			patched = /* @__PURE__ */ new Map();
			/** The local echo of each send the composer has registered and not yet sent, by the identity its prompt will carry. */
			echoes = /* @__PURE__ */ new Map();
			/** The end of each conversation's line of sends: what the next send has to wait for. Never rejects. */
			lines = /* @__PURE__ */ new Map();
			/** What the host said about the skill the last time it was read; undefined until a read has succeeded. */
			lastSkill;
			deps;
			/**
			* @param deps - HTTP client, dialog host, last-choice and skill-choice memories, and diagnostics.
			*/
			constructor(deps) {
				this.deps = deps;
			}
			/**
			* Wrap `prompt` for as long as the returned disposer is not called. The
			* wrapper goes on the session class prototype when the face inherits
			* `prompt` from one (so a re-created face after a reconnect is covered too),
			* and on the single face otherwise. Attachments are reference-counted, so
			* two composers never stack wrappers and the last detach restores the
			* original method exactly. The wrapper sends the content {@link beforePrompt}
			* decides on (the original content when the gate fails), after the earlier
			* sends of the same conversation have been answered; when the decision is an
			* abort it never calls the original at all, answers {@link ABORTED_SEND} and
			* retires the composer's own echo of that send.
			*
			* The echo seam (`beginSubmission`) is wrapped with `prompt` when the face has
			* it, and only to look at: the same call, the same handle back, plus a record
			* of it keyed by the identity the following `prompt` will carry. A detach
			* restores both methods, and each only if it is still the one this attach put
			* there.
			* @param face - the session face of a mounted composer.
			* @returns the detach function.
			*/
			attach(face) {
				const target = patchTargetOf(face);
				const existing = this.patched.get(target);
				if (existing !== void 0) {
					existing.count += 1;
					return () => {
						this.release(target);
					};
				}
				const holder = target;
				const original = holder.prompt;
				const originalEcho = echoSeamOf(target);
				const gate = this;
				const wrapper = async function wrapped(content, mode, signal, requestId) {
					let decision = {
						kind: "send",
						content
					};
					let release = () => {};
					try {
						const place = gate.joinLine(this.sessionId);
						release = place.release;
						await untilTurn(place.turn, signal);
						decision = await gate.beforePrompt(this, content, mode, signal);
					} catch (error) {
						decision = {
							kind: "send",
							content
						};
						gate.deps.warn("gate failed; sending as stock DSH would", error);
					}
					try {
						if (decision.kind === "abort") {
							gate.abandonEcho(requestId);
							return ABORTED_SEND;
						}
						return original.call(this, decision.content, mode, signal, requestId);
					} finally {
						gate.forgetEcho(requestId);
						release();
					}
				};
				const wrappedEcho = originalEcho === void 0 ? void 0 : function wrappedSubmission(input) {
					const registered = originalEcho.call(this, input);
					const echo = echoOf(registered);
					if (echo !== void 0) gate.rememberEcho(echo);
					return registered;
				};
				const hadOwn = Object.prototype.hasOwnProperty.call(target, "prompt");
				const hadOwnEcho = wrappedEcho !== void 0 && Object.prototype.hasOwnProperty.call(target, "beginSubmission");
				holder.prompt = wrapper;
				if (wrappedEcho !== void 0) holder.beginSubmission = wrappedEcho;
				const restore = () => {
					if (holder.prompt === wrapper) {
						if (hadOwn) holder.prompt = original;
						else delete holder.prompt;
					}
					if (wrappedEcho !== void 0 && holder.beginSubmission === wrappedEcho) {
						if (hadOwnEcho) holder.beginSubmission = originalEcho;
						else delete holder.beginSubmission;
					}
				};
				this.patched.set(target, {
					count: 1,
					restore
				});
				return () => {
					this.release(target);
				};
			}
			/** Remember one send's echo, bounded: only an echo its own `prompt` never reaches can stay behind. */
			rememberEcho(echo) {
				this.echoes.set(echo.requestId, echo);
				while (this.echoes.size > ECHO_MEMORY) {
					const oldest = this.echoes.keys().next();
					if (oldest.done === true) break;
					this.echoes.delete(oldest.value);
				}
			}
			/** Retire the echo of one aborted send, if the face registered one: never another send's, never throwing. */
			abandonEcho(requestId) {
				if (requestId === void 0) return;
				const echo = this.echoes.get(requestId);
				this.echoes.delete(requestId);
				if (echo === void 0) return;
				try {
					echo.abandon();
				} catch (error) {
					this.deps.warn("could not retire the echo of an aborted send", error);
				}
			}
			/** Drop a sent send's echo record: the original `prompt` retires it from here on. */
			forgetEcho(requestId) {
				if (requestId === void 0) return;
				this.echoes.delete(requestId);
			}
			/** Drop one attachment; the last one restores the patched object. */
			release(target) {
				const entry = this.patched.get(target);
				if (entry === void 0) return;
				entry.count -= 1;
				if (entry.count > 0) return;
				entry.restore();
				this.patched.delete(target);
			}
			/**
			* Take a place in a conversation's line of sends. `turn` settles when every send ahead has been released; the
			* caller must call `release` once its own send is on its way, whatever happened, or the line stops.
			*/
			joinLine(sessionId) {
				const before = this.lines.get(sessionId);
				let release = () => {};
				const mine = new Promise((resolve) => {
					release = resolve;
				});
				const end = before === void 0 ? mine : before.then(() => mine);
				this.lines.set(sessionId, end);
				end.then(() => {
					if (this.lines.get(sessionId) === end) this.lines.delete(sessionId);
				});
				return {
					turn: before ?? Promise.resolve(),
					release
				};
			}
			/** Run one of the remembered-choice reads: a memory that breaks costs the pre-fill, never the dialog. */
			recall(read, fallback) {
				try {
					return read();
				} catch (error) {
					this.deps.warn("could not read a remembered choice", error);
					return fallback;
				}
			}
			/**
			* Remember an answer for the next dialog. Each memory is written on its own and a failure only costs the
			* convenience: what is sent never depends on it. Both choices are real answers: the subagent-model one even
			* with the switch off (an off choice is what the user chose), and the skill one whatever the switch says,
			* because the checkbox is interactive either way.
			* @param answer - how the dialog ended.
			* @param skillAsked - whether the skill question was offered and not forced by a typed token. Only then is
			* there an answer to remember: a box locked by a token in the message, or no box at all, was not a question,
			* and writing its forced `applySkill` would reset the user's preference.
			*/
			remember(answer, skillAsked) {
				if (answer.kind !== "confirm") return;
				try {
					this.deps.memory.write(answer.config);
				} catch (error) {
					this.deps.warn("could not remember the choice", error);
				}
				if (!skillAsked) return;
				try {
					this.deps.skillMemory.write(answer.applySkill);
				} catch (error) {
					this.deps.warn("could not remember the skill answer", error);
				}
			}
			/**
			* Ask before this message goes out. Every message the user sends from the
			* composer is worth asking about: a task that begins with a `/skill`
			* invocation is a task, and so is a follow-up typed while a turn runs. The
			* only thing that passes straight through is a send with no content at all.
			* @param face - the session face sending the prompt.
			* @param content - the prompt parts; never modified.
			* @param _mode - the delivery mode the composer chose (no longer a reason to stay silent).
			* @param signal - cancellation of the surrounding send.
			* @returns what to do with the send, once the answer is in. A confirm answers
			* `send` with the same parts, plus the skill's token when the host offered the
			* skill and the user left it ticked; every other answer that is not a cancel
			* (an unticked skill, a skill the host did not offer, a message that already
			* carries the token, an empty or already aborted send, a dialog nobody can
			* show) answers `send` with the parts untouched. A cancel answers `abort`:
			* the message never reaches the host, and nothing about it is stored.
			*/
			async beforePrompt(face, content, _mode, signal) {
				const text = textOf(content).trim();
				if (text === "" && content.length === 0) return {
					kind: "send",
					content
				};
				if (signal?.aborted === true) return {
					kind: "send",
					content
				};
				const sessionId = face.sessionId;
				const { client, dialogs, memory, skillMemory } = this.deps;
				let stored = null;
				let skill;
				try {
					const state = await client.loadState(sessionId);
					stored = state.config;
					skill = state.skill;
					this.lastSkill = skill;
				} catch (error) {
					skill = this.lastSkill ?? null;
					this.deps.warn("configuration route unavailable; asking with defaults", error);
				}
				if (!dialogs.hasPresenter(sessionId)) {
					if (isActive(stored)) await client.save(sessionId, null).catch((error) => {
						this.deps.warn("could not clear a stale choice", error);
					});
					return {
						kind: "send",
						content
					};
				}
				const offer = skill !== null && skill.available && !isSubagentConversation(face) ? skill : null;
				const typed = offer !== null && hasSkillToken(content, offer.name);
				const result = await dialogs.request({
					sessionId,
					mode: "gate",
					preview: previewOf(text),
					initial: () => stored ?? this.recall(() => memory.read(), null) ?? OFF_CONFIG,
					skill: offer,
					skillInMessage: typed,
					initialSkill: () => this.recall(() => skillMemory.read(), null) ?? true,
					save: async (config) => {
						await client.save(sessionId, config);
					},
					onAnswer: (answer) => {
						this.remember(answer, offer !== null && !typed);
					}
				}, signal);
				if (result.kind !== "confirm") return { kind: "abort" };
				if (offer === null || typed) return {
					kind: "send",
					content
				};
				return {
					kind: "send",
					content: result.applySkill ? withSkillToken(content, offer.name) : content
				};
			}
		};
		/**
		* Attach the gate to a session face as soon as one exists, and keep looking
		* for as long as the composer lives. A session's binding can materialize
		* seconds after the composer mounts (a cold session, a heavy workspace, a
		* reconnect), and an attach that gave up quietly sent every task of that
		* conversation as stock DSH — the modal simply never appeared there. The poll
		* is cheap and stops the moment the gate is attached or the composer unmounts.
		* @param resolveFace - resolves the mounted session face, or undefined while it is not there yet.
		* @param gate - the gate to attach.
		* @param warn - diagnostics sink (never user-visible).
		* @param schedule - timer scheduler (injectable for tests).
		* @param cancel - timer cancellation (injectable for tests).
		* @returns the detach function.
		*/
		function attachWhenAvailable(resolveFace, gate, warn, schedule = (callback, ms) => setTimeout(callback, ms), cancel = (handle) => {
			clearTimeout(handle);
		}) {
			let detach;
			let handle;
			let disposed = false;
			const tryAttach = () => {
				handle = void 0;
				if (disposed || detach !== void 0) return;
				let face;
				try {
					face = resolveFace();
				} catch (error) {
					warn("could not look up the session face; will keep trying", error);
				}
				if (face !== void 0) {
					try {
						detach = gate.attach(face);
					} catch (error) {
						warn("could not attach the prompt gate; will keep trying", error);
					}
					if (detach !== void 0) return;
				}
				handle = schedule(tryAttach, ATTACH_POLL_MS);
			};
			tryAttach();
			return () => {
				disposed = true;
				if (handle !== void 0) cancel(handle);
				detach?.();
			};
		}
		/**
		* Memory of the last confirmed choice, kept in `localStorage` (best effort).
		* @param storage - a Storage-like object, or undefined when unavailable.
		* @returns the memory.
		*/
		function createLastChoiceMemory(storage) {
			const KEY = "dsh-orquestrator:last:v1";
			return {
				read() {
					try {
						const raw = storage?.getItem(KEY);
						if (raw == null) return null;
						const parsed = parseConfig(JSON.parse(raw));
						return parsed === void 0 ? null : parsed;
					} catch {
						return null;
					}
				},
				write(config) {
					try {
						storage?.setItem(KEY, JSON.stringify(config));
					} catch {}
				}
			};
		}
		/**
		* Memory of the last answer to the skill checkbox, kept in `localStorage`
		* (best effort): `'on'` or `'off'`. Anything else, a missing storage and a
		* storage that throws all read as "no answer yet".
		* @param storage - a Storage-like object, or undefined when unavailable.
		* @returns the memory.
		*/
		function createSkillChoiceMemory(storage) {
			const KEY = "dsh-orquestrator:skill:v1";
			return {
				read() {
					try {
						const raw = storage?.getItem(KEY);
						if (raw === "on") return true;
						if (raw === "off") return false;
						return null;
					} catch {
						return null;
					}
				},
				write(on) {
					try {
						storage?.setItem(KEY, on ? "on" : "off");
					} catch {}
				}
			};
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Dictionaries of the dialog and the command (English, Portuguese, Chinese).
		* English is the fallback the locale system requires; Simplified Chinese is a
		* built-in locale; Portuguese is registered as an extra language when no other
		* plugin already did. Copy avoids em dashes and filler verbs on purpose.
		* @module dsh-orquestrator/client/locales
		*/
		/** Dictionary namespace owned by this plugin. */
		const NS = "orquestrator";
		/** English dictionary (source of the key union). */
		const en = {
			"dialog.title": "Orchestrate subagents",
			"dialog.close": "Close",
			"dialog.description.gate": "Choose how subagents handle this task. Cancel sends nothing: the text stays in the composer.",
			"dialog.description.configure": "Choose how subagents work in this conversation. The options apply from the next task.",
			"task.label": "Task",
			"subagents.title": "Subagent model",
			"subagents.switch": "Use a different model for subagents",
			"subagents.same": "Subagents use the main agent's model ({model}). Turn on to choose another.",
			"subagents.same.unknown": "Subagents use the main agent's model. Turn on to choose another.",
			"subagents.modelLabel": "Model for subagents",
			"subagents.needModel": "Choose a model to continue.",
			"subagents.main": "The main agent stays on {model}.",
			"subagents.scope": "Applies to every subagent, including the agents a workflow starts.",
			"button.cancel": "Cancel",
			"button.cancelHint": "Sends nothing: the task stays as a draft",
			"button.confirm.gate": "Send with these options",
			"button.confirm.configure": "Save",
			"button.saving": "Saving...",
			"button.needModel": "Choose a subagent model first",
			"picker.placeholder": "Choose a model",
			"picker.loading": "Loading models...",
			"picker.error": "Could not load the models",
			"picker.retry": "Try again",
			"error.save": "Could not save the options: {message}",
			"command.label": "Orchestrate subagents",
			"command.description": "Choose the subagent model for this conversation",
			"dock.title": "Subagent orchestration in this conversation: {summary}. Click to change.",
			"dock.loading": "Subagents: …",
			"dock.off": "Subagents: same as the main agent",
			"dock.model": "Subagents: {model} · {effort}",
			"dock.sameEffort": "Subagents: same as the main agent · {effort}",
			"dock.recommended": "recommended",
			"effort.label": "Reasoning effort",
			"effort.defaultOption": "Model default",
			"facts.audio": "Understands audio",
			"facts.audio.off": "No audio",
			"facts.photo": "Understands images",
			"facts.photo.off": "No images",
			"facts.text": "Understands text",
			"facts.text.off": "No text",
			"facts.video": "Understands video",
			"facts.video.off": "No video",
			"facts.tb4": "Terminal-Bench 4 · {value}",
			"facts.intelligence": "Intelligence · {value}",
			"note.redirected": "DeepSeek's own API now routes this model to V4.1 Flash, so it is not a different model.",
			"note.overthinks": "At high effort it can spend its whole token budget on one numeric edge case. The recommended level avoids that.",
			"note.slowAtHighEffort": "Can take about two minutes per turn at high effort. Prefer a lower level or the UltraSpeed variant.",
			"note.premiumVariant": "Much faster than the standard model, at about ten times the price per token.",
			"note.textOnly": "Text only: it cannot look at screenshots or images.",
			"note.reasoningAlwaysOn": "Reasoning cannot be turned off for this model.",
			"note.maxEffortRegresses": "At maximum effort it tends to over-edit and costs far more. High is the recommended ceiling.",
			"skill.title": "Orchestration skill",
			"skill.checkbox": "Apply the orchestration skill to this task",
			"skill.hint": "Teaches the main agent to split the work into small pieces, run subagents in parallel, send them to read the code and report back, and check every result with verifier subagents. Adds {token} to the message.",
			"sub.status.running": "Running",
			"sub.status.done": "Done",
			"sub.status.failed": "Failed",
			"sub.status.failedReason": "Failed: {reason}",
			"sub.reason.error": "error",
			"sub.reason.max-tokens": "token limit reached",
			"sub.reason.refusal": "declined the task",
			"sub.status.stopped": "Stopped",
			"sub.status.unknown": "Outcome not recorded",
			"sub.model.title": "This subagent runs on {model}",
			"sub.model.titleEffort": "This subagent runs on {model}, reasoning effort {effort}",
			"skill.typed": "The message already contains {token}, so the skill applies."
		};
		/** Portuguese (Brazil) dictionary. */
		const pt = {
			"dialog.title": "Orquestrar subagentes",
			"dialog.close": "Fechar",
			"dialog.description.gate": "Escolha como os subagentes tratam esta tarefa. Cancelar não envia nada: o texto fica no compositor.",
			"dialog.description.configure": "Escolha como os subagentes trabalham nesta conversa. As opções valem a partir da próxima tarefa.",
			"task.label": "Tarefa",
			"subagents.title": "Modelo dos subagentes",
			"subagents.switch": "Usar outro modelo nos subagentes",
			"subagents.same": "Os subagentes usam o modelo do agente principal ({model}). Ligue para escolher outro.",
			"subagents.same.unknown": "Os subagentes usam o modelo do agente principal. Ligue para escolher outro.",
			"subagents.modelLabel": "Modelo dos subagentes",
			"subagents.needModel": "Escolha um modelo para continuar.",
			"subagents.main": "O agente principal continua em {model}.",
			"subagents.scope": "Vale para todo subagente, inclusive os agentes que um workflow inicia.",
			"button.cancel": "Cancelar",
			"button.cancelHint": "Não envia nada: a tarefa fica como rascunho",
			"button.confirm.gate": "Enviar com estas opções",
			"button.confirm.configure": "Salvar",
			"button.saving": "Salvando...",
			"button.needModel": "Escolha antes o modelo dos subagentes",
			"picker.placeholder": "Escolha um modelo",
			"picker.loading": "Carregando modelos...",
			"picker.error": "Não foi possível carregar os modelos",
			"picker.retry": "Tentar de novo",
			"error.save": "Não foi possível salvar as opções: {message}",
			"command.label": "Orquestrar subagentes",
			"command.description": "Escolha o modelo dos subagentes nesta conversa",
			"dock.title": "Orquestração de subagentes nesta conversa: {summary}. Clique para mudar.",
			"dock.loading": "Subagentes: …",
			"dock.off": "Subagentes: mesmo modelo do agente principal",
			"dock.model": "Subagentes: {model} · {effort}",
			"dock.sameEffort": "Subagentes: mesmo modelo do agente principal · {effort}",
			"dock.recommended": "recomendado",
			"effort.label": "Esforço de raciocínio",
			"effort.defaultOption": "Padrão do modelo",
			"facts.audio": "Entende áudio",
			"facts.audio.off": "Sem áudio",
			"facts.photo": "Entende imagens",
			"facts.photo.off": "Sem imagens",
			"facts.text": "Entende texto",
			"facts.text.off": "Sem texto",
			"facts.video": "Entende vídeo",
			"facts.video.off": "Sem vídeo",
			"facts.tb4": "Terminal-Bench 4 · {value}",
			"facts.intelligence": "Inteligência · {value}",
			"note.redirected": "A API própria da DeepSeek agora direciona este modelo ao V4.1 Flash, então ele não é um modelo diferente.",
			"note.overthinks": "Em esforço alto pode gastar todo o orçamento de tokens num único caso de borda numérico. O nível recomendado evita isso.",
			"note.slowAtHighEffort": "Pode levar cerca de dois minutos por turno em esforço alto. Prefira um nível menor ou a variante UltraSpeed.",
			"note.premiumVariant": "Muito mais rápido que o modelo padrão, por cerca de dez vezes o preço por token.",
			"note.textOnly": "Só texto: não consegue olhar capturas de tela nem imagens.",
			"note.reasoningAlwaysOn": "O raciocínio não pode ser desligado neste modelo.",
			"note.maxEffortRegresses": "No esforço máximo tende a editar demais e custa bem mais. Alto é o teto recomendado.",
			"skill.title": "Skill de orquestração",
			"skill.checkbox": "Aplicar a skill de orquestração nesta tarefa",
			"skill.hint": "Ensina o agente principal a dividir o trabalho em partes pequenas, rodar subagentes em paralelo, mandá-los ler o código e relatar o que encontraram, e conferir cada resultado com subagentes verificadores. Adiciona {token} à mensagem.",
			"sub.status.running": "Rodando",
			"sub.status.done": "Concluído",
			"sub.status.failed": "Falhou",
			"sub.status.failedReason": "Falhou: {reason}",
			"sub.reason.error": "erro",
			"sub.reason.max-tokens": "limite de tokens atingido",
			"sub.reason.refusal": "recusou a tarefa",
			"sub.status.stopped": "Parado",
			"sub.status.unknown": "Resultado não registrado",
			"sub.model.title": "Este subagente roda em {model}",
			"sub.model.titleEffort": "Este subagente roda em {model}, esforço de raciocínio {effort}",
			"skill.typed": "A mensagem já contém {token}, então a skill se aplica."
		};
		/** Simplified Chinese dictionary. */
		const zh = {
			"dialog.title": "编排子智能体",
			"dialog.close": "关闭",
			"dialog.description.gate": "选择子智能体如何处理这项任务。取消不会发送：文本留在输入框中。",
			"dialog.description.configure": "选择子智能体在此对话中的工作方式。选项从下一个任务开始生效。",
			"task.label": "任务",
			"subagents.title": "子智能体模型",
			"subagents.switch": "为子智能体使用其他模型",
			"subagents.same": "子智能体使用主智能体的模型（{model}）。开启后可选择其他模型。",
			"subagents.same.unknown": "子智能体使用主智能体的模型。开启后可选择其他模型。",
			"subagents.modelLabel": "子智能体模型",
			"subagents.needModel": "请选择一个模型以继续。",
			"subagents.main": "主智能体继续使用 {model}。",
			"subagents.scope": "适用于每个子智能体，包括工作流启动的智能体。",
			"button.cancel": "取消",
			"button.cancelHint": "不发送任何内容：任务保留为草稿",
			"button.confirm.gate": "按这些选项发送",
			"button.confirm.configure": "保存",
			"button.saving": "正在保存...",
			"button.needModel": "请先选择子智能体模型",
			"picker.placeholder": "选择模型",
			"picker.loading": "正在加载模型...",
			"picker.error": "无法加载模型",
			"picker.retry": "重试",
			"error.save": "无法保存选项：{message}",
			"command.label": "编排子智能体",
			"command.description": "为此对话选择子智能体模型",
			"dock.title": "本会话的子智能体编排：{summary}。点击修改。",
			"dock.loading": "子智能体：…",
			"dock.off": "子智能体：与主智能体同模型",
			"dock.model": "子智能体：{model} · {effort}",
			"dock.sameEffort": "子智能体：与主智能体同模型 · {effort}",
			"dock.recommended": "推荐",
			"effort.label": "推理强度",
			"effort.defaultOption": "模型默认值",
			"facts.audio": "能理解音频",
			"facts.audio.off": "不支持音频",
			"facts.photo": "能理解图像",
			"facts.photo.off": "不支持图像",
			"facts.text": "能理解文本",
			"facts.text.off": "不支持文本",
			"facts.video": "能理解视频",
			"facts.video.off": "不支持视频",
			"facts.tb4": "Terminal-Bench 4 · {value}",
			"facts.intelligence": "智能指数 · {value}",
			"note.redirected": "DeepSeek 官方 API 现已将此模型路由到 V4.1 Flash，因此它并不是另一个模型。",
			"note.overthinks": "在高强度下，它可能把全部令牌预算耗在一个数值边界情况上。推荐级别可避免这种情况。",
			"note.slowAtHighEffort": "在高强度下每轮可能需要约两分钟。建议使用较低级别或 UltraSpeed 版本。",
			"note.premiumVariant": "比标准模型快得多，但每个令牌的价格约为十倍。",
			"note.textOnly": "仅支持文本：无法查看截图或图片。",
			"note.reasoningAlwaysOn": "此模型的推理无法关闭。",
			"note.maxEffortRegresses": "在最高强度下，它容易过度修改且成本高得多。推荐的上限是“高”。",
			"skill.title": "编排技能",
			"skill.checkbox": "对此任务应用编排技能",
			"skill.hint": "让主智能体把工作拆成小块、并行运行子智能体、让它们去读代码并汇报结果，并用验证子智能体检查每个结果。会在消息中加入 {token}。",
			"sub.status.running": "正在运行",
			"sub.status.done": "已完成",
			"sub.status.failed": "失败",
			"sub.status.failedReason": "失败：{reason}",
			"sub.reason.error": "错误",
			"sub.reason.max-tokens": "达到令牌上限",
			"sub.reason.refusal": "拒绝了任务",
			"sub.status.stopped": "已停止",
			"sub.status.unknown": "未记录结果",
			"sub.model.title": "此子智能体运行在 {model} 上",
			"sub.model.titleEffort": "此子智能体运行在 {model} 上，推理强度 {effort}",
			"skill.typed": "消息中已包含 {token}，因此会应用该技能。"
		};
		//#endregion
		//#region src/client/status.ts
		/** The inert status: no subagent model and no explicit level. */
		const OFF_STATUS = Object.freeze({
			ownModel: false,
			explicitEffort: false,
			model: "",
			effort: ""
		});
		/**
		* Resolve a reasoning level id to the name the catalog gives it, else the id.
		* @param groups - the catalog groups.
		* @param route - the route whose ladder owns the level (the subagent's, or the main agent's for an effort-only choice).
		* @param effort - the stored level id.
		* @returns the display label.
		*/
		function effortLabel(groups, route, effort) {
			if (route === null) return effort;
			return ladderOf(groups, route)?.efforts.find((level) => level.id === effort)?.name ?? effort;
		}
		/**
		* Summarize one session's stored choice for display.
		* @param config - the stored configuration, or null when none.
		* @param groups - the catalog groups (for model and level names).
		* @param current - the session's current route; an effort-only choice resolves its level against it.
		* @returns what the chip shows.
		*/
		function describeConfig(config, groups, current) {
			if (config === null) return OFF_STATUS;
			const hasModel = config.subagentModel !== null;
			const hasEffort = config.workerEffort !== null;
			if (!hasModel && !hasEffort) return OFF_STATUS;
			return {
				ownModel: hasModel,
				explicitEffort: hasEffort,
				model: hasModel ? modelName(groups, config.subagentModel) : "",
				effort: hasEffort ? effortLabel(groups, hasModel ? config.subagentModel : current, config.workerEffort) : ""
			};
		}
		//#endregion
		//#region src/client/ConfigChip.tsx
		/**
		* The dock chip: one ambient line under the composer that always says how
		* subagents are configured in this conversation — whether they run on a model
		* of their own, which model, and which reasoning effort — and opens the
		* orchestration dialog on click. It re-reads the stored choice whenever a
		* dialog (the gate's or `/orquestrar`) settles, so it never shows a stale
		* answer. Mounted on `conversation.composer.dock`, next to the host's own
		* ambient pills.
		* @module dsh-orquestrator/client/ConfigChip
		*/
		/**
		* The chip.
		* @param props - the composer's session id and the plugin host face.
		* @returns one clickable status line.
		*/
		function ConfigChip({ sessionId, host }) {
			const [state, setState] = (0, react.useState)(null);
			const dialogEpoch = (0, react.useSyncExternalStore)((listener) => host.dialogs.current.subscribe(listener), () => host.dialogs.current.getSnapshot() === null ? 0 : 1);
			(0, react.useSyncExternalStore)((listener) => host.locale.subscribe(listener), () => host.locale.getSnapshot());
			(0, react.useEffect)(() => {
				let alive = true;
				Promise.all([host.loadStored(sessionId).catch(() => null), host.loadCatalog(sessionId).catch(() => LOADING_CATALOG)]).then(([config, catalog]) => {
					if (alive) setState({
						config,
						catalog
					});
				});
				return () => {
					alive = false;
				};
			}, [
				host,
				sessionId,
				dialogEpoch
			]);
			const onClick = (0, react.useCallback)(() => {
				host.openConfigure(sessionId);
			}, [host, sessionId]);
			const t = host.locale.bind(NS);
			if (state === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dsh-orq-chip",
				"aria-label": t("dock.title", { summary: t("dock.loading") }),
				onClick,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: 12 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-chip-text",
					children: t("dock.loading")
				})]
			});
			const status = describeConfig(state.config, state.catalog.groups, state.catalog.current);
			const summary = status.ownModel ? t("dock.model", {
				model: status.model,
				effort: status.explicitEffort ? status.effort : t("dock.recommended")
			}) : status.explicitEffort ? t("dock.sameEffort", { effort: status.effort }) : t("dock.off");
			const active = status.ownModel || status.explicitEffort;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: active ? "dsh-orq-chip dsh-orq-chip-on" : "dsh-orq-chip",
				title: t("dock.title", { summary }),
				"aria-label": t("dock.title", { summary }),
				onClick,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: 12 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-chip-text",
					children: summary
				})]
			});
		}
		/**
		* Order a ladder low to high.
		* @param efforts - the levels as the catalog lists them.
		* @returns the same levels by reasoning rank; ids DSH does not define keep their place at the end.
		*/
		function byRank(efforts) {
			return [...efforts].sort((left, right) => {
				const a = rankOf(left.id);
				const b = rankOf(right.id);
				if (a < 0 && b < 0) return 0;
				if (a < 0) return 1;
				if (b < 0) return -1;
				return a - b;
			});
		}
		/**
		* The highest level of a ladder, by reasoning rank: what a model change picks.
		* @param ladder - the model's reasoning ladder, or undefined when it has none.
		* @returns the top level's id, or null when there is no level to pick.
		*/
		function highestEffortOf(ladder) {
			let best = null;
			let bestRank = Number.NEGATIVE_INFINITY;
			for (const effort of ladder?.efforts ?? []) {
				const rank = rankOf(effort.id);
				if (best === null || rank > bestRank) {
					best = effort.id;
					bestRank = rank;
				}
			}
			return best;
		}
		/**
		* The select.
		* @param props - see {@link EffortPickerProps}.
		* @returns the labeled native select.
		*/
		function EffortPicker(props) {
			const { id, label, efforts, value, neutralLabel, disabled, onChange } = props;
			const rows = (0, react.useMemo)(() => byRank(efforts), [efforts]);
			const kept = value !== null && !rows.some((row) => row.id === value) ? value : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-orq-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					className: "dsh-orq-field-label",
					htmlFor: id,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					id,
					className: "dsh-orq-select",
					value: value ?? "",
					disabled: disabled === true,
					onChange: (event) => {
						onChange(event.target.value === "" ? null : event.target.value);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "",
							children: neutralLabel
						}),
						kept === null ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: kept,
							children: kept
						}),
						rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: row.id,
							children: row.name
						}, row.id))
					]
				})]
			});
		}
		//#endregion
		//#region src/client/facts-icons.tsx
		/**
		* The shared frame: one 16-unit viewBox, stroke-only, decorative by contract.
		* @param props - the size and the paths of one glyph.
		* @returns the svg element.
		*/
		function Glyph({ size = 16, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
				children
			});
		}
		/**
		* A microphone: the model can take audio in.
		* @param props - the glyph size.
		* @returns the svg element.
		*/
		function FactsAudioIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, {
				size,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "6",
						y: "1.8",
						width: "4",
						height: "7.2",
						rx: "2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3.6 7.4a4.4 4.4 0 0 0 8.8 0" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 11.8v2.4" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.6 14.2h4.8" })
				]
			});
		}
		/**
		* A photo: a frame with a mountain and a sun, for image input.
		* @param props - the glyph size.
		* @returns the svg element.
		*/
		function FactsPhotoIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, {
				size,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "1.8",
						y: "3",
						width: "12.4",
						height: "10",
						rx: "2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10.3",
						cy: "6.2",
						r: "1.1"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.4 11.6l3.1-3.2 2.3 2.4" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8.4 10.4l2-2.1 3.2 3.3" })
				]
			});
		}
		/**
		* Three text lines: the model can take text in.
		* @param props - the glyph size.
		* @returns the svg element.
		*/
		function FactsTextIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, {
				size,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.8 4.4h10.4" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.8 8h7.2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.8 11.6h10.4" })
				]
			});
		}
		/**
		* A play mark in a frame: the model can take video in.
		* @param props - the glyph size.
		* @returns the svg element.
		*/
		function FactsVideoIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, {
				size,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "1.8",
					y: "3.2",
					width: "12.4",
					height: "9.6",
					rx: "2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M6.6 6.4l3.6 1.6-3.6 1.6V6.4Z",
					fill: "currentColor",
					stroke: "none"
				})]
			});
		}
		//#endregion
		//#region src/client/focus-trap.ts
		/**
		* Keyboard focus containment for the dialog.
		*
		* DSH's `Modal` marks itself `role="dialog" aria-modal="true"` but does not
		* keep Tab inside, so focus walks out to the page behind the backdrop. The
		* decision is a pure function (testable without a DOM); the browser wiring
		* below only feeds it real elements.
		* @module dsh-orquestrator/client/focus-trap
		*/
		/**
		* Decide where Tab / Shift+Tab must send focus, or `undefined` to let the
		* browser move it normally.
		* @param focusables - the focusable elements inside the dialog, in tab order.
		* @param active - the currently focused element, or null.
		* @param shift - whether Shift is held.
		* @returns the element to focus explicitly, when the natural move would leave the dialog.
		*/
		function trapTarget(focusables, active, shift) {
			const first = focusables[0];
			const last = focusables.at(-1);
			if (first === void 0 || last === void 0) return void 0;
			if (!(active !== null && focusables.includes(active))) return shift ? last : first;
			if (shift && active === first) return last;
			if (!shift && active === last) return first;
		}
		const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex=\"-1\"])";
		/**
		* Trap Tab inside the plugin's dialog while mounted.
		* @param isPaused - true while a menu portal (outside the dialog) owns the keyboard.
		* @returns the disposer that removes the listener.
		*/
		function installFocusTrap(isPaused) {
			const onKeyDown = (event) => {
				if (event.key !== "Tab" || event.defaultPrevented || isPaused()) return;
				const active = document.activeElement;
				if (active instanceof Element && active.closest("[role=\"menu\"], [role=\"listbox\"]") !== null) return;
				const root = document.querySelector(".dsh-orq-dialog");
				if (root === null) return;
				const target = trapTarget([...root.querySelectorAll(FOCUSABLE)].filter((element) => element.getClientRects().length > 0), active, event.shiftKey);
				if (target instanceof HTMLElement) {
					event.preventDefault();
					target.focus();
				}
			};
			document.addEventListener("keydown", onKeyDown, true);
			return () => {
				document.removeEventListener("keydown", onKeyDown, true);
			};
		}
		//#endregion
		//#region src/client/ModelPicker.tsx
		/**
		* ModelPicker: a provider-grouped model select built on the DSH `Menu`
		* primitive, so it looks and behaves like the composer's own model menu
		* (same rows, checkmark, keyboard walk, portal above the modal layer).
		* It only ever offers routes the model catalog advertises.
		* @module dsh-orquestrator/client/ModelPicker
		*/
		/** Id of the "inherit" row (the value null). */
		const INHERIT_ID = "__inherit__";
		/**
		* The select.
		* @param props - see {@link ModelPickerProps}.
		* @returns the labeled trigger and, while open, the grouped menu.
		*/
		function ModelPicker(props) {
			const { id, label, groups, value, onChange, inheritLabel, placeholder, status } = props;
			const [open, setOpenState] = (0, react.useState)(false);
			const setOpen = (0, react.useCallback)((next) => {
				setOpenState(next);
				props.onMenuOpenChange?.(next);
			}, [props]);
			const { items, routes } = (0, react.useMemo)(() => {
				const entries = [];
				const lookup = /* @__PURE__ */ new Map();
				if (inheritLabel !== void 0) {
					entries.push({
						id: INHERIT_ID,
						label: inheritLabel
					});
					if (groups.length > 0) entries.push({
						type: "separator",
						id: "sep:inherit"
					});
				}
				let index = 0;
				groups.forEach((group, groupIndex) => {
					if (groupIndex > 0) entries.push({
						type: "separator",
						id: `sep:${group.id}`
					});
					entries.push({
						type: "label",
						id: `label:${group.id}`,
						text: group.name
					});
					for (const model of group.models) {
						const rowId = `m${String(index)}`;
						index += 1;
						lookup.set(rowId, {
							provider: group.id,
							model: model.id
						});
						entries.push({
							id: rowId,
							label: model.name
						});
					}
				});
				return {
					items: entries,
					routes: lookup
				};
			}, [groups, inheritLabel]);
			const selectedId = (0, react.useMemo)(() => {
				if (value === null) return inheritLabel === void 0 ? void 0 : INHERIT_ID;
				for (const [rowId, route] of routes) if (routeKey(route) === routeKey(value)) return rowId;
			}, [
				routes,
				value,
				inheritLabel
			]);
			const picked = (0, react.useMemo)(() => {
				if (value === null) return void 0;
				const group = groups.find((candidate) => candidate.id === value.provider);
				return {
					name: group?.models.find((model) => model.id === value.model)?.name ?? value.model,
					provider: group?.name ?? value.provider
				};
			}, [groups, value]);
			if (status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-orq-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-field-label",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-orq-status",
					role: "status",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-orq-spin",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 16 })
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.loadingLabel })]
				})]
			});
			if (status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-orq-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-field-label",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-orq-status dsh-orq-status-error",
					role: "alert",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.errorLabel }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-orq-link",
						onClick: props.onRetry,
						children: props.retryLabel
					})]
				})]
			});
			const labelId = `${id}-label`;
			const valueId = `${id}-value`;
			const trigger = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				id,
				type: "button",
				className: "dsh-orq-picker",
				"aria-haspopup": "menu",
				"aria-expanded": open,
				"aria-labelledby": `${labelId} ${valueId}`,
				disabled: props.disabled === true,
				onClick: () => {
					setOpen(!open);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-picker-value",
					id: valueId,
					children: picked !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-orq-picker-name",
						children: picked.name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-orq-picker-provider",
						children: picked.provider
					})] }) : value === null && inheritLabel !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-orq-picker-name",
						children: inheritLabel
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-orq-picker-name dsh-orq-picker-placeholder",
						children: placeholder
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-picker-chevron",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 })
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-orq-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					className: "dsh-orq-field-label",
					id: labelId,
					htmlFor: id,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open,
					anchor: trigger,
					items,
					selectedId,
					onSelect: (rowId) => {
						setOpen(false);
						onChange(rowId === INHERIT_ID ? null : routes.get(rowId) ?? null);
					},
					onClose: () => {
						setOpen(false);
					},
					portal: true,
					compact: true,
					className: "dsh-orq-menu-root"
				})]
			});
		}
		//#endregion
		//#region src/bench.generated.ts
		/**
		* Terminal-Bench 4 scores by normalized model name: the accuracy per reasoning effort, and the best accuracy across
		* rows. Read `efforts[effort]` first, then `max` — an effort the board never measured has no entry of its own.
		*/
		const TB4_SCORES = {
			"fable5": {
				label: "Fable 5",
				efforts: { "max": 44.55 },
				max: 44.55
			},
			"fable51": {
				label: "Fable 5.1",
				efforts: {
					"max": 57.88,
					"xhigh": 57.88,
					"high": 54.55,
					"medium": 53.94,
					"low": 43.33
				},
				max: 57.88
			},
			"gemini37flash": {
				label: "Gemini 3.7 Flash",
				efforts: { "high": 11.21 },
				max: 11.21
			},
			"gemini38flash": {
				label: "Gemini 3.8 Flash",
				efforts: { "high": 19.09 },
				max: 19.09
			},
			"glm53": {
				label: "GLM-5.3",
				efforts: { "max": 41.82 },
				max: 41.82
			},
			"glm53flash": {
				label: "GLM-5.3-Flash",
				efforts: { "none": 35.76 },
				max: 35.76
			},
			"gpt56luna": {
				label: "GPT-5.6 Luna",
				efforts: { "max": 17.27 },
				max: 17.27
			},
			"gpt56sol": {
				label: "GPT-5.6 Sol",
				efforts: { "max": 37.27 },
				max: 37.27
			},
			"gpt56terra": {
				label: "GPT-5.6 Terra",
				efforts: { "max": 21.52 },
				max: 21.52
			},
			"gpt61sol": {
				label: "GPT-6.1 Sol",
				efforts: { "max": 58.18 },
				max: 58.18
			},
			"gpt6astra": {
				label: "GPT-6 Astra",
				efforts: {
					"max": 58.18,
					"xhigh": 57.88,
					"high": 57.88,
					"medium": 54.24,
					"low": 50.61
				},
				max: 58.18
			},
			"gpt6luna": {
				label: "GPT-6 Luna",
				efforts: { "max": 16.36 },
				max: 16.36
			},
			"gpt6sol": {
				label: "GPT-6 Sol",
				efforts: { "max": 49.39 },
				max: 49.39
			},
			"grok45": {
				label: "Grok 4.5",
				efforts: { "high": 12.42 },
				max: 12.42
			},
			"grok46": {
				label: "Grok 4.6",
				efforts: { "high": 20.3 },
				max: 20.3
			},
			"grok47": {
				label: "Grok 4.7",
				efforts: { "xhigh": 37.58 },
				max: 37.58
			},
			"musespark13": {
				label: "Muse Spark 1.3",
				efforts: { "xhigh": 14.55 },
				max: 14.55
			},
			"opus48": {
				label: "Opus 4.8",
				efforts: { "max": 23.64 },
				max: 23.64
			},
			"opus5": {
				label: "Opus 5",
				efforts: {
					"max": 51.82,
					"xhigh": 53.94,
					"high": 50.3,
					"medium": 44.85,
					"low": 34.85
				},
				max: 53.94
			},
			"opus55": {
				label: "Opus 5.5",
				efforts: { "max": 64.85 },
				max: 64.85
			},
			"qwen38max0902": {
				label: "Qwen3.8-Max-0902",
				efforts: { "max": 26.97 },
				max: 26.97
			},
			"sonnet5": {
				label: "Sonnet 5",
				efforts: { "max": 12.42 },
				max: 12.42
			},
			"sonnet55": {
				label: "Sonnet 5.5",
				efforts: { "max": 61.82 },
				max: 61.82
			}
		};
		/**
		* Reduce a model name to this snapshot's key: lowercase, every non-alphanumeric character removed. The runtime applies
		* it to a model slug and to the picker's display name, so `GLM-5.3`, `glm 5.3` and the slug `glm-5.3` all land on
		* `glm53`.
		* @param name - a model id, slug or display name.
		* @returns the normalized key (empty when the name holds no alphanumeric character).
		*/
		function normalizeModelName(name) {
			return name.toLowerCase().replace(/[^a-z0-9]/g, "");
		}
		//#endregion
		//#region src/client/model-facts.ts
		/**
		* Browser-side model facts for the model picker's capability strip: the input
		* modalities a model understands, and one headline score — Terminal-Bench 4
		* when the committed leaderboard snapshot knows the model, else OpenRouter's
		* intelligence index.
		*
		* Both sources are read here and nothing else: OpenRouter's `/models` endpoint
		* is public, CORS-open (`access-control-allow-origin: *`) and CDN-cached, so a
		* plain browser `fetch` works, and Terminal-Bench 4 ships as a build-time
		* snapshot (`src/bench.generated.ts`) because the official leaderboard sends no
		* CORS header and can never be fetched from a page. This module therefore adds
		* no runtime dependency to the browser bundle.
		*
		* The score follows the reasoning effort the user picked, as far as the data
		* allows:
		*   - Terminal-Bench 4 publishes one row per (model, effort): the strip shows
		*     the accuracy of the selected level, and falls back to the model's best
		*     accuracy when the board never measured that level (the neutral "model
		*     default" option always lands on that best value);
		*   - OpenRouter's intelligence index is a single scalar per model — there is
		*     no per-effort intelligence anywhere in the public API, and the plugin
		*     holds no key for the endpoints that would need one — so that score is
		*     literally the model's intelligence at its maximum effort and reads the
		*     same at every level.
		*
		* Matching is deliberately narrow — an id, never a guess:
		*   1. case-insensitive match on the full catalog id (`z-ai/glm-5.3`);
		*   2. for an id with no `/`, case-insensitive match on the slug part
		*      (`DeepSeek-V4.1-Flash` → slug `deepseek-v4.1-flash`), which is unique
		*      across authors in the catalog;
		*   3. alias entries (`~z-ai/glm-latest`) resolve through `alias_target.slug`;
		*   4. display names never match a catalog entry, and `:variant` suffixes are
		*      never stripped — `:free`/`:batch` are different catalog entries.
		* The only place a display name is consulted is the Terminal-Bench 4 lookup,
		* whose rows are keyed by the model's published name.
		* @module dsh-orquestrator/client/model-facts
		*/
		/** The public OpenRouter catalog: every model, its modalities and its indices. */
		const MODELS_URL = "https://openrouter.ai/api/v1/models";
		/** Deadline for that one catalog call; a slower answer resolves to "nothing known" rather than stalling the strip. */
		const FETCH_TIMEOUT_MS = 8e3;
		/**
		* Terminal-Bench 4 rows by normalized model name. Built from own entries only,
		* so a picker called `Constructor` can never read `Object.prototype.constructor`.
		*/
		const terminalBench = new Map(Object.entries(TB4_SCORES).filter(([key, row]) => key !== "" && Number.isFinite(row.max)));
		/** One catalog fetch per page: the promise *is* the cache, and a failed fetch caches "unavailable". */
		let catalogPromise = null;
		/** The in-flight request, so the test hook can drop it. */
		let inFlight = null;
		/**
		* Facts already computed this session, keyed by model id, display name and effort. Negative results are cached too — a
		* model the catalog does not list stays unknown — and a failed catalog call is remembered by {@link catalogPromise}, so
		* no keystroke of the picker's filter, and no move of the effort ladder, ever starts another request.
		*/
		const factsCache = /* @__PURE__ */ new Map();
		/**
		* Facts for a picker model id (e.g. `z-ai/glm-5.3`, `DeepSeek-V4.1-Flash`), its display name and the reasoning effort
		* the user picked. Resolves null when nothing is known (no network, no match). Cached per (model, display name, effort)
		* trio; never rejects.
		* @param model - the model id the picker holds.
		* @param displayName - the model's display name, consulted only for Terminal-Bench 4 matching.
		* @param effort - the DSH ladder effort id (`low`, `medium`, `high`, `max`, `xhigh`, …), or null/undefined/`''` for the
		* neutral "model default" option; a level the leaderboard never measured falls back to the model's best accuracy.
		* @returns the facts, or null when nothing is known.
		*/
		async function modelFactsOf(model, displayName, effort) {
			const id = typeof model === "string" ? model : "";
			const name = typeof displayName === "string" ? displayName : void 0;
			const level = effortKeyOf(effort);
			const key = `${id}\u0000${normalizeModelName(name ?? "")}\u0000${level}`;
			if (factsCache.has(key)) return factsCache.get(key) ?? null;
			const catalog = await loadCatalog();
			if (catalog === null) return null;
			const facts = factsOf(catalog, id, name, level);
			factsCache.set(key, facts);
			return facts;
		}
		/** The effort key a caller asked for: trimmed and lowercased, `''` for the neutral option or anything that is not a string. */
		function effortKeyOf(effort) {
			return typeof effort === "string" ? effort.trim().toLowerCase() : "";
		}
		/** Facts for a model the catalog answered for; null when the catalog does not list it. */
		function factsOf(catalog, model, displayName, effort) {
			const entry = matchCatalog(catalog, model);
			if (entry === null) return null;
			return {
				modalities: entry.modalities,
				score: scoreOf(entry, displayName, effort)
			};
		}
		/**
		* Match a picker id to a catalog entry, following at most one alias hop.
		* @param catalog - the indexed catalog.
		* @param model - the picker's model id.
		* @returns the entry, or null when the catalog does not list the id.
		*/
		function matchCatalog(catalog, model) {
			const wanted = model.trim().toLowerCase();
			if (wanted === "") return null;
			const entry = wanted.includes("/") ? catalog.byId.get(wanted) : catalog.bySlug.get(wanted);
			if (entry === void 0) return null;
			if (entry.aliasTarget === null) return entry;
			return catalog.byId.get(entry.aliasTarget) ?? catalog.bySlug.get(entry.aliasTarget) ?? entry;
		}
		/**
		* Terminal-Bench 4 first (by normalized slug, then by display name), else the intelligence index, else nothing. The
		* Terminal-Bench value follows the selected effort — the accuracy the board published for that level, or the model's
		* best accuracy when the board never measured it, which is where the neutral option and an unknown level land.
		* @param entry - the matched catalog entry.
		* @param displayName - the picker's display name for the model, when it has one.
		* @param effort - the normalized effort key (`''` for the neutral option).
		* @returns the score, or null when neither source rates the model.
		*/
		function scoreOf(entry, displayName, effort) {
			for (const candidate of [entry.slug, displayName ?? ""]) {
				const key = normalizeModelName(candidate);
				const row = key === "" ? void 0 : terminalBench.get(key);
				if (row !== void 0) return {
					kind: "terminal-bench-4",
					value: `${(effortAccuracy(row, effort) ?? row.max).toFixed(1)}%`
				};
			}
			return entry.intelligence === null ? null : {
				kind: "intelligence",
				value: entry.intelligence.toFixed(1)
			};
		}
		/**
		* The accuracy the snapshot holds for one effort, when it holds a real number there.
		* @param row - the model's Terminal-Bench 4 entry.
		* @param effort - the normalized effort key (`''` for the neutral option, which is never looked up).
		* @returns the accuracy in percent, or null when the board never measured that level.
		*/
		function effortAccuracy(row, effort) {
			if (effort === "" || !Object.hasOwn(row.efforts, effort)) return null;
			const value = row.efforts[effort];
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		}
		/** The shared catalog promise: created once, resolved to null on any failure. */
		function loadCatalog() {
			catalogPromise ??= fetchCatalog();
			return catalogPromise;
		}
		/** One bounded, never-throwing fetch of `/models`. */
		async function fetchCatalog() {
			const fetcher = globalThis.fetch;
			if (typeof fetcher !== "function") return null;
			const controller = new AbortController();
			inFlight = controller;
			const timer = setTimeout(() => {
				controller.abort();
			}, FETCH_TIMEOUT_MS);
			try {
				const response = await fetcher(MODELS_URL, {
					headers: { accept: "application/json" },
					signal: controller.signal
				});
				if (!response.ok) return null;
				return indexCatalog(await response.json());
			} catch {
				return null;
			} finally {
				clearTimeout(timer);
				if (inFlight === controller) inFlight = null;
			}
		}
		/** Index a `/models` payload; null when it is not the shape the catalog promises. */
		function indexCatalog(payload) {
			const rows = catalogRows(payload);
			if (rows === null) return null;
			const entries = [];
			const slugCounts = /* @__PURE__ */ new Map();
			for (const row of rows) {
				if (!isRecord(row)) continue;
				const id = row["id"];
				if (typeof id !== "string" || id.trim() === "") continue;
				const key = id.trim().toLowerCase();
				const slash = key.lastIndexOf("/");
				const slug = slash === -1 ? key : key.slice(slash + 1);
				entries.push({
					id: key,
					slug,
					modalities: readModalities(row["architecture"]),
					intelligence: readIntelligence(row["benchmarks"]),
					aliasTarget: readAliasTarget(row["alias_target"])
				});
				slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
			}
			if (entries.length === 0) return null;
			const byId = /* @__PURE__ */ new Map();
			const bySlug = /* @__PURE__ */ new Map();
			for (const entry of entries) {
				if (!byId.has(entry.id)) byId.set(entry.id, entry);
				if (slugCounts.get(entry.slug) === 1) bySlug.set(entry.slug, entry);
			}
			return {
				byId,
				bySlug
			};
		}
		/** The entry array of a `/models` payload (`{ data: [...] }`, or the array itself). */
		function catalogRows(payload) {
			if (Array.isArray(payload)) return payload;
			if (isRecord(payload) && Array.isArray(payload["data"])) return payload["data"];
			return null;
		}
		/** `architecture.input_modalities` → the four booleans the strip shows (`file` is not one of them). */
		function readModalities(architecture) {
			const declared = isRecord(architecture) && Array.isArray(architecture["input_modalities"]) ? architecture["input_modalities"] : [];
			const seen = /* @__PURE__ */ new Set();
			for (const value of declared) if (typeof value === "string") seen.add(value.toLowerCase());
			return {
				text: seen.has("text"),
				image: seen.has("image"),
				audio: seen.has("audio"),
				video: seen.has("video")
			};
		}
		/** `benchmarks.artificial_analysis.intelligence_index` when it is a real number. */
		function readIntelligence(benchmarks) {
			if (!isRecord(benchmarks)) return null;
			const analysis = benchmarks["artificial_analysis"];
			if (!isRecord(analysis)) return null;
			const value = analysis["intelligence_index"];
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		}
		/** `alias_target.slug` of an alias entry, lowercased and trimmed. */
		function readAliasTarget(alias) {
			if (!isRecord(alias)) return null;
			const slug = alias["slug"];
			return typeof slug === "string" && slug.trim() !== "" ? slug.trim().toLowerCase() : null;
		}
		/** A plain object (not null, not an array) usable as a dictionary. */
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		//#endregion
		//#region src/client/OrchestratorDialog.tsx
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
		* The strip follows the effort as well: the facts are asked for the pair (model,
		* chosen level), so picking a level re-resolves the badge, and the neutral row
		* asks for the model itself (the data layer answers with its ceiling). A late
		* answer for a pair the user has already left never lands on the strip.
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
		* "Cancel" (button, the ✕, Escape, a mask click) sends nothing: the task is
		* aborted, so no prompt goes out, no message appears, the composer keeps what
		* the user typed, and neither the configuration nor the skill answer is stored
		* (that is the gate's `abort` decision, not a prompt). Configure mode has
		* nothing to send: there a cancel simply stores nothing, as it always did.
		* @module dsh-orquestrator/client/OrchestratorDialog
		*/
		/** Window after a menu closed during which Escape/mask must not also close the dialog. */
		const MENU_CLOSE_GUARD_MS = 300;
		/** One input modality of the capability strip, in the order the strip shows them. */
		const MODALITIES = [
			{
				id: "audio",
				icon: FactsAudioIcon
			},
			{
				id: "image",
				icon: FactsPhotoIcon
			},
			{
				id: "text",
				icon: FactsTextIcon
			},
			{
				id: "video",
				icon: FactsVideoIcon
			}
		];
		/** Accessible label of each modality, marked and dimmed. */
		const MODALITY_LABELS = {
			audio: {
				on: "facts.audio",
				off: "facts.audio.off"
			},
			image: {
				on: "facts.photo",
				off: "facts.photo.off"
			},
			text: {
				on: "facts.text",
				off: "facts.text.off"
			},
			video: {
				on: "facts.video",
				off: "facts.video.off"
			}
		};
		/** Label of each score kind. */
		const SCORE_LABELS = {
			"terminal-bench-4": "facts.tb4",
			intelligence: "facts.intelligence"
		};
		/**
		* The capability strip of one model: four modality glyphs, marked when the model
		* understands that input and dimmed when it does not, plus the benchmark score
		* when the facts carry one.
		* @param props - the facts and the translate function.
		* @returns the strip.
		*/
		function CapabilityStrip({ facts, t }) {
			const score = facts.score;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-orq-facts",
				children: [MODALITIES.map(({ id, icon: Icon }) => {
					const on = facts.modalities[id];
					const label = t(on ? MODALITY_LABELS[id].on : MODALITY_LABELS[id].off);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-orq-fact",
						"data-orq-on": on ? "true" : "false",
						role: "img",
						"aria-label": label,
						title: label,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, { size: 15 })
					}, id);
				}), score === null ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-orq-facts-score",
					children: t(SCORE_LABELS[score.kind], { value: score.value })
				})]
			});
		}
		/**
		* The identity of one facts question: the effective model and the level the strip follows. Two answers for
		* different pairs answer different questions, so a late one can never stand in for the current one.
		* @param model - the effective model id, or undefined while there is no model at all.
		* @param effort - the chosen level, or null for the neutral row.
		* @returns a key equal for the same question and different for any other.
		*/
		function factsKey(model, effort) {
			return JSON.stringify([model ?? null, effort]);
		}
		/**
		* The dialog.
		* @param props - the request, the catalog state and the translate function.
		* @returns the modal.
		*/
		function OrchestratorDialog({ request, catalog, reloadCatalog, t }) {
			const { initial, mode } = request;
			const uid = (0, react.useId)();
			const skill = mode === "gate" ? request.skill : null;
			const skillOffered = skill !== null;
			const skillLocked = skillOffered && request.skillInMessage;
			const [skillOn, setSkillOn] = (0, react.useState)(request.initialSkill);
			const [subagentsOn, setSubagentsOn] = (0, react.useState)(initial.subagentModel !== null);
			const [subagentRoute, setSubagentRoute] = (0, react.useState)(initial.subagentModel);
			const [workerEffort, setWorkerEffort] = (0, react.useState)(initial.workerEffort);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [facts, setFacts] = (0, react.useState)(null);
			const menuOpen = (0, react.useRef)(false);
			const menuClosedAt = (0, react.useRef)(0);
			const onMenuOpenChange = (0, react.useCallback)((open) => {
				menuOpen.current = open;
				if (!open) menuClosedAt.current = Date.now();
			}, []);
			(0, react.useEffect)(() => installFocusTrap(() => menuOpen.current), []);
			const mainRoute = catalog.current;
			const mainName = mainRoute === null ? void 0 : modelName(catalog.groups, mainRoute);
			const needsModel = subagentsOn && subagentRoute === null;
			const effectiveRoute = subagentsOn ? subagentRoute : mainRoute;
			const effectiveLadder = effectiveRoute === null ? void 0 : ladderOf(catalog.groups, effectiveRoute);
			const hasLadder = effectiveLadder !== void 0 && effectiveLadder.efforts.length > 0;
			const workerChosen = effectiveLadder === void 0 ? workerEffort : effectiveLadder.efforts.some((effort) => effort.id === workerEffort) ? workerEffort : null;
			const onModelChange = (0, react.useCallback)((route) => {
				setSubagentRoute(route);
				setWorkerEffort(highestEffortOf(route === null ? void 0 : ladderOf(catalog.groups, route)));
			}, [catalog.groups]);
			const factsModel = effectiveRoute?.model;
			const factsName = effectiveRoute === null ? void 0 : modelName(catalog.groups, effectiveRoute);
			const factsEffort = workerChosen;
			const factsPair = (0, react.useRef)("");
			(0, react.useEffect)(() => {
				const pair = factsKey(factsModel, factsEffort);
				factsPair.current = pair;
				setFacts(null);
				if (factsModel === void 0) return;
				let live = true;
				modelFactsOf(factsModel, factsName, factsEffort).then((next) => {
					if (!live || factsPair.current !== pair) return;
					setFacts(next);
				});
				return () => {
					live = false;
				};
			}, [
				factsModel,
				factsName,
				factsEffort
			]);
			const noteTexts = (route) => route === null ? [] : notesFor(route).slice(0, 2).map((note) => t(`note.${note}`));
			const cancel = (0, react.useCallback)(() => {
				if (busy) return;
				request.resolve({ kind: "cancel" });
			}, [busy, request]);
			const onClose = (0, react.useCallback)(() => {
				if (menuOpen.current || Date.now() - menuClosedAt.current < MENU_CLOSE_GUARD_MS) return;
				cancel();
			}, [cancel]);
			const confirm = (0, react.useCallback)(async () => {
				if (busy || needsModel) return;
				const config = buildConfig({
					subagentModel: subagentsOn ? subagentRoute : null,
					workerEffort: workerChosen
				});
				setBusy(true);
				setError(null);
				try {
					await request.save(config);
				} catch (cause) {
					setBusy(false);
					setError(t("error.save", { message: cause instanceof Error ? cause.message : String(cause) }));
					return;
				}
				request.resolve({
					kind: "confirm",
					config,
					applySkill: skillOffered && (skillLocked || skillOn)
				});
			}, [
				busy,
				needsModel,
				subagentsOn,
				subagentRoute,
				workerChosen,
				skillOffered,
				skillLocked,
				skillOn,
				request,
				t
			]);
			const sameText = (0, react.useMemo)(() => mainName === void 0 ? t("subagents.same.unknown") : t("subagents.same", { model: mainName }), [mainName, t]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose,
				title: t("dialog.title"),
				description: t(mode === "gate" ? "dialog.description.gate" : "dialog.description.configure"),
				closeLabel: t("dialog.close"),
				className: "dsh-orq-dialog",
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					disabled: busy,
					title: mode === "gate" ? t("button.cancelHint") : void 0,
					onClick: cancel,
					children: t("button.cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					autoFocus: true,
					disabled: busy || needsModel,
					title: needsModel ? t("button.needModel") : void 0,
					onClick: () => {
						confirm();
					},
					children: busy ? t("button.saving") : t(mode === "gate" ? "button.confirm.gate" : "button.confirm.configure")
				})] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-orq-stack",
					children: [
						mode === "gate" && request.preview !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-orq-task",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-orq-task-label",
								children: t("task.label")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-orq-task-text",
								children: request.preview
							})]
						}) : void 0,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dsh-orq-section",
							"aria-labelledby": `${uid}-subagents`,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-orq-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-orq-heading",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
											className: "dsh-orq-title",
											id: `${uid}-subagents`,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: 16 }), t("subagents.title")]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsh-orq-hint",
											children: subagentsOn ? mainName === void 0 ? "" : t("subagents.main", { model: mainName }) : sameText
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
										checked: subagentsOn,
										onChange: setSubagentsOn,
										label: t("subagents.switch"),
										disabled: busy
									})]
								}),
								subagentsOn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
									id: `${uid}-subagent-model`,
									label: t("subagents.modelLabel"),
									groups: catalog.groups,
									value: subagentRoute,
									onChange: onModelChange,
									placeholder: t("picker.placeholder"),
									status: catalog.status,
									loadingLabel: t("picker.loading"),
									errorLabel: t("picker.error"),
									retryLabel: t("picker.retry"),
									onRetry: reloadCatalog,
									disabled: busy,
									onMenuOpenChange
								}) : void 0,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(EffortPicker, {
									id: `${uid}-effort`,
									label: t("effort.label"),
									efforts: effectiveLadder?.efforts ?? [],
									value: workerChosen,
									neutralLabel: t("effort.defaultOption"),
									disabled: busy || !hasLadder,
									onChange: setWorkerEffort
								}),
								facts === null ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CapabilityStrip, {
									facts,
									t
								}),
								subagentsOn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-orq-hint",
									children: t("subagents.scope")
								}) : void 0,
								subagentsOn ? noteTexts(subagentRoute).map((text) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-orq-hint dsh-orq-note",
									children: text
								}, text)) : void 0,
								needsModel && catalog.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-orq-hint",
									role: "status",
									children: t("subagents.needModel")
								}) : void 0
							]
						}),
						skill !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dsh-orq-section dsh-orq-skill",
							"aria-labelledby": `${uid}-skill`,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									className: "dsh-orq-title",
									id: `${uid}-skill`,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSkillOutline16, { size: 16 }), t("skill.title")]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
									checked: skillLocked || skillOn,
									onChange: setSkillOn,
									label: t("skill.checkbox"),
									disabled: busy || skillLocked
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-orq-hint dsh-orq-skill-hint",
									children: t(skillLocked ? "skill.typed" : "skill.hint", { token: `/${skill.name}` })
								})
							]
						}) : void 0,
						error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-orq-error",
							role: "alert",
							children: error
						}) : void 0
					]
				})
			});
		}
		//#endregion
		//#region src/client/OrchestratorOverlay.tsx
		/**
		* The composer overlay: a slot occupant with no visual of its own. Mounted
		* next to every resident composer it (1) registers itself as a presenter for
		* its session so the gate knows a dialog can be shown, (2) attaches the prompt
		* gate to the session face for as long as the composer lives, and (3) renders
		* the dialog when the page's single pending request belongs to its session.
		* @module dsh-orquestrator/client/OrchestratorOverlay
		*/
		/**
		* The overlay component.
		* @param props - the composer's session id and the plugin host face.
		* @returns the dialog while a request for this session is on screen, else null.
		*/
		function OrchestratorOverlay({ sessionId, host }) {
			const [token] = (0, react.useState)(() => Symbol("dsh-orquestrator"));
			const request = (0, react.useSyncExternalStore)((listener) => host.dialogs.current.subscribe(listener), () => host.dialogs.current.getSnapshot());
			(0, react.useSyncExternalStore)((listener) => host.dialogs.presence.subscribe(listener), () => host.dialogs.presence.getSnapshot());
			(0, react.useSyncExternalStore)((listener) => host.locale.subscribe(listener), () => host.locale.getSnapshot());
			const t = host.locale.bind(NS);
			(0, react.useEffect)(() => host.dialogs.registerPresenter(sessionId, token), [
				host,
				sessionId,
				token
			]);
			(0, react.useEffect)(() => host.attachGate(sessionId), [host, sessionId]);
			const [catalog, setCatalog] = (0, react.useState)(LOADING_CATALOG);
			const presenting = request !== null && request.sessionId === sessionId && host.dialogs.isPresenter(sessionId, token);
			const requestId = presenting ? request.id : void 0;
			const load = (0, react.useCallback)(() => {
				setCatalog(LOADING_CATALOG);
				let alive = true;
				host.loadCatalog(sessionId).then((state) => {
					if (alive) setCatalog(state);
				});
				return () => {
					alive = false;
				};
			}, [host, sessionId]);
			(0, react.useEffect)(() => requestId === void 0 ? void 0 : load(), [requestId, load]);
			if (!presenting) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OrchestratorDialog, {
				request,
				catalog,
				reloadCatalog: () => {
					load();
				},
				t
			}, request.id);
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* The dialog's stylesheet. It rides the DSH design tokens only
		* (`--dsw-alias-*`), so light/dark themes and the host's shape language apply
		* unchanged; the plugin ships no colors, fonts or radii of its own beyond
		* mirroring the host's own component geometry (r12 fields, r16 sections).
		* Injected once as a `<style>` element and removed on plugin dispose.
		*
		* One control needs more than the tokens: the native `<select>` of the effort
		* picker. Its control chrome AND its option rows carry explicit
		* `background-color`/`color`/`border` from the same tokens, because a native
		* select paints its closed box and its popup list from the platform scheme
		* unless the page says otherwise (`color-scheme`), and DSH sets no
		* `color-scheme` anywhere: in the dark theme the near-white label token landed
		* on the platform's white popup and every row but the hovered one was
		* invisible. The rows now follow the app's theme (`body[data-ds-dark-theme]`,
		* the host's own dark marker), whatever the operating system says.
		* @module dsh-orquestrator/client/styles
		*/
		/** Id of the injected `<style>` element (idempotency key across HMR reloads). */
		const STYLE_ID = "dsh-orquestrator-styles";
		/** The stylesheet text. */
		const CSS = `
.dsh-orq-dialog[role='dialog'] { width: min(480px, 100%); max-height: calc(100vh - 48px); }
.dsh-orq-stack { display: flex; flex-direction: column; gap: 12px; max-height: calc(100vh - 250px); overflow-y: auto; padding: 2px; margin: -2px; }
.dsh-orq-task { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-orq-task-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-task-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-orq-section { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-orq-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dsh-orq-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-orq-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-orq-title svg { flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-orq-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-section-quiet { gap: 8px; padding: 10px 14px; }
.dsh-orq-stack-tight { display: flex; flex-direction: column; gap: 10px; }
.dsh-orq-note { padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l2); }
.dsh-orq-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-orq-field-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dsh-orq-menu-root.dsh-orq-menu-root { display: flex; width: 100%; }
.dsh-orq-picker { display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; width: 100%; height: 36px; padding: 0 10px 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer; }
.dsh-orq-picker:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-orq-picker:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-orq-picker:disabled { cursor: not-allowed; opacity: 0.5; }
.dsh-orq-picker-value { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }
.dsh-orq-picker-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-orq-picker-provider { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-picker-placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-orq-picker-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dsh-orq-status { display: flex; align-items: center; gap: 8px; min-height: 36px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-orq-select { box-sizing: border-box; width: 100%; height: 36px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; color-scheme: light; }
.dsh-orq-select option { background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-orq-select:hover:not(:disabled) { background-color: var(--dsw-alias-interactive-bg-hover); }
.dsh-orq-select:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-orq-select:disabled { border-color: var(--dsw-alias-border-l2); background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: not-allowed; }
body[data-ds-dark-theme] .dsh-orq-select { color-scheme: dark; }
.dsh-orq-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-orq-fact { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 24px; height: 24px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-dimmed); }
.dsh-orq-fact svg { display: block; flex: none; }
.dsh-orq-fact[data-orq-on='true'] { color: var(--dsw-alias-label-primary); }
.dsh-orq-facts-score { display: inline-flex; align-items: center; box-sizing: border-box; height: 24px; margin-left: 2px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap; }
.dsh-orq-status-error { color: var(--dsw-alias-state-error-primary); }
.dsh-orq-link { padding: 0; border: 0; background: none; font: inherit; color: var(--dsw-alias-brand-text); text-decoration: underline; cursor: pointer; }
.dsh-orq-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-orq-spin { display: inline-flex; animation: dsh-orq-spin 900ms linear infinite; }
@keyframes dsh-orq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-orq-spin { animation: none; } }
.dsh-orq-chip { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; max-width: min(420px, 100%); height: 24px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }
.dsh-orq-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-orq-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-orq-chip-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.dsh-orq-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-orq-skill { display: flex; flex-direction: column; gap: 6px; }
.dsh-orq-skill-hint { padding-left: 22px; }
.dsh-orq-sub-icon { display: inline-flex; flex: none; align-items: center; justify-content: center; box-sizing: border-box; width: 14px; height: 18px; margin: 0 -2px; color: var(--dsw-alias-label-tertiary); }
.dsh-orq-sub-icon svg { display: block; flex: none; transform-origin: 50% 50%; }
.dsh-orq-sub-icon[data-orq-state='running'] { color: var(--dsw-static-deepseek-450); }
.dsh-orq-sub-icon[data-orq-state='running'] svg { animation: dsh-orq-spin 900ms linear infinite; }
.dsh-orq-sub-icon[data-orq-state='done'] { color: var(--dsw-alias-state-success-primary); }
.dsh-orq-sub-icon[data-orq-state='failed'] { color: var(--dsw-alias-state-error-primary); }
.dsh-orq-sub-icon[data-orq-state='stopped'] { color: var(--dsw-alias-state-warn-primary); }
[role='treeitem'][data-orq-row] .dsh-orq-sub-icon + [data-state] { display: none; }
.dsh-orq-sub-model { display: flex; min-width: 0; margin-top: 2px; }
.dsh-orq-sub-tag { display: block; box-sizing: border-box; min-width: 0; max-width: 100%; height: 16px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) { .dsh-orq-sub-icon[data-orq-state='running'] svg { animation: none; } }
`;
		/**
		* Inject the stylesheet once.
		* @param doc - the document to style.
		* @returns a disposer that removes the element again.
		*/
		function installStyles(doc) {
			const existing = doc.getElementById(STYLE_ID);
			if (existing !== null) existing.remove();
			const element = doc.createElement("style");
			element.id = STYLE_ID;
			element.textContent = CSS;
			doc.head.appendChild(element);
			return () => {
				element.remove();
			};
		}
		/** The deepest nesting resolved; the menu is a tree of sessions, so anything deeper is not a real menu. */
		const MAX_LEVEL = 64;
		/**
		* Read an own property of a table keyed by session id. A plain index would answer for `constructor` or `__proto__`.
		* @param table - the table, or undefined.
		* @param key - the key.
		* @returns the value, or undefined when the table has no own entry for the key.
		*/
		function ownValue(table, key) {
			if (table === void 0 || table === null || typeof table !== "object") return void 0;
			return Object.hasOwn(table, key) ? table[key] : void 0;
		}
		/**
		* The label DSH renders for a child entry: the creation label, or the session id when it has none.
		* @param entry - a child entry.
		* @returns the text the row's label element holds.
		*/
		function entryLabel(entry) {
			return entry.label ?? entry.id;
		}
		/** The catalog of one parent, or undefined when it is missing or malformed. */
		function catalogOf(catalogs, id) {
			const catalog = ownValue(catalogs, id);
			return catalog !== void 0 && catalog !== null && Array.isArray(catalog.entries) ? catalog : void 0;
		}
		/** Normalize an `aria-level`: a missing, NaN, infinite or non-positive level counts as the first level. */
		function levelOf(raw) {
			if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 1;
			return Math.floor(raw);
		}
		/**
		* Whether a row can be the row of an entry. DSH builds a child row's `aria-label` as
		* `[label, [title, mode, activity].join(' · '), metrics]` joined by spaces, with the title only when the session
		* list has one, so with a title the label must be followed by it and a middle dot, and without one by a space (or
		* nothing). A label that merely begins the same way (`Review` and `Review the auth module`) is another row. An empty
		* label fits nothing: DSH drops it from the row, so there is nothing to compare. A diagnostic row is `id reason`.
		*/
		function fits(entry, label, titleOf) {
			if (entry === null || typeof entry !== "object") return false;
			const expected = entry.kind === "child" ? entry.label ?? entry.id : entry.id;
			if (typeof label !== "string" || typeof expected !== "string" || expected === "") return false;
			if (entry.kind === "child") {
				const title = titleOf?.(entry.id);
				if (typeof title === "string") return label.startsWith(`${expected} ${title} \u00b7 `);
			}
			return label === expected || label.startsWith(`${expected} `);
		}
		/** Whether a catalog is the first level of the menu: as many entries as first-level rows, each one fitting its row. */
		function fitsRoot(catalog, firstLevel, titleOf) {
			const entries = catalog.entries;
			return entries.length === firstLevel.length && entries.every((entry, index) => fits(entry, firstLevel[index]?.label ?? "", titleOf));
		}
		/** Candidate tiers from what the caller passed: a flat list is one tier. */
		function tiersOf(candidates) {
			if (!Array.isArray(candidates)) return [];
			if (candidates.length > 0 && candidates.every(Array.isArray)) return candidates;
			return [candidates];
		}
		/**
		* The one session whose catalog is the first level of the menu, or undefined when none fits or the match is
		* ambiguous. The tiers are tried in order: the first tier that has a fitting catalog decides, and when it has
		* several the answer is "not known" rather than a guess, because a wrong guess marks one conversation's children
		* with another's outcomes. Among several fitting catalogs the only tie-breaker is DSH's own `aria-current` marker
		* (a switcher menu puts it on the row of the conversation the page shows): the catalog whose marked row is a
		* session on the page wins, when exactly one does.
		*/
		function rootOf(firstLevel, catalogs, tiers, context) {
			const onPage = new Set(Array.isArray(context.onPage) ? context.onPage : []);
			for (const tier of tiers) {
				if (!Array.isArray(tier)) continue;
				const fitting = [];
				for (const id of new Set(tier)) {
					const catalog = typeof id === "string" ? catalogOf(catalogs, id) : void 0;
					if (catalog !== void 0 && fitsRoot(catalog, firstLevel, context.titleOf)) fitting.push(id);
				}
				if (fitting.length === 0) continue;
				if (fitting.length === 1) return fitting[0];
				const marked = fitting.filter((id) => {
					const entries = catalogOf(catalogs, id)?.entries ?? [];
					return firstLevel.some((row, index) => {
						const entry = entries[index];
						return row.current === true && entry !== void 0 && entry !== null && entry.kind === "child" && onPage.has(entry.id);
					});
				});
				return marked.length === 1 ? marked[0] : void 0;
			}
		}
		/**
		* Work out which catalog entry each row of DSH's subagent menu is. The menu is a tree: its first-level rows are
		* the root catalog's entries in order, and an expanded row owns a group of rows one level deeper that are its own
		* catalog's entries in order. Nothing in a row says which session the catalog belongs to, so the root is found by
		* comparing counts and labels (see {@link RowContext}), and every row is then checked against the entry its
		* position names.
		*
		* A row resolves only when its entry exists, is a `child` entry and its label fits the row. Disabled rows (loading
		* placeholders, diagnostics) and mismatches resolve to undefined, and so does everything nested under an unresolved
		* row. When the root cannot be told, nothing resolves. Never throws, whatever the input.
		* @param rows - the menu's rows in DOM order.
		* @param catalogs - the session list's catalogs, keyed by the parent session id.
		* @param candidates - the sessions that may be the menu's root: either one list, or tiers of lists, most likely tier first. The first tier with a fitting catalog decides; two fitting catalogs in it resolve nothing.
		* @param context - the session titles and the sessions on the page, which only narrow the match.
		* @returns the root (undefined when it cannot be told) and, per row, the entry it stands for.
		*/
		function resolveRows(rows, catalogs, candidates, context = {}) {
			if (!Array.isArray(rows)) return {
				root: void 0,
				rows: []
			};
			const none = () => ({
				root: void 0,
				rows: rows.map(() => void 0)
			});
			const firstLevel = rows.filter((row) => levelOf(row.level) === 1);
			if (firstLevel.length === 0) return none();
			const root = rootOf(firstLevel, catalogs, tiersOf(candidates), context);
			if (root === void 0) return none();
			const frames = [void 0, {
				parentId: root,
				next: 0
			}];
			const resolved = [];
			for (const row of rows) {
				const level = levelOf(row.level);
				if (level > MAX_LEVEL) {
					resolved.push(void 0);
					continue;
				}
				const frame = frames[level];
				frames.length = level + 1;
				let hit;
				if (frame !== void 0) {
					const entry = catalogOf(catalogs, frame.parentId)?.entries[frame.next];
					frame.next += 1;
					if (entry !== void 0 && entry !== null && entry.kind === "child" && !row.disabled && fits(entry, row.label, context.titleOf)) hit = {
						parentId: frame.parentId,
						entry
					};
				}
				frames[level + 1] = hit === void 0 ? void 0 : {
					parentId: hit.entry.id,
					next: 0
				};
				resolved.push(hit);
			}
			return {
				root,
				rows: resolved
			};
		}
		/** The route of the latest model request of a session, when the session list carries a well-formed one. */
		function lastUsedRoute(summary) {
			const used = summary?.projectionValues?.modelSelection?.lastUsed;
			if (used === void 0 || used === null) return null;
			const { provider, model, reasoningEffort } = used;
			if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return null;
			return typeof reasoningEffort === "string" && reasoningEffort !== "" ? {
				provider,
				model,
				reasoningEffort
			} : {
				provider,
				model
			};
		}
		/**
		* Decide what one row shows. The host ledger is fresher than DSH's catalog, so a ledger record decides the state
		* when there is one; the catalog's `activity` decides only when there is none.
		*
		* - a `done`, `failed` or `stopped` record is that state, with its stop reason, even while the catalog still says the
		*   child is running (the catalog lags);
		* - a `running` record is `running` while the catalog says the child is live or the record is younger than
		*   {@link STALE_RUNNING_MS}; an older one the catalog calls not live is `unknown` (a missed end event), so a spinner
		*   can never spin forever;
		* - with no record, a live child is `running` and anything else is `unknown`.
		*
		* The route is the latest one the session list saw the child use (DSH's own `lastUsed`), else the ledger's. The
		* ledger keeps the route requested at the start, which a continuable child may have outgrown, so it only fills in
		* for a child that has not made its first request yet.
		* @param entry - the catalog entry the row stands for.
		* @param record - the host ledger's record of that child, when there is one.
		* @param summary - the session list's summary of that child, when there is one.
		* @param now - the current time in epoch milliseconds, in the clock of the record's times (the host's).
		* @returns the mark to draw.
		*/
		function markFor(entry, record, summary, now) {
			const route = lastUsedRoute(summary) ?? record?.route ?? null;
			if (record === void 0) return {
				state: entry.activity === "running" ? "running" : "unknown",
				stopReason: null,
				route
			};
			if (record.state !== "running") return {
				state: record.state,
				stopReason: record.stopReason,
				route
			};
			return {
				state: entry.activity === "running" || now - record.startedAt < 5e3 ? "running" : "unknown",
				stopReason: null,
				route
			};
		}
		/**
		* The label a row shows for the model it runs on.
		* @param groups - the model catalog groups (empty until the catalog loaded).
		* @param route - the route the child runs on, or null when it is not known.
		* @returns the model's display name and the effort's display name (the raw ids when the catalog lacks them), or undefined without a route.
		*/
		function describeRoute(groups, route) {
			if (route === null) return void 0;
			const model = modelName(groups, route);
			const effort = route.reasoningEffort;
			if (effort === void 0 || effort === "") return {
				model,
				effort: null
			};
			return {
				model,
				effort: ladderOf(groups, route)?.efforts.find((level) => level.id === effort)?.name ?? effort
			};
		}
		//#endregion
		//#region src/client/subagent-menu.ts
		const SVG_NS = "http://www.w3.org/2000/svg";
		/** Class of the status icon host (ours, so selecting by it is safe). */
		const ICON_CLASS = "dsh-orq-sub-icon";
		/** Class of the model label host. */
		const MODEL_CLASS = "dsh-orq-sub-model";
		/** Class of the model label itself. */
		const TAG_CLASS = "dsh-orq-sub-tag";
		/** Prefix of the ids this controller gives its elements (a row's `aria-describedby` points at them). */
		const ID_PREFIX = "dsh-orq-sub-";
		/** Attribute that marks a row as decorated (the stylesheet hides DSH's own dot on such a row). */
		const ROW_ATTR = "data-orq-row";
		/** Attribute that carries the state the icon draws. */
		const STATE_ATTR = "data-orq-state";
		/** Locale namespace of DSH's own subagent menu, and the key of its title. */
		const NATIVE_NS = "subagent";
		const NATIVE_TREE_KEY = "tree.aria";
		/** Poll period of an open menu. */
		const DEFAULT_POLL_MS = 2e3;
		/** How long the model names are reused before the catalog is asked again. */
		const CATALOG_TTL_MS = 6e4;
		/** How long a model catalog request that never answers blocks the next one. */
		const CATALOG_RETRY_MS = 3e4;
		/** Wait before the ledger is re-read after a status flip, so the host has recorded the ending. */
		const REFETCH_DELAY_MS = 250;
		/** How long a first-time menu waits for the ledger before it draws status from the catalog alone. */
		const STATUS_GRACE_MS = 1500;
		/** How long a ledger request may stay unanswered before the controller gives up on it (the carrier's own deadline is shorter). */
		const LEDGER_WATCHDOG_MS = 8e3;
		/** Ledgers kept (one per root session) so a reopened menu paints with what it knew. */
		const MAX_LEDGERS = 16;
		/** The `data-state` values of DSH's StateDot: the only element a row's status dot can be. */
		const DOT_SELECTOR = [
			"ongoing",
			"done",
			"error",
			"idle",
			"warning"
		].map((state) => `[data-state="${state}"]`).join(", ");
		const OWN_SELECTOR = `.${ICON_CLASS}, .${MODEL_CLASS}`;
		/** The stop reasons the dictionary names; any other reason is printed as the host sent it. */
		const REASON_KEYS = {
			"error": "sub.reason.error",
			"max-tokens": "sub.reason.max-tokens",
			"refusal": "sub.reason.refusal"
		};
		/** Where the live controller of a document is kept, so that a newer one can retire it (a plugin reload). */
		const LIVE_KEY = Symbol.for("dsh-orquestrator.subagent-marks");
		/** Unique per page load, so ids stay unique even when two copies of this module meet. */
		const PAGE_TOKEN = Math.random().toString(36).slice(2, 8);
		let idCounter = 0;
		/** A new id for one of our elements. */
		function nextId() {
			idCounter += 1;
			return `${ID_PREFIX}${PAGE_TOKEN}-${String(idCounter)}`;
		}
		/** Whether a node is one of the hosts this controller inserts. */
		function isOwn(node) {
			if (node.nodeType !== 1) return false;
			const { classList } = node;
			return classList.contains(ICON_CLASS) || classList.contains(MODEL_CLASS);
		}
		/** Whether a mutation only reports this controller's own insertions, removals or edits. */
		function isOwnMutation(record) {
			const target = record.target;
			if ((target.nodeType === 1 ? target : target.parentElement)?.closest(OWN_SELECTOR) != null) return true;
			const nodes = [...record.addedNodes, ...record.removedNodes];
			return nodes.length > 0 && nodes.every(isOwn);
		}
		/** What the controller reads from a `[role="treeitem"]` row. */
		function readRow(item) {
			const current = item.getAttribute("aria-current");
			return {
				level: Number(item.getAttribute("aria-level")),
				label: item.getAttribute("aria-label") ?? "",
				disabled: item.getAttribute("aria-disabled") === "true",
				current: current !== null && current !== "false"
			};
		}
		/** The first child of an element that carries a class. */
		function childWithClass(parent, className) {
			for (const child of parent.children) if (child.classList.contains(className)) return child;
		}
		/** Remove the children that carry a class, except the one to keep. */
		function removeOthers(parent, className, keep) {
			for (const child of Array.from(parent.children)) if (child !== keep && child.classList.contains(className)) child.remove();
		}
		/** Write an attribute only when its value differs, so an unchanged row costs no mutation. */
		function setIfChanged(element, name, value) {
			if (element.getAttribute(name) !== value) element.setAttribute(name, value);
		}
		/** Give an element an id of ours, unless it has one. */
		function ensureId(element) {
			if (element.id === "") element.id = nextId();
			return element.id;
		}
		/**
		* Point a row's `aria-describedby` at the ids of our elements, keeping any id DSH (or anything else) put there.
		* React does not own this attribute on the row, so a re-render leaves it alone.
		* @param row - a `[role="treeitem"]` element.
		* @param ids - the ids to point at (none removes ours).
		*/
		function setDescribedBy(row, ids) {
			const next = [...(row.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((token) => token !== "" && !token.startsWith(ID_PREFIX)), ...ids].join(" ");
			if (next !== "") setIfChanged(row, "aria-describedby", next);
			else if (row.hasAttribute("aria-describedby")) row.removeAttribute("aria-describedby");
		}
		/** An SVG element with attributes. */
		function svgNode(doc, name, attributes) {
			const node = doc.createElementNS(SVG_NS, name);
			for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
			return node;
		}
		/** Stroke style shared by every glyph; the color is the host's `currentColor`. */
		const LINE = {
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.5",
			"stroke-linecap": "round",
			"stroke-linejoin": "round"
		};
		/**
		* The 14 px glyph of a state, built with `createElementNS` (never from markup). The running ring's spin is CSS.
		* @param doc - the document that owns the node.
		* @param state - the state to draw.
		* @returns the svg element.
		*/
		function glyph(doc, state) {
			const svg = svgNode(doc, "svg", {
				width: "14",
				height: "14",
				viewBox: "0 0 14 14",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false"
			});
			const ring = (radius, extra = {}) => svgNode(doc, "circle", {
				cx: "7",
				cy: "7",
				r: radius,
				...LINE,
				...extra
			});
			const stroke = (d) => svgNode(doc, "path", {
				d,
				...LINE
			});
			switch (state) {
				case "running":
					svg.append(ring("5.25", { "stroke-opacity": "0.25" }), stroke("M7 1.75A5.25 5.25 0 0 1 12.25 7"));
					break;
				case "done":
					svg.append(ring("5.5", { "stroke-width": "1.25" }), stroke("M4.6 7.2 6.3 8.9 9.5 5.3"));
					break;
				case "failed":
					svg.append(ring("5.5", { "stroke-width": "1.25" }), stroke("M5.2 5.2 8.8 8.8M8.8 5.2 5.2 8.8"));
					break;
				case "stopped":
					svg.append(ring("5.5", { "stroke-width": "1.25" }), svgNode(doc, "rect", {
						x: "5.2",
						y: "5.2",
						width: "3.6",
						height: "3.6",
						rx: "0.7",
						fill: "currentColor"
					}));
					break;
				case "unknown": svg.append(svgNode(doc, "circle", {
					cx: "7",
					cy: "7",
					r: "2",
					fill: "currentColor"
				}));
			}
			return svg;
		}
		/** What the icon says in words (its `aria-label` and tooltip). A stop reason the dictionary knows is spelled out; any other is printed as the host sent it. */
		function statusText(mark, t) {
			switch (mark.state) {
				case "running": return t("sub.status.running");
				case "done": return t("sub.status.done");
				case "failed": {
					const reason = mark.stopReason;
					if (reason === null || reason === "") return t("sub.status.failed");
					const key = Object.hasOwn(REASON_KEYS, reason) ? REASON_KEYS[reason] : void 0;
					return t("sub.status.failedReason", { reason: key === void 0 ? reason : t(key) });
				}
				case "stopped": return t("sub.status.stopped");
				case "unknown": return t("sub.status.unknown");
			}
		}
		/**
		* Find the parts of a row, using structure only: the status dot is the row's `[data-state]` element and the text
		* block is the element that follows it (our own icon, when it already sits in between, does not count). The text
		* block must hold the row's label: a DSH that rearranged the row so that something else follows the dot is not
		* given a model label in the wrong place.
		* @param row - a `[role="treeitem"]` element.
		* @param label - the label the row's entry renders.
		* @returns the parts, or undefined when the row is not shaped like a DSH child row.
		*/
		function anatomyOf(row, label) {
			const dot = row.querySelector(DOT_SELECTOR);
			const host = dot?.parentElement;
			if (dot == null || host == null) return void 0;
			let content = dot.nextElementSibling;
			while (content !== null && isOwn(content)) content = content.nextElementSibling;
			if (content === null || !(content.textContent ?? "").startsWith(label)) return void 0;
			return {
				dot,
				host,
				content
			};
		}
		/**
		* Take every element and attribute this controller put on a row off again.
		* @param row - a `[role="treeitem"]` element.
		*/
		function clearRow(row) {
			for (const element of Array.from(row.querySelectorAll(OWN_SELECTOR))) element.remove();
			if (row.hasAttribute(ROW_ATTR)) row.removeAttribute(ROW_ATTR);
			setDescribedBy(row, []);
		}
		/**
		* Take everything this controller added off a whole menu.
		* @param root - the menu element.
		*/
		function sweep(root) {
			for (const element of Array.from(root.querySelectorAll(`${OWN_SELECTOR}, [${ROW_ATTR}], [aria-describedby*="${ID_PREFIX}"]`))) {
				if (isOwn(element)) {
					element.remove();
					continue;
				}
				if (element.hasAttribute(ROW_ATTR)) element.removeAttribute(ROW_ATTR);
				setDescribedBy(element, []);
			}
		}
		/** The model label of a route; a catalog that cannot be read costs the display names, not the label. */
		function routeLabel(groups, route) {
			try {
				return describeRoute(groups, route);
			} catch {
				return route === null ? void 0 : {
					model: route.model,
					effort: route.reasoningEffort ?? null
				};
			}
		}
		/**
		* Draw one row's mark, idempotently: nothing is touched unless the state or the text changed. The status icon is
		* inserted immediately before DSH's dot (which stays where React put it), the model label is appended to the
		* text block, and the row's `aria-describedby` points at both so that a screen reader hears them with the row.
		* @param doc - the document that owns the nodes.
		* @param row - a `[role="treeitem"]` element.
		* @param mark - what to show.
		* @param label - the label the row's entry renders (the text block must start with it).
		* @param status - whether the status icon may be drawn yet (the model label is drawn either way).
		* @param groups - the model catalog groups (empty until the catalog loaded: raw ids show).
		* @param t - this plugin's translate function.
		* @param live - whether the controller is still running: the translator is outside code, and may have retired it.
		* @returns false when the row is not shaped like a DSH child row, or the controller was retired meanwhile (nothing was added, and anything we added is gone).
		* @throws when a text cannot be written (the translator failed) or the DOM refuses; the row is then back as DSH drew it.
		*/
		function applyMark(doc, row, mark, label, status, groups, t, live) {
			const anatomy = anatomyOf(row, label);
			if (anatomy === void 0) {
				clearRow(row);
				return false;
			}
			const { dot, host, content } = anatomy;
			const text = statusText(mark, t);
			const model = routeLabel(groups, mark.route);
			const shown = model === void 0 ? "" : model.effort === null ? model.model : `${model.model} \u00b7 ${model.effort}`;
			const title = model === void 0 ? "" : model.effort === null ? t("sub.model.title", { model: model.model }) : t("sub.model.titleEffort", {
				model: model.model,
				effort: model.effort
			});
			if (!live()) return false;
			try {
				let icon = childWithClass(host, ICON_CLASS);
				if (status) {
					if (icon === void 0) {
						icon = doc.createElement("span");
						icon.className = ICON_CLASS;
						icon.setAttribute("role", "img");
						host.insertBefore(icon, dot);
					} else if (icon.nextElementSibling !== dot) host.insertBefore(icon, dot);
					removeOthers(host, ICON_CLASS, icon);
					if (icon.getAttribute(STATE_ATTR) !== mark.state || icon.firstElementChild === null) {
						icon.setAttribute(STATE_ATTR, mark.state);
						icon.replaceChildren(glyph(doc, mark.state));
					}
					ensureId(icon);
					setIfChanged(icon, "aria-label", text);
					setIfChanged(icon, "title", text);
					setIfChanged(row, ROW_ATTR, "");
				} else if (icon !== void 0) {
					icon.remove();
					icon = void 0;
					if (row.hasAttribute(ROW_ATTR)) row.removeAttribute(ROW_ATTR);
				}
				let tag;
				let modelHost = childWithClass(content, MODEL_CLASS);
				if (model === void 0) modelHost?.remove();
				else {
					if (modelHost === void 0) {
						modelHost = doc.createElement("span");
						modelHost.className = MODEL_CLASS;
						content.append(modelHost);
					}
					removeOthers(content, MODEL_CLASS, modelHost);
					tag = childWithClass(modelHost, TAG_CLASS);
					if (tag === void 0) {
						tag = doc.createElement("span");
						tag.className = TAG_CLASS;
						modelHost.append(tag);
					}
					ensureId(tag);
					if (tag.textContent !== shown) tag.textContent = shown;
					setIfChanged(tag, "title", title);
				}
				setDescribedBy(row, [icon?.id ?? "", tag?.id ?? ""].filter((id) => id !== ""));
				return true;
			} catch (error) {
				clearRow(row);
				throw error;
			}
		}
		/**
		* Start decorating DSH's subagent menu whenever it opens. Fail-open and silent: with no session list, no
		* MutationObserver or any failure of its own it leaves the menu exactly as DSH draws it, and it never throws. A
		* newer controller on the same document retires the older one first, so two never fight over the same rows.
		* @param deps - the page, the stores and carriers it reads, and the diagnostics sink.
		* @returns the disposer: it stops every observer, timer, subscription and request, and removes every element and attribute added.
		*/
		function installSubagentMarks(deps) {
			let disposed = false;
			let warned = false;
			let bodyObserver;
			const doc = deps.document;
			const menus = /* @__PURE__ */ new Map();
			/** The last ledger answer per root session. */
			const ledgers = /* @__PURE__ */ new Map();
			const inflight = /* @__PURE__ */ new Map();
			const again = /* @__PURE__ */ new Set();
			let groups = [];
			let groupsAt;
			/** The model catalog request in flight, if any (a request that never answers stops blocking after a while). */
			let groupsRequest;
			const pollMs = typeof deps.pollMs === "number" && Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : DEFAULT_POLL_MS;
			const timers = deps.timers ?? {
				setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
				clearInterval: (handle) => {
					globalThis.clearInterval(handle);
				}
			};
			const clock = () => deps.now === void 0 ? Date.now() : deps.now();
			/** Report the first failure, once; later ones would only repeat it on every poll. */
			const fail = (message, error) => {
				if (warned) return;
				warned = true;
				try {
					deps.warn(message, error);
				} catch {}
			};
			/** Run a callback that must never throw into the page. */
			const guarded = (task) => {
				try {
					task();
				} catch (error) {
					fail("the subagent menu marks failed; the menu stays as DSH draws it", error);
				}
			};
			/** Run an async task whose failure must never surface as an unhandled rejection. */
			const spawn = (task) => {
				try {
					task().catch((error) => {
						fail("the subagent menu marks failed; the menu stays as DSH draws it", error);
					});
				} catch (error) {
					fail("the subagent menu marks failed; the menu stays as DSH draws it", error);
				}
			};
			/** A one-shot timer built on the injected interval API, so a test drives every timer through one fake. */
			const later = (ms, task) => {
				let handle;
				let live = true;
				const cancel = () => {
					if (!live) return;
					live = false;
					guarded(() => {
						timers.clearInterval(handle);
					});
				};
				handle = timers.setInterval(() => {
					if (!live) return;
					cancel();
					guarded(task);
				}, ms);
				return cancel;
			};
			/** Re-scan a menu once, however many things asked for it in this turn. */
			function scheduleScan(state) {
				if (disposed || state.detached || state.scanQueued) return;
				state.scanQueued = true;
				const run = () => {
					state.scanQueued = false;
					guarded(() => {
						scan(state);
					});
				};
				if (typeof queueMicrotask === "function") queueMicrotask(run);
				else Promise.resolve().then(run);
			}
			function rescanAll() {
				for (const state of [...menus.values()]) scheduleScan(state);
			}
			/** Keep what a ledger request found, newest last, bounded. A failed request keeps what was known (and says an answer came). */
			function settle(root, payload) {
				const previous = ledgers.get(root);
				if (payload === void 0 && previous !== void 0) return;
				const records = /* @__PURE__ */ new Map();
				for (const record of payload?.subagents ?? []) records.set(record.id, record);
				ledgers.delete(root);
				ledgers.set(root, {
					records,
					hostNow: payload?.now,
					receivedAt: clock()
				});
				while (ledgers.size > MAX_LEDGERS) {
					const oldest = ledgers.keys().next();
					if (oldest.done === true) break;
					ledgers.delete(oldest.value);
				}
			}
			/**
			* Now, in the clock the ledger's times are in. The host's clock when it said what time it was, carried forward by
			* the time that has passed here since (a delta of this page's own clock, so a skewed or tunnelled browser clock
			* cannot misjudge a record's age); this page's clock only for a host that does not say.
			*/
			function ledgerClock(ledger) {
				const here = clock();
				return ledger.hostNow === void 0 ? here : ledger.hostNow + Math.max(0, here - ledger.receivedAt);
			}
			/** Read the ledger of a root session; one request at a time per root, and never one that waits for ever. */
			function refresh(root, trailing) {
				if (disposed) return;
				if (inflight.has(root)) {
					if (trailing) again.add(root);
					return;
				}
				const controller = new AbortController();
				const request = {
					controller,
					cancelWatchdog: () => void 0
				};
				inflight.set(root, request);
				request.cancelWatchdog = later(LEDGER_WATCHDOG_MS, () => {
					if (inflight.get(root) === request) inflight.delete(root);
					guarded(() => {
						controller.abort();
					});
					fail("the subagent ledger did not answer in time");
					settle(root, void 0);
					rescanAll();
					if (again.delete(root)) refresh(root, false);
				});
				spawn(async () => {
					let payload;
					try {
						payload = await deps.client.list(root, controller.signal);
					} catch (error) {
						if (!controller.signal.aborted) fail("could not read the subagent ledger", error);
					}
					if (controller.signal.aborted || disposed) return;
					request.cancelWatchdog();
					if (inflight.get(root) === request) inflight.delete(root);
					settle(root, payload);
					rescanAll();
					if (again.delete(root)) refresh(root, false);
				});
			}
			/** Ask for the model names once per opening of a menu, and reuse them for a minute. */
			function ensureGroups(state, visible) {
				if (state.catalogAsked) return;
				const sessionId = visible[0] ?? state.root;
				if (sessionId === void 0) return;
				state.catalogAsked = true;
				const now = clock();
				const age = groupsAt === void 0 ? Number.POSITIVE_INFINITY : now - groupsAt;
				if (age >= 0 && age < CATALOG_TTL_MS) return;
				if (groupsRequest !== void 0 && now - groupsRequest.at >= 0 && now - groupsRequest.at < CATALOG_RETRY_MS) return;
				const request = { at: now };
				groupsRequest = request;
				spawn(async () => {
					try {
						const loaded = await deps.loadCatalog(sessionId);
						if (!disposed && loaded.status === "ready" && Array.isArray(loaded.groups)) {
							groups = loaded.groups;
							groupsAt = clock();
						}
					} finally {
						if (groupsRequest === request) groupsRequest = void 0;
					}
					if (!disposed) rescanAll();
				});
			}
			/** The sessions that are on the page; a failing source costs the candidates it would have given, not the scan. */
			function visibleIds() {
				try {
					const ids = deps.visibleSessionIds();
					return Array.isArray(ids) ? ids : [];
				} catch (error) {
					fail("could not list the visible conversations", error);
					return [];
				}
			}
			/**
			* The sessions the page shows: each visible conversation and every ancestor of it, walking `parentId` while the
			* session is a subagent (DSH's header does the same, and gives each of those crumbs its own menu, so any of them
			* can be the root of the menu that is open).
			*/
			function sessionsOnPage(byId, visible) {
				const ids = /* @__PURE__ */ new Set();
				for (const start of visible) {
					let cursor = start;
					while (cursor !== void 0 && !ids.has(cursor)) {
						ids.add(cursor);
						const summary = ownValue(byId, cursor);
						cursor = summary?.origin === "subagent" ? summary.parentId : void 0;
					}
				}
				return [...ids];
			}
			/** Re-read the menu and bring its marks up to date. */
			function scan(state) {
				if (disposed || state.detached) return;
				if (!state.menu.isConnected) {
					detach(state);
					return;
				}
				const list = deps.sessions.list;
				if (list === void 0) return;
				const snapshot = list.getSnapshot();
				const items = Array.from(state.menu.querySelectorAll("[role=\"treeitem\"]"));
				const visible = visibleIds();
				const onPage = sessionsOnPage(snapshot.byId, visible);
				const onPageSet = new Set(onPage);
				const tiers = [onPage, Object.keys(snapshot.subagentsByParent).filter((id) => !onPageSet.has(id))];
				const resolved = resolveRows(items.map(readRow), snapshot.subagentsByParent, tiers, {
					titleOf: (id) => {
						const title = ownValue(snapshot.byId, id)?.title;
						return typeof title === "string" ? title : void 0;
					},
					onPage
				});
				const t = deps.locale.bind(NS);
				if (disposed || state.detached) return;
				if (resolved.root !== state.root) {
					state.root = resolved.root;
					if (resolved.root !== void 0) refresh(resolved.root, false);
				}
				const ledger = state.root === void 0 ? void 0 : ledgers.get(state.root);
				const status = ledger !== void 0 || clock() - state.attachedAt >= STATUS_GRACE_MS;
				const now = ledger === void 0 ? clock() : ledgerClock(ledger);
				const activities = /* @__PURE__ */ new Map();
				items.forEach((item, index) => {
					try {
						const hit = resolved.rows[index];
						if (hit === void 0) {
							clearRow(item);
							return;
						}
						activities.set(hit.entry.id, hit.entry.activity);
						const mark = markFor(hit.entry, ledger?.records.get(hit.entry.id), ownValue(snapshot.byId, hit.entry.id), now);
						applyMark(doc, item, mark, entryLabel(hit.entry), status, groups, t, () => !disposed && !state.detached);
					} catch (error) {
						fail("could not mark a row of the subagent menu; it stays as DSH draws it", error);
					}
				});
				if (disposed || state.detached) return;
				let flipped = false;
				for (const [id, activity] of activities) {
					const before = state.activities.get(id);
					if (before !== void 0 && before !== activity) flipped = true;
				}
				state.activities = activities;
				if (flipped && state.root !== void 0) scheduleRefetch(state);
				ensureGroups(state, visible);
			}
			/** One debounced re-read of the ledger after a status flip. */
			function scheduleRefetch(state) {
				if (state.cancelRefetch !== void 0 || state.detached) return;
				state.cancelRefetch = later(REFETCH_DELAY_MS, () => {
					state.cancelRefetch = void 0;
					if (!state.detached && state.root !== void 0) refresh(state.root, true);
				});
			}
			/** The poll: re-read the ledger of the menu's root and re-check its rows. */
			function tick(state) {
				if (disposed || state.detached) return;
				if (!state.menu.isConnected) {
					detach(state);
					return;
				}
				if (state.root !== void 0) refresh(state.root, false);
				scheduleScan(state);
			}
			/** Start decorating one menu. */
			function attach(menu) {
				const list = deps.sessions.list;
				const Observer = doc.defaultView?.MutationObserver;
				if (list === void 0 || Observer === void 0) return;
				const state = {
					menu,
					attachedAt: clock(),
					observer: void 0,
					polling: false,
					interval: void 0,
					unsubscribers: [],
					root: void 0,
					activities: /* @__PURE__ */ new Map(),
					scanQueued: false,
					catalogAsked: false,
					cancelRefetch: void 0,
					detached: false
				};
				menus.set(menu, state);
				try {
					state.observer = new Observer((records) => {
						guarded(() => {
							if (records.some((record) => !isOwnMutation(record))) scheduleScan(state);
						});
					});
					state.observer.observe(menu, {
						childList: true,
						subtree: true
					});
					guarded(() => {
						state.unsubscribers.push(list.subscribe(() => {
							scheduleScan(state);
						}));
					});
					guarded(() => {
						state.unsubscribers.push(deps.locale.subscribe(() => {
							scheduleScan(state);
						}));
					});
					guarded(() => {
						scan(state);
					});
					state.interval = timers.setInterval(() => {
						guarded(() => {
							tick(state);
						});
					}, pollMs);
					state.polling = true;
				} catch (error) {
					fail("could not decorate the subagent menu; it stays as DSH draws it", error);
					detach(state);
				}
			}
			/** Stop decorating one menu and take its marks off. */
			function detach(state) {
				if (state.detached) return;
				state.detached = true;
				menus.delete(state.menu);
				guarded(() => {
					state.observer?.disconnect();
				});
				if (state.polling) guarded(() => {
					timers.clearInterval(state.interval);
				});
				state.cancelRefetch?.();
				state.cancelRefetch = void 0;
				for (const unsubscribe of state.unsubscribers) guarded(unsubscribe);
				state.unsubscribers.length = 0;
				guarded(() => {
					sweep(state.menu);
				});
			}
			/** The title DSH's own menu carries in the active language, or undefined when it cannot be looked up. */
			function nativeTitle() {
				try {
					const title = deps.locale.bind(NATIVE_NS)(NATIVE_TREE_KEY);
					return typeof title === "string" && title !== "" && title !== NATIVE_TREE_KEY ? title : void 0;
				} catch {
					return;
				}
			}
			/** Whether a body-level `role="tree"` is DSH's subagent menu. */
			function isSubagentMenu(element) {
				const title = nativeTitle();
				if (title !== void 0) return element.getAttribute("aria-label") === title;
				const items = Array.from(element.querySelectorAll("[role=\"treeitem\"]"));
				return items.length > 0 && items.every((item) => item.querySelector(DOT_SELECTOR) !== null);
			}
			/** Look at one node that appeared on the body. */
			function consider(node) {
				if (disposed || node.nodeType !== 1) return;
				const element = node;
				if (menus.has(element) || !element.isConnected || element.getAttribute("role") !== "tree") return;
				if (isSubagentMenu(element)) attach(element);
			}
			/** Where the live controller of this document is kept (see {@link LIVE_KEY}). */
			const registry = doc;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				guarded(() => {
					bodyObserver?.disconnect();
				});
				bodyObserver = void 0;
				for (const state of [...menus.values()]) detach(state);
				for (const request of inflight.values()) {
					request.cancelWatchdog();
					guarded(() => {
						request.controller.abort();
					});
				}
				inflight.clear();
				again.clear();
				ledgers.clear();
				guarded(() => {
					delete registry[LIVE_KEY];
				});
			};
			try {
				guarded(() => {
					registry[LIVE_KEY]?.dispose();
				});
				const Observer = doc.defaultView?.MutationObserver;
				const body = doc.body;
				if (Observer === void 0 || body === null) {
					fail("the page has no body to watch for the subagent menu; the menu stays as DSH draws it");
					return dispose;
				}
				guarded(() => {
					registry[LIVE_KEY] = { dispose };
				});
				bodyObserver = new Observer((records) => {
					guarded(() => {
						for (const record of records) {
							for (const node of Array.from(record.removedNodes)) {
								const state = menus.get(node);
								if (state !== void 0) detach(state);
							}
							for (const node of Array.from(record.addedNodes)) consider(node);
						}
					});
				});
				bodyObserver.observe(body, { childList: true });
				for (const child of Array.from(body.children)) guarded(() => {
					consider(child);
				});
			} catch (error) {
				fail("could not start the subagent menu marks; the menu stays as DSH draws it", error);
				dispose();
			}
			return dispose;
		}
		//#endregion
		//#region src/client/subagents-client.ts
		/**
		* Browser HTTP carrier of the host's subagent ledger: which model each
		* subagent runs on and how it ended. The marks on DSH's subagent menu are an
		* extra, so this carrier never raises: a host that predates the route answers
		* 404, a host that is restarting does not answer, and either way the menu just
		* keeps the marks it can draw without the ledger.
		* @module dsh-orquestrator/client/subagents-client
		*/
		/** Per-request deadline: the route is local, so a slow answer means it is not there. */
		const REQUEST_TIMEOUT_MS = 5e3;
		/**
		* A signal that aborts when the caller's signal does or after the deadline, whichever comes first, and a promise
		* that settles at that moment. The promise is what keeps a request from hanging: a `fetch` that ignores its
		* signal never settles, and `abort()` alone cannot make it.
		* @param parent - the caller's signal, if any.
		* @param ms - the deadline in milliseconds.
		* @returns the combined signal, the promise that resolves (to undefined) when it aborts, and the function that releases the timer and the listener.
		*/
		function withDeadline(parent, ms) {
			const controller = new AbortController();
			const expired = new Promise((resolve) => {
				controller.signal.addEventListener("abort", () => {
					resolve(void 0);
				}, { once: true });
			});
			const onParentAbort = () => {
				controller.abort(parent?.reason);
			};
			const timer = setTimeout(() => {
				controller.abort(new DOMException("the subagent ledger did not answer in time", "TimeoutError"));
			}, ms);
			if (parent?.aborted === true) onParentAbort();
			else parent?.addEventListener("abort", onParentAbort, { once: true });
			return {
				signal: controller.signal,
				expired,
				release() {
					clearTimeout(timer);
					parent?.removeEventListener("abort", onParentAbort);
				}
			};
		}
		/** HTTP carrier of the host's subagent ledger. */
		var SubagentsClient = class {
			fetcher;
			base;
			timeoutMs;
			routeMissing = false;
			/**
			* @param fetcher - HTTP carrier; defaults to the global `fetch`.
			* @param base - resolver of the host base URL.
			* @param timeoutMs - per-request deadline.
			*/
			constructor(fetcher = (input, init) => fetch(input, init), base = hostBase, timeoutMs = REQUEST_TIMEOUT_MS) {
				this.fetcher = fetcher;
				this.base = base;
				this.timeoutMs = timeoutMs;
			}
			/**
			* Whether the host answered 404: it predates the ledger route (a host older than 0.8). That is remembered for the
			* life of this client, which is the life of the page: the route is not asked for again, because nothing a poll
			* could find out would change. A host that gains the route is picked up by reloading the page, like every
			* other update of this plugin.
			*/
			get missing() {
				return this.routeMissing;
			}
			/**
			* Read the subagents started under a session, with their model and outcome.
			* @param sessionId - the session whose subagents (direct and deeper) to list.
			* @param signal - cancellation of the call; the request also has a deadline of its own, which holds even for a `fetch` that ignores its signal.
			* @returns the ledger answer (with the host's clock in `now` when the host sends it), or undefined when it could not be read: a network error, a status that is not OK, an answer that is not JSON, a malformed body, a deadline that passed, or a host that predates the route. Never throws.
			*/
			async list(sessionId, signal) {
				if (this.routeMissing || signal?.aborted === true) return void 0;
				const deadline = withDeadline(signal, this.timeoutMs);
				try {
					return await Promise.race([this.read(sessionId, deadline.signal), deadline.expired]);
				} catch {
					return;
				} finally {
					deadline.release();
				}
			}
			/** One request and its answer; failures reject, and {@link list} turns them into undefined. */
			async read(sessionId, signal) {
				const url = new URL(SUBAGENTS_ROUTE, this.base());
				url.searchParams.set("sessionId", sessionId);
				const response = await this.fetcher(url, {
					headers: { accept: "application/json" },
					cache: "no-store",
					signal
				});
				if (response.status === 404) {
					this.routeMissing = true;
					return;
				}
				if (!response.ok) return void 0;
				return parseSubagentsPayload(await response.json());
			}
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services: the session registry, the slot registry and the locale runtime. */
		const inject = [
			"sessions",
			"slots",
			"locale"
		];
		/** The page's `localStorage`, or undefined when the browser blocks it. */
		function safeStorage() {
			try {
				return globalThis.localStorage;
			} catch {
				return;
			}
		}
		/**
		* Client plugin body.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const sessions = ctx.get("sessions");
			const slots = ctx.get("slots");
			const locale = ctx.get("locale");
			ctx.effect(() => installStyles(document), "dsh-orquestrator: styles");
			ctx.effect(() => locale.register(NS, "en", en), "dsh-orquestrator: dictionary (en)");
			ctx.effect(() => locale.register(NS, "pt", pt), "dsh-orquestrator: dictionary (pt)");
			ctx.effect(() => locale.register(NS, "zh", zh), "dsh-orquestrator: dictionary (zh)");
			const client = new ConfigClient();
			const dialogs = new DialogHost();
			const memory = createLastChoiceMemory(safeStorage());
			const gate = new PromptGate({
				client,
				dialogs,
				memory,
				skillMemory: createSkillChoiceMemory(safeStorage()),
				warn: (message, error) => {
					console.warn(`dsh-orquestrator: ${message}`, error);
				}
			});
			const host = {
				dialogs,
				locale,
				attachGate(sessionId) {
					return attachWhenAvailable(() => sessions.binding(sessionId)?.session, gate, (message, error) => {
						console.warn(`dsh-orquestrator: ${message}`, error);
					});
				},
				loadStored(sessionId) {
					return client.load(sessionId);
				},
				loadCatalog(sessionId) {
					return loadCatalog$1({
						modelDirectories: () => ctx.get("modelDirectories"),
						remoteSession: () => ctx.get("remote")?.session
					}, sessionId);
				},
				openConfigure: (sessionId) => openConfigure(sessionId)
			};
			ctx.effect(() => slots.inject("conversation.input.overlay", () => slots.register({
				name: "conversation.input.overlay",
				id: "dsh-orquestrator",
				order: 20,
				inject: () => ({ host })
			}, OrchestratorOverlay)), "dsh-orquestrator: composer overlay");
			ctx.effect(() => slots.inject("conversation.composer.dock", () => slots.register({
				name: "conversation.composer.dock",
				id: "dsh-orquestrator",
				order: 10,
				inject: () => ({ host })
			}, ConfigChip)), "dsh-orquestrator: config chip");
			ctx.effect(() => installSubagentMarks({
				document,
				sessions,
				locale,
				client: new SubagentsClient(),
				visibleSessionIds: () => dialogs.presenterSessionIds(),
				loadCatalog: (sessionId) => host.loadCatalog(sessionId),
				warn: (message, error) => {
					console.warn(`dsh-orquestrator: ${message}`, error);
				}
			}), "dsh-orquestrator: subagent marks");
			ctx.inject(["commandUi"], (scope) => {
				const commandUi = scope.get("commandUi");
				const t = locale.bind(NS);
				scope.effect(() => commandUi.register({
					name: "orquestrar",
					label: () => t("command.label"),
					description: () => t("command.description"),
					icon: _deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16,
					available: () => true,
					ui: {
						kind: "action",
						run(session) {
							openConfigure(session.sessionId);
						}
					}
				}), "dsh-orquestrator: /orquestrar command");
			});
			/** Open the dialog in configure mode (nothing waits on it). */
			async function openConfigure(sessionId) {
				if (!dialogs.hasPresenter(sessionId)) return;
				let stored = null;
				try {
					stored = await client.load(sessionId);
				} catch (error) {
					console.warn("dsh-orquestrator: could not read the stored choice; opening with defaults", error);
				}
				if (!dialogs.hasPresenter(sessionId)) return;
				await dialogs.request({
					sessionId,
					mode: "configure",
					preview: "",
					initial: () => stored ?? memory.read() ?? OFF_CONFIG,
					skill: null,
					skillInMessage: false,
					initialSkill: false,
					save: async (config) => {
						await client.save(sessionId, config);
					}
				});
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
