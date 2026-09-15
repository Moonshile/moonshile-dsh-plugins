/**
 * dsh-last-turn-delete — host Remote service.
 *
 * Two kinds of "delete the last thing" are supported:
 *
 * 1. Soft-delete the last *user turn* (the shipped mechanism): inside the
 *    agent's serialized idle maintenance phase the service appends one
 *    `user/message` surface replacement that shadows the target user message
 *    and every later surface node (its model responses) up to the log tail.
 *    Durable history is never rewritten — deleted content stops entering
 *    future model context while the original events stay in the log.
 *
 * 2. Soft-delete a *failed `/compact` card*: a manual compaction whose
 *    `command/done` outcome was an error never touched the model surface, so
 *    it is not a compact boundary. It is recorded in this plugin's private
 *    storage-domain sidecar and simply stops showing in the delete chain —
 *    the chain then walks past it to the previous user message.
 *
 * Remote group: `lastTurnDelete`
 *   - `delete({ sessionId, messageId })`  soft-deletes the tail user turn.
 *   - `deleteCompact({ sessionId })`  forgets the newest failed `/compact` card.
 *   - `tail({ sessionId })`  host-authoritative newest deletable item plus the
 *     agent `running` flag
 *     (`{ kind: "message", messageId } | { kind: "compact", commandId } | { kind: null }`, all `+ running`).
 *   - `deleted({ sessionId })`  previously deleted user messages + compact ids.
 *
 * Methods are registered with @deepseek-ai/dsh-typert-protocol `Remote`
 * markers; this file ships as plain ESM, so the marker initializers are
 * applied with the equivalent manual calls against a throwaway instance.
 */
import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { foldSurface } from "@deepseek-ai/dsh-session";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import {
	collectDeletedMessages,
	deletionMarkerMessage,
	findTailDeletionTarget,
	newestDeletable
} from "./core.js";

const GROUP = "lastTurnDelete";
const DOMAIN_NAME = "dsh_last_turn_delete";

/** Sidecar row schema: per-session id, identity-guarded, list of forgotten failed `/compact` command ids. */
const compactRowSchema = z.object({
	session: z.object({
		createdAt: z.number().int().nonnegative(),
		cwd: z.string().optional()
	}),
	compactCommandIds: z.array(z.string())
});
const compactDomainSpec = defineDomain({
	name: DOMAIN_NAME,
	version: 0,
	tables: { sessions: domainTable(compactRowSchema) }
});

/**
 * Mark `name` as a Remote method on the given service class.
 *
 * `Remote` is a TC39 standard method decorator: it registers a class-extra
 * initializer that runs with `this` bound to an *instance* (the compiled
 * `__runInitializers(this, _instanceExtraInitializers)` call happens in the
 * constructor) and then marks `Object.getPrototypeOf(this)` — the class
 * prototype. Plain ESM has no decorator syntax, so emulate exactly that:
 * run the initializer against a throwaway instance.
 */
function markRemoteMethod(serviceClass, name) {
	const receiver = Object.create(serviceClass.prototype);
	Remote(name)(undefined, {
		kind: "method",
		name,
		static: false,
		private: false,
		addInitializer(run) {
			run.call(receiver);
		}
	});
}

function success(value) {
	return Object.freeze({ ok: true, value });
}

function rejected(error) {
	return Object.freeze({
		ok: false,
		error: Object.freeze(error)
	});
}

function failure(code, message, details = {}) {
	return rejected({ code, message, ...details });
}

function identityOf(header) {
	return Object.freeze({
		createdAt: header.createdAt,
		...header.cwd === void 0 ? {} : { cwd: header.cwd }
	});
}

function sameIdentity(row, header) {
	return row.session.createdAt === header.createdAt && row.session.cwd === header.cwd;
}

/** One durable Session lifecycle bound to a storage-domain sidecar row. */
function snapshotRow(header, ids) {
	const copied = [...ids];
	Object.freeze(copied);
	return Object.freeze({
		session: identityOf(header),
		compactCommandIds: copied
	});
}

