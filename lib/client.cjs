window.__ModuleLoader__.load({
	id: "dsh-orquestrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/** Session configuration route: `GET ?sessionId=<id>` reads, `POST` writes or clears. */
		const CONFIG_ROUTE = `/dsh-orquestrator/config`;
		/** The inert configuration: exactly the stock DSH behavior. */
		const OFF_CONFIG = Object.freeze({
			version: 1,
			subagentModel: null,
			reviewer: Object.freeze({
				enabled: false,
				model: null
			}),
			remember: false
		});
		/**
		* Whether a configuration changes anything relative to stock DSH.
		* @param config - a session configuration, or null/undefined for "none".
		* @returns true when a different subagent model or the reviewer is on.
		*/
		function isActive(config) {
			return config != null && (config.subagentModel !== null || config.reviewer.enabled);
		}
		/** Longest provider/model/effort id the validator admits (defensive bound). */
		const MAX_ID_LENGTH = 256;
		/** A plain object check that also excludes arrays. */
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/** A bounded, non-empty, control-character-free identifier string. */
		function isId(value) {
			return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
		}
		/**
		* Parse one model route from untrusted JSON.
		* @param value - candidate value.
		* @returns the normalized route, or undefined when malformed.
		*/
		function parseModelRoute(value) {
			if (!isRecord(value) || !isId(value["provider"]) || !isId(value["model"])) return void 0;
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
		* Parse a session configuration from untrusted JSON (request body or disk).
		* @param value - candidate value.
		* @returns the normalized configuration, or undefined when malformed.
		*/
		function parseConfig(value) {
			if (!isRecord(value) || value["version"] !== 1) return void 0;
			const rawSubagent = value["subagentModel"];
			const subagentModel = rawSubagent === null || rawSubagent === void 0 ? null : parseModelRoute(rawSubagent);
			if (subagentModel === void 0) return void 0;
			const reviewer = value["reviewer"];
			if (!isRecord(reviewer) || typeof reviewer["enabled"] !== "boolean") return void 0;
			const rawReviewerModel = reviewer["model"];
			const reviewerModel = rawReviewerModel === null || rawReviewerModel === void 0 ? null : parseModelRoute(rawReviewerModel);
			if (reviewerModel === void 0) return void 0;
			if (typeof value["remember"] !== "boolean") return void 0;
			return {
				version: 1,
				subagentModel,
				reviewer: {
					enabled: reviewer["enabled"],
					model: reviewerModel
				},
				remember: value["remember"]
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
				reviewer: {
					enabled: input.reviewerEnabled,
					model: input.reviewerEnabled ? input.reviewerModel : null
				},
				remember: input.remember
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
		async function loadCatalog(sources, sessionId) {
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
		//#endregion
		//#region src/client/config-client.ts
		/**
		* Browser HTTP carrier for the per-session configuration route. The browser's
		* same-origin session (cookies, Host/Origin) is what the host's connection
		* trust fence authenticates, exactly like the built-in `/api` traffic.
		* @module dsh-orquestrator/client/config-client
		*/
		/** Per-request deadline: the route is local, so a slow answer means it is not there. */
		const REQUEST_TIMEOUT_MS = 8e3;
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
				const url = new URL(CONFIG_ROUTE, this.base());
				url.searchParams.set("sessionId", sessionId);
				return (await this.call(url, { headers: { accept: "application/json" } })).config;
			}
			/**
			* Store (or clear, with null) a session's configuration.
			* @param sessionId - the session.
			* @param config - the configuration, or null to clear.
			* @returns the configuration as the host stored it.
			* @throws {ConfigHttpError} when the route is unreachable or refuses.
			*/
			async save(sessionId, config) {
				return (await this.call(new URL(CONFIG_ROUTE, this.base()), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						config
					})
				})).config;
			}
			/** One request: bounded time, structured failure, validated success body. */
			async call(url, init) {
				let response;
				try {
					response = await this.fetcher(url, {
						...init,
						signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
					config
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
			* resolves as a cancel (a superseded send must not leave a dialog behind).
			* @param input - session, mode, preview, initial values and persistence.
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
						resolvePromise(result);
					};
					const pending = {
						request: {
							...input,
							id: this.nextId++,
							resolve: (result) => {
								this.finish(pending, result);
							}
						},
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
					const active = this.currentStore.getSnapshot();
					if (active?.sessionId === sessionId && !this.presenters.has(sessionId)) active.resolve({ kind: "cancel" });
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
				if (this.currentStore.getSnapshot() === pending.request) this.currentStore.set(null);
				const index = this.queue.indexOf(pending);
				if (index >= 0) this.queue.splice(index, 1);
				pending.settle(result);
				this.advance();
			}
			/** Put the head of the queue on screen when nothing is. */
			advance() {
				if (this.currentStore.getSnapshot() !== null) return;
				const head = this.queue[0];
				if (head !== void 0) this.currentStore.set(head.request);
			}
		};
		//#endregion
		//#region src/client/gate.ts
		/**
		* The prompt gate: the seam between "the user pressed send" and "the prompt
		* reaches the host". Every browser-authored message goes through
		* `SessionFace.prompt`, so the gate wraps that one method on the mounted
		* session face. Before a NEW task (an idle top-level session) it raises the
		* modal and waits for the answer; anything else passes straight through.
		*
		* The gate is fail-open by construction: any problem (host route missing, no
		* composer mounted to show the dialog, an exception here) sends the prompt
		* exactly as stock DSH would. It can delay a send, never lose one.
		* @module dsh-orquestrator/client/gate
		*/
		/** Longest task preview shown in the dialog. */
		const PREVIEW_CHARS = 240;
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
		/** The gate. */
		var PromptGate = class {
			/** Patched objects (a session class prototype, or a single face) with their attach counts. */
			patched = /* @__PURE__ */ new Map();
			deps;
			/**
			* @param deps - HTTP client, dialog host, last-choice memory and diagnostics.
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
			* original method exactly.
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
				const gate = this;
				const wrapper = async function wrapped(content, mode, signal, requestId) {
					try {
						await gate.beforePrompt(this, content, mode, signal);
					} catch (error) {
						gate.deps.warn("gate failed; sending as stock DSH would", error);
					}
					return original.call(this, content, mode, signal, requestId);
				};
				const hadOwn = Object.prototype.hasOwnProperty.call(target, "prompt");
				holder.prompt = wrapper;
				const restore = () => {
					if (holder.prompt !== wrapper) return;
					if (hadOwn) holder.prompt = original;
					else delete holder.prompt;
				};
				this.patched.set(target, {
					count: 1,
					restore
				});
				return () => {
					this.release(target);
				};
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
			* Decide whether this prompt is a new task worth asking about, and ask.
			* @param face - the session face sending the prompt.
			* @param content - the prompt parts.
			* @param mode - the delivery mode the composer chose.
			* @param signal - cancellation of the surrounding send.
			* @returns when the prompt may proceed.
			*/
			async beforePrompt(face, content, mode, signal) {
				const snapshot = face.getSnapshot();
				if (snapshot.subagent !== null || snapshot.running || mode !== "queue") return;
				const text = textOf(content).trim();
				if (text.startsWith("/")) return;
				if (text === "" && content.length === 0) return;
				const sessionId = face.sessionId;
				const { client, dialogs, memory } = this.deps;
				let stored;
				try {
					stored = await client.load(sessionId);
				} catch (error) {
					this.deps.warn("configuration route unavailable; not asking", error);
					return;
				}
				if (stored !== null && stored.remember && isActive(stored)) return;
				if (!dialogs.hasPresenter(sessionId)) {
					if (isActive(stored)) await client.save(sessionId, null).catch((error) => {
						this.deps.warn("could not clear a stale choice", error);
					});
					return;
				}
				const initial = stored ?? memory.read() ?? OFF_CONFIG;
				const result = await dialogs.request({
					sessionId,
					mode: "gate",
					preview: previewOf(text),
					initial,
					save: async (config) => {
						await client.save(sessionId, config);
					}
				}, signal);
				if (result.kind === "confirm") memory.write(result.config);
			}
		};
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
						return JSON.parse(raw);
					} catch {
						return null;
					}
				},
				write(config) {
					try {
						storage?.setItem(KEY, JSON.stringify({
							...config,
							remember: false
						}));
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
			"dialog.description.gate": "Choose how subagents handle this task. Cancel sends the task as usual.",
			"dialog.description.configure": "Choose how subagents work in this conversation. The options apply from the next task.",
			"task.label": "Task",
			"subagents.title": "Subagent model",
			"subagents.switch": "Use a different model for subagents",
			"subagents.same": "Subagents use the main agent's model ({model}). Turn on to choose another.",
			"subagents.same.unknown": "Subagents use the main agent's model. Turn on to choose another.",
			"subagents.modelLabel": "Model for subagents",
			"subagents.needModel": "Choose a model to continue.",
			"subagents.main": "The main agent stays on {model}.",
			"reviewer.title": "Independent reviewer",
			"reviewer.description": "Checks each subagent's work before it reaches the main agent.",
			"reviewer.switch": "Review the work of each subagent",
			"reviewer.how.1": "Starts right after each subagent finishes",
			"reviewer.how.2": "Runs or writes tests to validate the work",
			"reviewer.how.3": "Fixes only what is actually broken",
			"reviewer.how.4": "Delivers the result to the main agent in place of the subagent",
			"reviewer.modelLabel": "Model for the reviewer",
			"reviewer.sameAsSubagent": "Same model as the subagent",
			"reviewer.tip.sameModel": "Tip: a reviewer on a different model tends to catch different mistakes than the model that did the work.",
			"remember.label": "Do not ask again in this conversation",
			"button.cancel": "Cancel",
			"button.cancelHint": "Sends the task as usual",
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
			"command.description": "Choose the subagent model and an independent reviewer for this conversation"
		};
		/** Portuguese (Brazil) dictionary. */
		const pt = {
			"dialog.title": "Orquestrar subagentes",
			"dialog.close": "Fechar",
			"dialog.description.gate": "Escolha como os subagentes tratam esta tarefa. Cancelar envia a tarefa normalmente.",
			"dialog.description.configure": "Escolha como os subagentes trabalham nesta conversa. As opções valem a partir da próxima tarefa.",
			"task.label": "Tarefa",
			"subagents.title": "Modelo dos subagentes",
			"subagents.switch": "Usar outro modelo nos subagentes",
			"subagents.same": "Os subagentes usam o modelo do agente principal ({model}). Ligue para escolher outro.",
			"subagents.same.unknown": "Os subagentes usam o modelo do agente principal. Ligue para escolher outro.",
			"subagents.modelLabel": "Modelo dos subagentes",
			"subagents.needModel": "Escolha um modelo para continuar.",
			"subagents.main": "O agente principal continua em {model}.",
			"reviewer.title": "Revisor independente",
			"reviewer.description": "Confere o trabalho de cada subagente antes de entregar ao agente principal.",
			"reviewer.switch": "Revisar o trabalho de cada subagente",
			"reviewer.how.1": "Entra logo depois que cada subagente termina",
			"reviewer.how.2": "Executa ou cria testes para validar o trabalho",
			"reviewer.how.3": "Corrige apenas o que realmente estiver quebrado",
			"reviewer.how.4": "Entrega o resultado ao agente principal, no lugar do subagente",
			"reviewer.modelLabel": "Modelo do revisor",
			"reviewer.sameAsSubagent": "Mesmo modelo do subagente",
			"reviewer.tip.sameModel": "Dica: um revisor em outro modelo tende a pegar erros diferentes dos do modelo que fez o trabalho.",
			"remember.label": "Não perguntar de novo nesta conversa",
			"button.cancel": "Cancelar",
			"button.cancelHint": "Envia a tarefa normalmente",
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
			"command.description": "Escolha o modelo dos subagentes e um revisor independente nesta conversa"
		};
		/** Simplified Chinese dictionary. */
		const zh = {
			"dialog.title": "编排子智能体",
			"dialog.close": "关闭",
			"dialog.description.gate": "选择子智能体如何处理这项任务。取消将按常规发送任务。",
			"dialog.description.configure": "选择子智能体在此对话中的工作方式。选项从下一个任务开始生效。",
			"task.label": "任务",
			"subagents.title": "子智能体模型",
			"subagents.switch": "为子智能体使用其他模型",
			"subagents.same": "子智能体使用主智能体的模型（{model}）。开启后可选择其他模型。",
			"subagents.same.unknown": "子智能体使用主智能体的模型。开启后可选择其他模型。",
			"subagents.modelLabel": "子智能体模型",
			"subagents.needModel": "请选择一个模型以继续。",
			"subagents.main": "主智能体继续使用 {model}。",
			"reviewer.title": "独立审查员",
			"reviewer.description": "在结果交给主智能体之前，检查每个子智能体的工作。",
			"reviewer.switch": "审查每个子智能体的工作",
			"reviewer.how.1": "在每个子智能体完成后立即开始",
			"reviewer.how.2": "运行或编写测试来验证工作",
			"reviewer.how.3": "只修复确实有问题的地方",
			"reviewer.how.4": "由审查员代替子智能体，把结果交给主智能体",
			"reviewer.modelLabel": "审查员模型",
			"reviewer.sameAsSubagent": "与子智能体相同的模型",
			"reviewer.tip.sameModel": "提示：使用不同模型的审查员，往往能发现与执行工作的模型不同的错误。",
			"remember.label": "在此对话中不再询问",
			"button.cancel": "取消",
			"button.cancelHint": "按常规发送任务",
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
			"command.description": "为此对话选择子智能体模型和独立审查员"
		};
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
		//#region src/client/OrchestratorDialog.tsx
		/**
		* The orchestration dialog, built only from DSH primitives (Modal, Switch,
		* Checkbox, Button, Menu) and DSH tokens so it is indistinguishable from the
		* host's own dialogs in light and dark themes.
		*
		* Two questions, asked once and answered with switches (progressive
		* disclosure: a model picker only appears when its switch is on):
		*  1. Should subagents run on a different model than the main agent?
		*  2. Should an independent reviewer validate each subagent's work, and on
		*     which model?
		*
		* "Cancel" (button, Escape, mask click) never blocks the task: in gate mode it
		* clears any stored choice and lets the task go out exactly as stock DSH.
		* @module dsh-orquestrator/client/OrchestratorDialog
		*/
		/** Window after a menu closed during which Escape/mask must not also close the dialog. */
		const MENU_CLOSE_GUARD_MS = 300;
		/** How long a gate-mode cancel waits for the host to clear the stored choice. */
		const CANCEL_CLEAR_WAIT_MS = 1500;
		/**
		* The dialog.
		* @param props - the request, the catalog state and the translate function.
		* @returns the modal.
		*/
		function OrchestratorDialog({ request, catalog, reloadCatalog, t }) {
			const { initial, mode } = request;
			const uid = (0, react.useId)();
			const [subagentsOn, setSubagentsOn] = (0, react.useState)(initial.subagentModel !== null);
			const [subagentRoute, setSubagentRoute] = (0, react.useState)(initial.subagentModel);
			const [reviewerOn, setReviewerOn] = (0, react.useState)(initial.reviewer.enabled);
			const [reviewerRoute, setReviewerRoute] = (0, react.useState)(initial.reviewer.model);
			const [remember, setRemember] = (0, react.useState)(initial.remember);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
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
			const workerEffective = subagentsOn ? subagentRoute : mainRoute;
			const sameModelReview = reviewerOn && (reviewerRoute === null ? true : workerEffective !== null && routeKey(reviewerRoute ?? workerEffective ?? reviewerRoute) === routeKey(workerEffective));
			const cancel = (0, react.useCallback)(async () => {
				if (busy) return;
				if (mode === "gate") {
					setBusy(true);
					await Promise.race([request.save(null).catch(() => void 0), new Promise((resolve) => {
						setTimeout(resolve, CANCEL_CLEAR_WAIT_MS);
					})]);
				}
				request.resolve({ kind: "cancel" });
			}, [
				busy,
				mode,
				request
			]);
			const onClose = (0, react.useCallback)(() => {
				if (menuOpen.current || Date.now() - menuClosedAt.current < MENU_CLOSE_GUARD_MS) return;
				cancel();
			}, [cancel]);
			const confirm = (0, react.useCallback)(async () => {
				if (busy || needsModel) return;
				const config = buildConfig({
					subagentModel: subagentsOn ? subagentRoute : null,
					reviewerEnabled: reviewerOn,
					reviewerModel: reviewerRoute,
					remember
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
					config
				});
			}, [
				busy,
				needsModel,
				subagentsOn,
				subagentRoute,
				reviewerOn,
				reviewerRoute,
				remember,
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
					onClick: () => {
						cancel();
					},
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
									onChange: setSubagentRoute,
									placeholder: t("picker.placeholder"),
									status: catalog.status,
									loadingLabel: t("picker.loading"),
									errorLabel: t("picker.error"),
									retryLabel: t("picker.retry"),
									onRetry: reloadCatalog,
									disabled: busy,
									onMenuOpenChange
								}) : void 0,
								needsModel && catalog.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-orq-hint",
									role: "status",
									children: t("subagents.needModel")
								}) : void 0
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dsh-orq-section",
							"aria-labelledby": `${uid}-reviewer`,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-orq-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-orq-heading",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
										className: "dsh-orq-title",
										id: `${uid}-reviewer`,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconShieldOutline16, { size: 16 }), t("reviewer.title")]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-orq-hint",
										children: t("reviewer.description")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
									checked: reviewerOn,
									onChange: setReviewerOn,
									label: t("reviewer.switch"),
									disabled: busy
								})]
							}), reviewerOn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
									className: "dsh-orq-steps",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("reviewer.how.1") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("reviewer.how.2") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("reviewer.how.3") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("reviewer.how.4") })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
									id: `${uid}-reviewer-model`,
									label: t("reviewer.modelLabel"),
									groups: catalog.groups,
									value: reviewerRoute,
									onChange: setReviewerRoute,
									inheritLabel: t("reviewer.sameAsSubagent"),
									placeholder: t("picker.placeholder"),
									status: catalog.status,
									loadingLabel: t("picker.loading"),
									errorLabel: t("picker.error"),
									retryLabel: t("picker.retry"),
									onRetry: reloadCatalog,
									disabled: busy,
									onMenuOpenChange
								}),
								sameModelReview ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-orq-hint",
									children: t("reviewer.tip.sameModel")
								}) : void 0
							] }) : void 0]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
							checked: remember,
							onChange: setRemember,
							label: t("remember.label"),
							disabled: busy
						}),
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
.dsh-orq-steps { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0 0 0 16px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
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
.dsh-orq-status-error { color: var(--dsw-alias-state-error-primary); }
.dsh-orq-link { padding: 0; border: 0; background: none; font: inherit; color: var(--dsw-alias-brand-text); text-decoration: underline; cursor: pointer; }
.dsh-orq-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-orq-spin { display: inline-flex; animation: dsh-orq-spin 900ms linear infinite; }
@keyframes dsh-orq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-orq-spin { animation: none; } }
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
		//#endregion
		//#region src/client/index.ts
		/** Required services: the session registry, the slot registry and the locale runtime. */
		const inject = [
			"sessions",
			"slots",
			"locale"
		];
		/** How many times the gate retries attaching to a session binding that is not there yet. */
		const ATTACH_ATTEMPTS = 20;
		/** Delay between attach retries. */
		const ATTACH_DELAY_MS = 250;
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
				warn: (message, error) => {
					console.warn(`dsh-orquestrator: ${message}`, error);
				}
			});
			const host = {
				dialogs,
				locale,
				attachGate(sessionId) {
					let detach;
					let timer;
					let attempts = 0;
					const tryAttach = () => {
						timer = void 0;
						const face = sessions.binding(sessionId)?.session;
						if (face !== void 0) {
							try {
								detach = gate.attach(face);
							} catch (error) {
								console.warn("dsh-orquestrator: could not attach the prompt gate; sends stay stock", error);
							}
							return;
						}
						attempts += 1;
						if (attempts < ATTACH_ATTEMPTS) timer = setTimeout(tryAttach, ATTACH_DELAY_MS);
					};
					tryAttach();
					return () => {
						if (timer !== void 0) clearTimeout(timer);
						detach?.();
					};
				},
				loadCatalog(sessionId) {
					return loadCatalog({
						modelDirectories: () => ctx.get("modelDirectories"),
						remoteSession: () => ctx.get("remote")?.session
					}, sessionId);
				}
			};
			ctx.effect(() => slots.inject("conversation.input.overlay", () => slots.register({
				name: "conversation.input.overlay",
				id: "dsh-orquestrator",
				order: 20,
				inject: () => ({ host })
			}, OrchestratorOverlay)), "dsh-orquestrator: composer overlay");
			ctx.inject(["commandUi"], (scope) => {
				const commandUi = scope.get("commandUi");
				const t = locale.bind(NS);
				scope.effect(() => commandUi.register({
					name: "orquestrar",
					label: () => t("command.label"),
					description: () => t("command.description"),
					icon: _deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16,
					available: (session) => sessions.binding(session.sessionId)?.session.getSnapshot().subagent === null,
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
				await dialogs.request({
					sessionId,
					mode: "configure",
					preview: "",
					initial: stored ?? memory.read() ?? OFF_CONFIG,
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
