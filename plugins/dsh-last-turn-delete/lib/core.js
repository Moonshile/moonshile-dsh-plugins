/**
 * dsh-last-turn-delete — host-side pure logic (no DSH runtime imports).
 *
 * Everything here is a plain function over the durable Session event log so
 * it can be unit-tested without a DSH host:
 *
 * - {@link isDeleteMarker}  recognizes the marker user/message this plugin
 *   appends as a surface replacement when a turn is deleted.
 * - {@link findTailDeletionTarget} computes the *current* deletable tail:
 *   the last on-surface `user/message` whose `source.kind === 'user'`.
 * - {@link collectDeletedMessages} re-derives every deleted user message id
 *   from the log (each marker replacement's shadowed span contains exactly
 *   one genuine user message — the one the deletion removed).
 * - {@link collectFailedCompactionGroups} / {@link newestDeletable} decide the
 *   host-authoritative deletable tail: the last on-surface user message, or a
 *   failed `/compact` card that sits after it (failed compactions are not
 *   boundaries and may be deleted themselves).
 *
 * Deleting works on the *model-visible surface* (compaction's mechanism), so
 * durable history is never rewritten: the user message and all its model
 * responses stop being folded into future model context, while the original
 * events stay in the log untouched (soft delete; nothing is lost).
 */

/**
 * Package name — also the plugin identity stored on every deletion marker
 * (`source.plugin`).
 */
export const PKG_NAME = "dsh-last-turn-delete";

/**
 * The marker user/message's source identity. The chat transcript folds only
 * append-surface user messages, so this replacement never renders a row; it
 * only occupies the surface slot where the deleted turn used to be.
 *
 * The shape is the format-mandated plugin message source
 * (`{ kind: "plugin", plugin: <package name> }`, see
 * `@deepseek-ai/dsh-llm`'s `MessageSourceMap` and the released Session format
 * validators): the Session log is durable history read back through the
 * versioned format migration chain, and an off-schema source makes that chain
 * refuse the whole Session. Invented members such as `name`/`operation` are
 * therefore not free-form — the package name is the only identity a marker may
 * carry.
 */
export function deletionMarkerSource() {
	return {
		kind: "plugin",
		plugin: PKG_NAME
	};
}

/**
 * Whether an event is one of this plugin's deletion markers: a
 * `user/message` surface replacement carrying the plugin's source identity.
 *
 * {@link deletionMarkerSource} is the only shape this plugin writes, but the
 * `plugin` member only landed with the corrected identity: the first release
 * wrote `{ kind: "plugin", name, operation }`, which the format validator
 * rejects. Historical logs may still contain that shape until they are
 * repaired, so recognize both — reading old markers must never depend on a
 * migration having been run.
 * @param event - one durable Session event.
 * @returns true for marker replacements appended by this plugin, either shape.
 */
export function isDeleteMarker(event) {
	if (event === null || typeof event !== "object") return false;
	if (event.type !== "user/message") return false;
	const op = event.surfaceOp;
	if (op === null || typeof op !== "object" || op.op !== "replace") return false;
	const source = event.data?.source;
	if (source === null || typeof source !== "object") return false;
	if (source.kind !== "plugin") return false;
	if (source.plugin === PKG_NAME) return true;
	return source.name === PKG_NAME && source.operation === "delete";
}

/**
 * Locate the current deletable tail turn inside a session surface.
 *
 * The surface node list is the model-visible conversation in order
 * (compaction already removed pre-boundary history from it, so "the last
 * user message on the surface" is by construction *after* the newest compact
 * boundary — deletion stops exactly at the boundary).
 *
 * @param nodes - current surface node seqs, in model-visible order
 *   (`session.surface.nodes`).
 * @param eventAt - maps a seq back to its durable event.
 * @param requestedMessageId - the message id the client believes is the
 *   deletable tail; used to reject a stale click.
 * @returns
 * - `{ status: "ok", messageId, startSeq, endSeq, shadowedSeqs }` when the
 *   requested message is the current tail user message;
 * - `{ status: "stale", currentMessageId }` when the tail user message moved
 *   (its id differs from the request);
 * - `{ status: "none" }` when there is no deletable tail user message (all
 *   content is before the compact boundary, or the log has none).
 */
export function findTailDeletionTarget(nodes, eventAt, requestedMessageId) {
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const seq = nodes[index];
		const event = eventAt(seq);
		if (event === null || typeof event !== "object") continue;
		if (event.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.kind !== "user") continue; // injected context / marker nodes
		if (requestedMessageId !== event.data?.id) {
			return {
				status: "stale",
				currentMessageId: event.data?.id ?? null
			};
		}
		const shadowedSeqs = nodes.slice(index);
		return {
			status: "ok",
			messageId: event.data.id,
			startSeq: nodes[index],
			endSeq: shadowedSeqs[shadowedSeqs.length - 1],
			shadowedSeqs
		};
	}
	return { status: "none" };
}

/**
 * Re-derive every deleted user message from a full durable event log.
 *
 * Each deletion marker replacement shadows one span; the span contains
 * exactly one genuine (`source.kind === "user"`) `user/message` — the deleted
 * prompt. Later deletions shadow later tails that may already include
 * earlier markers, so each marker still yields its own deleted message.
 * @param events - durable events in seq order.
 * @returns deleted user messages sorted by seq: `{ messageId, seq }`.
 */