/**
 * The deletion Remote service. Injected services mirror the
 * dsh-message-feedback consumer pattern (agents / sessions /
 * sessionPersistence) plus the storage-domain sidecar.
 */
class LastTurnDeleteService extends TypertRemoteService {
	static inject = ["agents", "sessions", "sessionPersistence", "storageDomain"];

	table;

	constructor(ctx) {
		super(ctx, GROUP);
	}

	/** Open and own the one compact-forget sidecar domain. */
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(compactDomainSpec);
		this.ctx.effect(() => async () => {
			await domain.close();
		}, `${DOMAIN_NAME}.domainClose`);
		this.table = domain.table("sessions");
	}

	/**
	 * Resolve a session's durable events + identity (live agent first, cold
	 * persistence otherwise). `eventAt`/nodes derive from the same array.
	 * @returns `{ header, events } | null`.
	 */
	async resolveInspection(sessionId) {
		const live = this.ctx.agents.get(sessionId);
		if (live !== void 0) {
			return {
				sessionId,
				header: live.session.header,
				events: live.session.snapshotEvents(),
				nodes: live.session.surface.nodes
			};
		}
		const inspection = await this.ctx.sessionPersistence.inspect(sessionId);
		if (inspection?.events === void 0) return null;
		return {
			sessionId,
			header: inspection.meta,
			events: inspection.events,
			nodes: foldSurface(inspection.events).nodes
		};
	}

	/** Stored (forgotten) failed-compact ids guarded by session identity. */
	storedCompactIds(sessionId, header) {
		const row = this.requireTable().get(sessionId);
		if (row === void 0 || !sameIdentity(row, header)) return [];
		return [...row.compactCommandIds];
	}

	async persistCompactIds(sessionId, header, ids) {
		await this.requireTable().put(sessionId, snapshotRow(header, ids));
	}

	requireTable() {
		if (this.table === void 0) throw new Error("last-turn-delete: sidecar domain is not initialized");
		return this.table;
	}

	/**
	 * Soft-delete the current tail user turn.
	 * The agent must own the session and be idle; the call runs inside
	 * `agent.runMaintenance` so queued waking input parks until the marker is
	 * durably checkpointed.
	 * @param request - session and the client-observed tail message id.
	 * @returns `{ ok: true, value }` or an explicit business failure.
	 */
	async delete(request) {
		const { sessionId, messageId } = request ?? {};
		if (typeof sessionId !== "string" || typeof messageId !== "string") {
			return failure("bad-request", "sessionId and messageId are required");
		}
		const agent = this.ctx.agents.get(sessionId);
		if (agent === void 0) {
			return failure("session-not-found", "no live agent owns this session", { sessionId });
		}
		let task;
		try {
			task = agent.runMaintenance(async () => {
				const session = agent.session;
				const target = findTailDeletionTarget(
					session.surface.nodes,
					(seq) => session.eventAt(seq) ?? null,
					messageId
				);
				if (target.status === "none") {
					return failure("no-target", "no deletable tail user message (compact boundary or empty)", { sessionId });
				}
				if (target.status === "stale") {
					return failure("stale", "the tail user message changed; refresh and retry", {
						sessionId,
						currentMessageId: target.currentMessageId
					});
				}
				const marker = deletionMarkerMessage(randomUUID());
				session.append("user/message", marker, {
					surfaceOp: { op: "replace", startSeq: target.startSeq, endSeq: target.endSeq },
					sourceEventSeqs: target.shadowedSeqs
				});
				await this.ctx.sessions.flush(session);
				return success({
					sessionId,
					messageId: target.messageId,
					startSeq: target.startSeq,
					endSeq: target.endSeq,
					shadowedCount: target.shadowedSeqs.length
				});
			});
		} catch (error) {
			// runMaintenance throws synchronously when another driver or
			// maintenance task owns the agent (busy / mid-stream).
			return failure("busy", "the agent is running; retry once it is idle", { sessionId, cause: error?.message });
		}
		try {
			return await task;
		} catch (error) {
			return failure("internal", "deletion failed", { sessionId, cause: error?.message });
		}
	}

	/**
	 * Forget one failed `/compact` card (the newest deletable item). A failed
	 * compaction never changed the model surface, so nothing is shadowed — the
	 * card is recorded in the sidecar and the delete chain moves past it.
	 * @param request - session whose newest deletable item is a failed card.
	 * @returns `{ ok: true, value: { commandId } }` or a business failure.
	 */
	async deleteCompact(request) {
		const { sessionId } = request ?? {};
		if (typeof sessionId !== "string") return failure("bad-request", "sessionId is required");
		try {
			const inspection = await this.resolveInspection(sessionId);
			if (inspection === null) {
				return failure("session-not-found", "no session or persistence record", { sessionId });
			}
			const { events, nodes, header } = inspection;
			const eventAt = (seq) => events[seq] ?? null;
			const candidate = newestDeletable(events, nodes, eventAt, new Set(this.storedCompactIds(inspection.sessionId, header)));
			if (candidate === null || candidate.kind !== "compact") {
				return failure("no-target", "no deletable failed compaction card", { sessionId });
			}
			const commandId = candidate.commandId;
			await this.persistCompactIds(inspection.sessionId, inspection.header, [
				...this.storedCompactIds(inspection.sessionId, inspection.header),
				commandId
			]);
			return success({ sessionId, commandId });
		} catch (error) {
			return failure("internal", "could not delete the compaction card", { sessionId, cause: error?.message });
		}
	}

	/**
	 * Host-authoritative newest deletable item. Normal tail user message, or a
	 * failed `/compact` card that sits after it (both may be walked through).
	 * @param request - session to inspect.
	 * @returns `{ ok: true, value }` where value is
	 *   `{ kind: "message", messageId } | { kind: "compact", commandId } | { kind: null, messageId: null }`.
	 */
	async tail(request) {
		const { sessionId } = request ?? {};
		if (typeof sessionId !== "string") return failure("bad-request", "sessionId is required");
		try {
			const inspection = await this.resolveInspection(sessionId);
			if (inspection === null) {
				return failure("session-not-found", "no session or persistence record", { sessionId });
			}
			const { events, nodes, header } = inspection;
			const liveAgent = this.ctx.agents.get(sessionId);
			const running = liveAgent !== void 0 && liveAgent.status === "running";
			const candidate = newestDeletable(events, nodes, (seq) => events[seq] ?? null, new Set(this.storedCompactIds(inspection.sessionId, header)));
			if (candidate === null) {
				return success({ kind: null, messageId: null, running });
			}
			if (candidate.kind === "compact") {
				return success({ kind: "compact", commandId: candidate.commandId, running });
			}
			return success({ kind: "message", messageId: candidate.messageId, running });
		} catch (error) {
			return failure("internal", "could not resolve the deletable tail", { sessionId, cause: error?.message });
		}
	}

	/**
	 * List every previously soft-deleted item of a session: user messages
	 * (derived from log markers) and forgotten failed-compact command ids
	 * (sidecar).
	 * @param request - session to inspect.
	 * @returns `{ ok: true, value: { items, compactCommandIds } }`.
	 */
	async deleted(request) {
		const { sessionId } = request ?? {};
		if (typeof sessionId !== "string") return failure("bad-request", "sessionId is required");
		try {
			const inspection = await this.resolveInspection(sessionId);
			if (inspection === null) {
				return failure("session-not-found", "no session or persistence record", { sessionId });
			}
			return success({
				items: collectDeletedMessages(inspection.events),
				compactCommandIds: this.storedCompactIds(inspection.sessionId, inspection.header)
			});
		} catch (error) {
			return failure("internal", "could not list deletions", { sessionId, cause: error?.message });
		}
	}
}

markRemoteMethod(LastTurnDeleteService, "delete");
markRemoteMethod(LastTurnDeleteService, "deleteCompact");
markRemoteMethod(LastTurnDeleteService, "deleted");
markRemoteMethod(LastTurnDeleteService, "tail");

export { LastTurnDeleteService, LastTurnDeleteService as default };
