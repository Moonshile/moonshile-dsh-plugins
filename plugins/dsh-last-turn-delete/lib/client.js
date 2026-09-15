/**
 * dsh-last-turn-delete — browser half.
 *
 * A trash-can button (the same IconTrashOutline16 the pending-message queue
 * uses) sits in the message action strip of the newest deletable item — the
 * last user message, or a failed `/compact` card. The button only appears
 * after the turn has fully finished (the host reports whether the agent is
 * still running), and its resting/hover look is the native action button's
 * (the class is cloned from the neighboring copy button; no custom colors).
 *
 * Clicking opens a small inline-styled confirm bubble (删除 / 取消). On
 * confirm, the host soft-deletes the target — a user message shadows that
 * turn out of the model surface; a failed compaction is recorded in the
 * plugin's sidecar. The button then walks to the previous item, all the way
 * to a real compact boundary or until nothing is left. Soft-deleted spans are
 * dimmed in place; durable logs are never rewritten.
 *
 * Diagnostics: `window.__dshLastTurnDelete.diagnose()`.
 */
window.__ModuleLoader__.load({
	id: "dsh-last-turn-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		// ── shared icon modules (seed words) ───────────────────────────────
		let Primitives = null;
		let createRootHost = null;
		try {
			Primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {}
		try {
			createRootHost = require("react-dom/client").createRoot;
		} catch {}

		// ── identity & copy ────────────────────────────────────────────────
		const NS = "lastTurnDelete";
		const REMOTE_NS = "lastTurnDelete";
		const ROW_DELETED = "data-ltd-deleted";
		const DIAG_VERSION = 3;

		const zh = {
			"delete.title": "删除本条消息及其全部回复",
			"delete.confirmTitle": "删除这条消息及它的全部回复？",
			"delete.confirmNote": "删除后不再进入后续模型上下文（原始日志保留，界面将变暗标记）。",
			"delete.ok": "确认删除",
			"delete.cancel": "取消",
			"delete.busy": "模型正在回复，请等回复结束后再删除",
			"delete.failed": "删除失败，请重试",
			"delete.cardTitle": "删除这条失败的压缩记录？",
			"delete.cardNote": "它没有成功压缩任何内容，也不影响模型上下文；删除后会从这里继续向前。"
		};
		const en = {
			"delete.title": "Delete this message and all its replies",
			"delete.confirmTitle": "Delete this message and all its replies?",
			"delete.confirmNote": "It will stop entering the model context of later requests (original log is kept; this turn will be dimmed).",
			"delete.ok": "Delete",
			"delete.cancel": "Cancel",
			"delete.busy": "The model is still replying — wait for it to finish before deleting",
			"delete.failed": "Deletion failed, please retry",
			"delete.cardTitle": "Delete this failed compaction entry?",
			"delete.cardNote": "It did not compact anything and never entered the model context; deleting lets the chain continue past it."
		};

		// ── slim diagnostics ───────────────────────────────────────────────
		const diag = {
			applied: false,
			applyError: null,
			attaches: 0,
			deletes: 0,
			log: []
		};
		function diagPush(...args) {
			diag.log.push([new Date().toISOString().slice(11, 19), ...args]);
			if (diag.log.length > 40) diag.log.shift();
		}

		// ── DOM helpers over the transcript's stable anchors ───────────────
		function uuidOf(value) {
			const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(String(value ?? ""));
			return match === null ? null : match[0];
		}

		function rowKind(row) {
			return row.getAttribute("data-chat-flow-kind");
		}

		function rowMessageId(row) {
			return uuidOf(row.getAttribute("data-chat-anchor-key"));
		}

		function visibleRows(flow) {
			const rows = [];
			for (const row of flow.querySelectorAll("[data-chat-flow-key]")) {
				if (row.hasAttribute("hidden")) continue;
				rows.push(row);
			}
			return rows;
		}

		/**
		 * Mount the same trash icon the pending-message queue uses
		 * (IconTrashOutline16 from dsh-client-ui-primitives) into `host`, so the
		 * glyph is identical with the queue's delete button. Emergency fallback
		 * only draws a trash bin, never a ✕.
		 */
		function mountTrashIcon(host, fallbackCloneSource) {
			if (Primitives !== null && createRootHost !== null && typeof Primitives.IconTrashOutline16 === "function") {
				const holder = document.createElement("span");
				holder.style.display = "inline-flex";
				holder.style.alignItems = "center";
				host.appendChild(holder);
				const root = createRootHost(holder);
				root.render(react.createElement(Primitives.IconTrashOutline16, { size: 16 }));
				return root;
			}
			const sourceSvg = fallbackCloneSource === null ? null : fallbackCloneSource.querySelector("svg");
			let icon;
			if (sourceSvg !== null) {
				icon = sourceSvg.cloneNode(true);
				while (icon.firstChild !== null) icon.removeChild(icon.firstChild);
			} else {
				icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				icon.setAttribute("width", "16");
				icon.setAttribute("height", "16");
				icon.setAttribute("viewBox", "0 0 16 16");
				icon.setAttribute("fill", "none");
				icon.setAttribute("aria-hidden", "true");
			}
			const stroke = icon.getAttribute("stroke") ?? "currentColor";
			const strokeWidth = icon.getAttribute("stroke-width");
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", "M4 6v6a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 12 12V6M6.5 6v5M9.5 6v5M5.5 4.5h5M8 2.75v1.75");
			path.setAttribute("stroke", stroke);
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			if (strokeWidth !== null) path.setAttribute("stroke-width", strokeWidth);
			if (!icon.hasAttribute("fill")) icon.setAttribute("fill", "none");
			icon.appendChild(path);
			host.appendChild(icon);
			return null;
		}

		/** The copy button of a message row (identified by its localized aria-label). */
		function findCopyButton(row) {
			for (const button of row.querySelectorAll("button")) {
				const label = button.getAttribute("aria-label") ?? "";
				if (/copy|复制/i.test(label)) return button;
			}
			return null;
		}

		/** Button shell that reuses the native action button's class (look & hover). */
		function nativeButtonClone(template) {
			const button = document.createElement("button");
			button.type = "button";
			if (template !== null && typeof template.className === "string") button.className = template.className;
			return button;
		}

		/** Unwrap the host business envelope from an rpc response. */
		function rpcResultOf(raw) {
			// connection.rpc.call resolves { ok, value | error }; our host
			// methods return a business { ok, value | error } envelope as value.
			if (raw === null || typeof raw !== "object") return { ok: false, error: { code: "internal" } };
			if (raw.ok !== true) return raw;
			return raw.value;
		}

		/**
		 * One overlay per open session: dims soft-deleted spans and owns the
		 * single trash button + confirm bubble of the newest deletable item.
		 */
		class Overlay {
			constructor(sessionId, propsRef) {
				this.sessionId = sessionId;
				this.propsRef = propsRef;
				this.deletedIds = new Set();
				this.deletedCompacts = [];
				this.hostTailKind = null; // "message" | "compact" | null
				this.hostTailId = null;
				this.hostRunning = true; // conservative until the first answer
				this.tailFetchedAt = 0;
				this.tailPending = false;
				this.button = null;
				this.buttonHost = null;
				this.popover = null;
				this.glyphRoot = null;
				this.disposed = false;
				this.rafPending = false;
				this.observer = null;
				this.interval = null;
				this.lastSync = null;
				this.lastError = null;
			}

			start() {
				this.observer = new MutationObserver(() => this.schedule());
				this.observer.observe(document.body, { childList: true, subtree: true, attributes: true });
				this.interval = setInterval(() => this.schedule(), 1600);
				this.seedDeleted().catch((error) => this.note(error));
				this.schedule();
			}

			note(error) {
				this.lastError = error instanceof Error ? error.message : String(error);
				diagPush("error", this.sessionId, this.lastError);
			}

			dispose() {
				this.disposed = true;
				if (this.interval !== null) clearInterval(this.interval);
				if (this.observer !== null) this.observer.disconnect();
				this.detachButton();
			}

			/** Seed previously deleted messages / failed-compact cards for dimming. */
			async seedDeleted() {
				const props = this.propsRef.current;
				if (props.deletedList === void 0) return;
				const result = rpcResultOf(await props.deletedList());
				if (result.ok !== true || typeof result.value !== "object" || result.value === null) return;
				if (Array.isArray(result.value.items)) {
					for (const item of result.value.items) {
						if (item !== null && typeof item === "object" && typeof item.messageId === "string") {
							this.deletedIds.add(item.messageId);
						}
					}
				}
				if (Array.isArray(result.value.compactCommandIds)) {
					this.deletedCompacts = result.value.compactCommandIds.filter((id) => typeof id === "string");
				}
				this.refreshTail();
				this.schedule();
			}

			/**
			 * Ask the host which item is the deletable tail and whether the agent
			 * is running. The host folds compaction boundaries, prior deletions
			 * and streaming into this single answer.
			 */
			refreshTail() {
				if (this.disposed || this.tailPending) return;
				if (Date.now() - this.tailFetchedAt < 500) return;
				const props = this.propsRef.current;
				if (props.tail === void 0) return;
				this.tailPending = true;
				const settle = (value) => {
					if (value === null || value.kind === null) {
						this.hostTailKind = null;
						this.hostTailId = null;
					} else if (value.kind === "compact") {
						this.hostTailKind = "compact";
						this.hostTailId = value.commandId ?? null;
					} else {
						this.hostTailKind = "message";
						this.hostTailId = value.messageId ?? null;
					}
					this.hostRunning = value === null || value.running === true;
					this.tailFetchedAt = Date.now();
					this.schedule();
				};
				Promise.resolve(props.tail())
					.then((raw) => {
						const result = rpcResultOf(raw);
						if (result.ok === true) settle(result.value ?? null);
						else this.note(result?.error ?? new Error("tail failed"));
					})
					.catch((error) => this.note(error))
					.finally(() => {
						this.tailPending = false;
					});
			}

			schedule() {
				if (this.disposed || this.rafPending) return;
				this.rafPending = true;
				requestAnimationFrame(() => {
					this.rafPending = false;
					if (this.disposed) return;
					try {
						this.sync();
					} catch (error) {
						this.note(error);
					}
				});
			}

			sync() {
				const flow = document.querySelector("[data-chat-flow]");
				if (flow === null) {
					this.lastSync = { t: Date.now(), flow: false };
					this.detachButton();
					return;
				}
				const rows = visibleRows(flow);
				this.applyDimmed(rows);

				// Local candidates (newest first, skipping soft-deleted rows): a
				// user/steering row and a manual card row. Cards are ordinary rows,
				// never a wall — the host decides what is truly deletable.
				let candidateMsg = null;
				let candidateCard = null;
				for (let index = rows.length - 1; index >= 0; index -= 1) {
					const row = rows[index];
					if (row.hasAttribute(ROW_DELETED)) continue;
					const kind = rowKind(row);
					if (candidateMsg === null && (kind === "user" || kind === "steering")) {
						candidateMsg = { row, kind: "message", messageId: rowMessageId(row) };
					} else if (candidateCard === null && (kind === "manual-compaction" || kind === "command")) {
						candidateCard = { row, kind: "compact" };
					}
					if (candidateMsg !== null && candidateCard !== null) break;
				}

				// Keep the host answer fresh: while running, before the first
				// answer, or when the cached id went stale we re-ask (throttled).
				const stale = Date.now() - this.tailFetchedAt > 1500;
				if (this.hostTailId === null || this.hostRunning || stale) this.refreshTail();

				let target = null;
				if (this.hostRunning) {
					target = null; // replying — keep hidden until the turn fully ends
				} else if (this.hostTailKind === "message"
					&& candidateMsg !== null
					&& candidateMsg.messageId !== null
					&& candidateMsg.messageId === this.hostTailId) {
					target = candidateMsg;
				} else if (this.hostTailKind === "compact" && candidateCard !== null && !stale) {
					target = candidateCard;
				}

				this.lastSync = {
					t: Date.now(),
					flow: true,
					rows: rows.length,
					deletedCount: this.deletedIds.size,
					deletedCards: this.deletedCompacts.length,
					candidateMsgId: candidateMsg === null ? null : candidateMsg.messageId,
					hostTailKind: this.hostTailKind,
					hostTailId: this.hostTailId,
					hostRunning: this.hostRunning,
					targetKind: target === null ? null : target.kind
				};

				if (target === null) {
					this.detachButton();
					return;
				}
				this.attachButton(target);
			}

			/** Dim deleted user turns and forgotten failed-compact cards in place. */
			applyDimmed(rows) {
				let dimmed = false;
				for (const row of rows) {
					const kind = rowKind(row);
					if (kind === "user" || kind === "steering") {
						const id = rowMessageId(row);
						dimmed = id !== null && this.deletedIds.has(id);
					} else if (kind === "compaction" || kind === "manual-compaction") {
						dimmed = false;
					}
					row.style.opacity = dimmed ? "0.38" : "";
					if (dimmed) row.setAttribute(ROW_DELETED, "");
					else row.removeAttribute(ROW_DELETED);
				}
				// Forgotten failed-compact cards are deleted newest-first, so the
				// newest N card rows correspond to the stored command ids.
				if (this.deletedCompacts.length > 0) {
					const cardRows = rows.filter((row) => {
						const kind = rowKind(row);
						return kind === "manual-compaction" || kind === "command";
					});
					const mark = Math.min(this.deletedCompacts.length, cardRows.length);
					for (let index = cardRows.length - mark; index < cardRows.length; index += 1) {
						cardRows[index].style.opacity = "0.38";
						cardRows[index].setAttribute(ROW_DELETED, "");
					}
				}
			}

			closeConfirm() {
				if (this.popover === null) return;
				const cleanup = this.popover.__ltdCleanup;
				if (typeof cleanup === "function") cleanup();
				if (this.popover.parentElement !== null) this.popover.parentElement.removeChild(this.popover);
				this.popover = null;
			}

			detachButton() {
				this.closeConfirm();
				if (this.glyphRoot !== null) {
					try {
						this.glyphRoot.unmount();
					} catch {}
					this.glyphRoot = null;
				}
				if (this.button !== null && this.button.parentElement !== null) {
					this.button.parentElement.removeChild(this.button);
				}
				this.button = null;
				this.buttonHost = null;
			}

			attachButton(target) {
				if (this.buttonHost === target.row && this.button !== null) return;
				this.detachButton();
				const props = this.propsRef.current;
				const t = props.t ?? ((key) => zh[key] ?? key);
				const row = target.row;
				const copy = findCopyButton(row);
				const strip = copy === null ? null : copy.parentElement;

				const button = nativeButtonClone(copy);
				this.glyphRoot = mountTrashIcon(button, copy);
				button.type = "button";
				button.setAttribute("aria-label", t(target.kind === "compact" ? "delete.cardTitle" : "delete.title"));
				button.title = t(target.kind === "compact" ? "delete.cardTitle" : "delete.title");
				button.addEventListener("click", () => {
					if (this.disposed) return;
					this.openConfirm(target, button, t);
				});

				if (strip !== null && copy !== null) {
					strip.insertBefore(button, copy.nextSibling); // join the native action strip
				} else {
					// Rare fallback: a row without the native action strip.
					row.style.position = "relative";
					Object.assign(button.style, {
						position: "absolute", right: "8px", bottom: "8px", zIndex: "6",
						display: "inline-flex", alignItems: "center", justifyContent: "center",
						width: "22px", height: "22px", padding: "0", border: "0", borderRadius: "6px",
						background: "transparent", color: "inherit", cursor: "pointer"
					});
					row.appendChild(button);
				}
				this.button = button;
				this.buttonHost = row;
				diag.attaches += 1;
				diagPush("attach", this.sessionId, target.kind, target.messageId ?? null);
			}

			/**
			 * Open the confirm bubble anchored to the trash button. All styles are
			 * inline on the created nodes — injected <style> blocks are managed
			 * (and dropped) by the host module system, so they cannot be relied on.
			 */
			openConfirm(target, anchor, t) {
				this.closeConfirm();
				const card = target.kind === "compact";
				const title = t(card ? "delete.cardTitle" : "delete.confirmTitle");
				const note = t(card ? "delete.cardNote" : "delete.confirmNote");

				const popover = document.createElement("div");
				popover.setAttribute("role", "dialog");
				popover.setAttribute("aria-label", title);
				Object.assign(popover.style, {
					position: "fixed", zIndex: "9999", width: "260px", padding: "12px",
					borderRadius: "10px", background: "#202429", color: "#e8eaed",
					border: "1px solid rgba(128,134,144,0.4)",
					boxShadow: "0 8px 28px rgba(0,0,0,0.45)", fontSize: "13px", lineHeight: "1.5"
				});
				const titleEl = document.createElement("p");
				titleEl.textContent = title;
				Object.assign(titleEl.style, { margin: "0 0 8px", fontWeight: "600" });
				const noteEl = document.createElement("p");
				noteEl.textContent = note;
				Object.assign(noteEl.style, { margin: "0 0 12px", opacity: "0.75", fontSize: "12px" });
				const errorEl = document.createElement("p");
				errorEl.setAttribute("role", "status");
				Object.assign(errorEl.style, { margin: "0 0 8px", color: "#ff8a80", display: "none" });
				const buttons = document.createElement("div");
				Object.assign(buttons.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
				const cancel = document.createElement("button");
				cancel.type = "button";
				cancel.textContent = t("delete.cancel");
				Object.assign(cancel.style, {
					border: "0", borderRadius: "8px", padding: "6px 14px", fontSize: "13px",
					cursor: "pointer", background: "rgba(128,134,144,0.22)", color: "inherit"
				});
				const ok = document.createElement("button");
				ok.type = "button";
				ok.textContent = t("delete.ok");
				Object.assign(ok.style, {
					border: "0", borderRadius: "8px", padding: "6px 14px", fontSize: "13px",
					cursor: "pointer", background: "#c93838", color: "#fff"
				});
				const setError = (message) => {
					if (message === null) errorEl.style.display = "none";
					else {
						errorEl.textContent = message;
						errorEl.style.display = "block";
					}
				};
				const resetOk = () => {
					ok.disabled = false;
					ok.style.opacity = "";
				};
				cancel.addEventListener("click", () => this.closeConfirm());
				ok.addEventListener("click", () => {
					ok.disabled = true;
					ok.style.opacity = "0.5";
					this.executeDelete(target, resetOk, t, setError).catch((error) => {
						this.note(error);
						resetOk();
						setError(`${t("delete.failed")} (${error instanceof Error ? error.message : String(error)})`);
					});
				});
				buttons.append(cancel, ok);
				popover.append(titleEl, noteEl, errorEl, buttons);
				document.body.appendChild(popover);
				this.popover = popover;

				const place = () => {
					const rect = anchor.getBoundingClientRect();
					popover.style.visibility = "hidden";
					const width = popover.offsetWidth;
					const height = popover.offsetHeight;
					const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
					let top = rect.bottom + 6;
					if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
					popover.style.left = `${Math.round(left)}px`;
					popover.style.top = `${Math.round(top)}px`;
					popover.style.visibility = "";
				};
				place();

				const onPointerDown = (event) => {
					if (this.popover !== popover) return;
					if (popover.contains(event.target)) return;
					this.closeConfirm();
				};
				const onKey = (event) => {
					if (this.popover !== popover) return;
					if (event.key === "Escape") this.closeConfirm();
				};
				const onScroll = () => this.closeConfirm();
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKey, true);
				window.addEventListener("scroll", onScroll, true);
				window.addEventListener("resize", place);
				popover.__ltdCleanup = () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKey, true);
					window.removeEventListener("scroll", onScroll, true);
					window.removeEventListener("resize", place);
				};
			}

			async executeDelete(target, resetOk, t, setError) {
				if (this.disposed) return;
				const props = this.propsRef.current;
				const card = target.kind === "compact";
				if (card && props.deleteCompact === void 0) return;
				if (!card && (props.deleteTurn === void 0 || props.sessionId !== this.sessionId)) return;

				const result = rpcResultOf(card
					? await props.deleteCompact()
					: await props.deleteTurn(target.messageId));
				diag.deletes += 1;
				diagPush("delete", this.sessionId, card ? "compact" : "message",
					result.ok === true ? "ok" : (result?.error?.code ?? "error"),
					result.ok === true ? "" : String(result?.error?.cause ?? result?.error?.message ?? ""));

				if (result.ok === true) {
					if (card) {
						const commandId = result.value?.commandId;
						if (typeof commandId === "string" && !this.deletedCompacts.includes(commandId)) {
							this.deletedCompacts = [...this.deletedCompacts, commandId];
						}
					} else {
						this.deletedIds.add(target.messageId);
					}
					this.closeConfirm();
					this.hostTailId = null;
					this.tailFetchedAt = 0;
					this.refreshTail();
					this.schedule();
					return;
				}

				const code = result.error?.code;
				if (code === "stale" || code === "no-target") {
					// The tail moved or is already gone: resync and re-anchor.
					this.closeConfirm();
					this.hostTailId = null;
					this.tailFetchedAt = 0;
					await this.seedDeleted();
					this.refreshTail();
					this.schedule();
					return;
				}
				resetOk();
				if (code === "busy") setError(t("delete.busy"));
				else {
					const cause = result.error?.cause;
					setError([
						t("delete.failed"),
						code === void 0 ? "" : `（${code}）`,
						result.error?.message === void 0 ? "" : `: ${result.error.message}`,
						cause === void 0 ? "" : ` — ${String(cause)}`
					].join(""));
				}
			}
		}

		// ── one overlay per session, refcounted by mounted action entries ─────
		const managers = new Map();

		function registerManager(sessionId, propsRef) {
			let record = managers.get(sessionId);
			if (record === void 0) {
				const overlay = new Overlay(sessionId, propsRef);
				record = { overlay, refs: 0 };
				managers.set(sessionId, record);
				overlay.start();
			} else {
				record.overlay.propsRef = propsRef;
			}
			record.refs += 1;
			return () => {
				record.refs -= 1;
				if (record.refs > 0) return;
				managers.delete(sessionId);
				record.overlay.dispose();
			};
		}

		/**
		 * Session anchor: hosted on every completed turn's assistant action row
		 * (same slot the shipped Like/Dislike uses). Renders nothing itself; its
		 * lifecycle drives the singleton overlay for the session.
		 */
		function LastTurnDeleteCue(props) {
			const sessionId = props.sessionId;
			const propsRef = react.useRef(props);
			propsRef.current = props;
			react.useEffect(() => {
				if (typeof sessionId !== "string") return void 0;
				return registerManager(sessionId, propsRef);
			}, [sessionId]);
			return null;
		}

		// ── client plugin body ──────────────────────────────────────────────
		/** Client services this plugin needs. */
		const inject = ["slots", "locale", "connection"];

		function apply(ctx) {
			diag.applied = true;
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-last-turn-delete: dictionaries");
				ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "last-turn-delete",
					order: 130,
					locale: NS,
					inject: (sessionId) => ({
						sessionId,
						deleteTurn: async (messageId) => ctx.connection.rpc.call("/api", `${REMOTE_NS}/delete`, {
							args: { request: { sessionId, messageId } }
						}),
						deleteCompact: async () => ctx.connection.rpc.call("/api", `${REMOTE_NS}/deleteCompact`, {
							args: { request: { sessionId } }
						}),
						deletedList: async () => ctx.connection.rpc.call("/api", `${REMOTE_NS}/deleted`, {
							args: { request: { sessionId } }
						}),
						tail: async () => ctx.connection.rpc.call("/api", `${REMOTE_NS}/tail`, {
							args: { request: { sessionId } }
						})
					})
				}, LastTurnDeleteCue));
			} catch (error) {
				diag.applyError = error instanceof Error ? error.message : String(error);
				diagPush("apply error", diag.applyError);
				throw error;
			}

			try {
				globalThis.__dshLastTurnDelete = {
					version: DIAG_VERSION,
					diag,
					refresh: () => {
						for (const record of managers.values()) record.overlay.schedule();
					},
					diagnose: () => ({
						applied: diag.applied,
						applyError: diag.applyError,
						attaches: diag.attaches,
						deletes: diag.deletes,
						overlays: [...managers.values()].map((record) => ({
							sessionId: record.overlay.sessionId,
							deletedCount: record.overlay.deletedIds.size,
							deletedCards: record.overlay.deletedCompacts.length,
							lastError: record.overlay.lastError,
							lastSync: record.overlay.lastSync
						})),
						flowPresent: document.querySelector("[data-chat-flow]") !== null,
						logTail: diag.log.slice(-30)
					})
				};
			} catch {
				// diagnostics are best-effort
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