export function collectDeletedMessages(events) {
	const found = [];
	if (!Array.isArray(events)) return found;
	for (const event of events) {
		if (!isDeleteMarker(event)) continue;
		const shadowed = event.sourceEventSeqs;
		if (!Array.isArray(shadowed)) continue;
		for (const seq of shadowed) {
			const inner = events[seq];
			if (inner === null || typeof inner !== "object") continue;
			if (inner.type !== "user/message") continue;
			const source = inner.data?.source;
			if (source?.kind !== "user") continue;
			found.push({
				messageId: inner.data.id,
				seq: inner.seq
			});
			break; // one genuine user message per deleted span
		}
	}
	found.sort((left, right) => left.seq - right.seq);
	return found;
}

/**
 * Build the marker `user/message` that replaces a deleted turn on the
 * surface. Its content is a short note (the fold derives the replacement
 * into the model surface; durable payloads are never removed).
 * @param messageId - new message id for the marker.
 * @param text - optional marker text; defaults to a bilingual note.
 * @returns the marker message payload.
 */
export function deletionMarkerMessage(messageId, text) {
	return {
		role: "user",
		id: messageId,
		content: [{
			type: "text",
			text: text ?? "（本条消息及其全部回复已被用户删除，请忽略 / This message and all its replies were deleted by the user — please ignore）"
		}],
		source: deletionMarkerSource()
	};
}

/**
 * The current deletable tail: the last on-surface genuine user message, or
 * null when none exists (no user message, or everything is before the newest
 * compact boundary / already soft-deleted). Host-authoritative answer to
 * "where should the delete button sit".
 * @param nodes - current surface node seqs in model-visible order.
 * @param eventAt - maps a seq back to its durable event.
 * @returns `{ messageId, seq } | null`.
 */
export function currentTailUserMessage(nodes, eventAt) {
	if (!Array.isArray(nodes)) return null;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const event = eventAt(nodes[index]);
		if (event === null || typeof event !== "object") continue;
		if (event.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.kind !== "user") continue;
		return {
			messageId: event.data?.id ?? null,
			seq: nodes[index]
		};
	}
	return null;
}

/**
 * A manual compaction group failed when the user's `/compact` command did not
 * land a summary: its `command/done` outcome is an error (the engine may have
 * appended a `compaction/start`/`compaction/end` error pair and no
 * `compaction/summary`). Failed compactions never touched the surface, so they
 * are not a compact boundary — the history below them stays deletable.
 * @param events - durable events in seq order.
 * @returns failed groups as `{ commandId, runSeq }[]` in seq order.
 */
export function collectFailedCompactionGroups(events) {
	const groups = [];
	if (!Array.isArray(events)) return groups;
	const runsByCommand = new Map(); // commandId -> run seq
	const done = new Map(); // commandId -> { kind, doneSeq }
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (event === null || typeof event !== "object") continue;
		if (event.type === "command/run") {
			const commandId = event.data?.commandId;
			if (typeof commandId === "string" && event.data?.name === "compact") {
				runsByCommand.set(commandId, index);
			}
		} else if (event.type === "command/done") {
			const commandId = event.data?.commandId;
			if (typeof commandId === "string") {
				done.set(commandId, event.data?.kind ?? "success");
			}
		}
	}
	// A `/compact` whose command ended in error (possibly with an aborted
	// compaction/start…end pair and no compaction/summary) is a failed group;
	// a command that completed successfully never produces an error outcome.
	for (const [commandId, runSeq] of runsByCommand) {
		if (done.get(commandId) !== "error") continue;
		groups.push({ commandId, runSeq });
	}
	groups.sort((left, right) => left.runSeq - right.runSeq);
	return groups;
}

/**
 * The newest deletable item of a session: either the last on-surface genuine
 * user message (a normal turn), or — when a failed `/compact` group is the
 * newest content — that failed-compaction card itself. Successful compaction
 * boundaries are never returned here; the surface already dropped everything
 * before them.
 * @param events - durable events in seq order (for failed-group discovery).
 * @param nodes - current surface node seqs (model-visible user/assistant/tool).
 * @param eventAt - maps a seq to its durable event.
 * @param deletedCompactIds - previously soft-deleted failed `/compact` command ids.
 * @returns `{ kind: "message", messageId, seq } | { kind: "compact", commandId, seq } | null`.
 */
export function newestDeletable(events, nodes, eventAt, deletedCompactIds = new Set()) {
	const messageTail = currentTailUserMessage(nodes, eventAt);
	const userSeq = messageTail === null ? -1 : messageTail.seq;
	const groups = collectFailedCompactionGroups(events).filter((group) => !deletedCompactIds.has(group.commandId));
	const newestGroup = groups.length === 0 ? null : groups[groups.length - 1];
	if (newestGroup === null || newestGroup.runSeq < userSeq) {
		return messageTail === null ? null : {
			kind: "message",
			messageId: messageTail.messageId,
			seq: messageTail.seq
		};
	}
	return {
		kind: "compact",
		commandId: newestGroup.commandId,
		seq: newestGroup.runSeq
	};
}
