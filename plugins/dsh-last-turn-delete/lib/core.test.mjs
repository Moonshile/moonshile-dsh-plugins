import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PKG_NAME,
	deletionMarkerMessage,
	deletionMarkerSource,
	isDeleteMarker,
	findTailDeletionTarget,
	collectDeletedMessages,
	currentTailUserMessage,
	collectFailedCompactionGroups,
	newestDeletable
} from "./core.js";

/** Minimal durable user message event. */
function userMessage(seq, id, { sourceKind = "user", source } = {}) {
	return {
		type: "user/message",
		seq,
		time: 0,
		data: {
			role: "user",
			id,
			content: [{ type: "text", text: `msg ${id}` }],
			source: source ?? { kind: sourceKind }
		},
		surfaceOp: "append"
	};
}

function assistantMessage(seq, turn = 1, step = 1) {
	return {
		type: "assistant/message",
		seq,
		time: 0,
		data: {
			turn,
			step,
			message: { role: "assistant", content: [{ type: "text", text: `reply ${seq}` }] }
		},
		surfaceOp: "append"
	};
}

/** One deletion marker replacement event (as appended by this plugin). */
function deletionMarker(seq, startSeq, endSeq, shadowedSeqs) {
	return {
		type: "user/message",
		seq,
		time: 0,
		data: deletionMarkerMessage(`marker-${seq}`),
		surfaceOp: { op: "replace", start: startSeq, end: endSeq },
		sourceEventSeqs: [...shadowedSeqs]
	};
}

/** Wrap one marker message payload as the durable replacement event. */
function eventFor(marker) {
	return {
		type: "user/message",
		seq: 4,
		time: 0,
		data: marker,
		surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
		sourceEventSeqs: [0, 1]
	};
}

const EVENT_AT = (events) => (seq) => events[seq];

test("findTailDeletionTarget: no surface nodes -> none", () => {
	const result = findTailDeletionTarget([], EVENT_AT([]), "u1");
	assert.equal(result.status, "none");
});

test("findTailDeletionTarget: picks the last user message and shadows to the surface end", () => {
	const events = [
		userMessage(0, "u1"),
		assistantMessage(1, 1, 1),
		userMessage(2, "u2"),
		assistantMessage(3, 2, 1)
	];
	const nodes = [0, 1, 2, 3];
	const result = findTailDeletionTarget(nodes, EVENT_AT(events), "u2");
	assert.equal(result.status, "ok");
	assert.equal(result.messageId, "u2");
	assert.equal(result.startSeq, 2);
	assert.equal(result.endSeq, 3);
	assert.deepEqual(result.shadowedSeqs, [2, 3]);
});

test("findTailDeletionTarget: ignores injected context and previous markers (boundary semantics)", () => {
	// u1 is a genuine user message, then a compaction checkpoint (source not
	// 'user'), then u2 — only u2 is a deletable tail candidate.
	const events = [
		userMessage(0, "u1"),
		assistantMessage(1, 1, 1),
		userMessage(2, "checkpoint-1", { sourceKind: "plugin" }),
		userMessage(3, "u2"),
		assistantMessage(4, 2, 1)
	];
	const result = findTailDeletionTarget([0, 2, 3, 4], EVENT_AT(events), "u2");
	assert.equal(result.status, "ok");
	assert.equal(result.startSeq, 3);
	assert.equal(result.endSeq, 4);
});

test("findTailDeletionTarget: stale request returns the current tail id", () => {
	const events = [userMessage(0, "u1"), assistantMessage(1, 1, 1), userMessage(2, "u2")];
	const result = findTailDeletionTarget([0, 1, 2], EVENT_AT(events), "u1");
	assert.equal(result.status, "stale");
	assert.equal(result.currentMessageId, "u2");
});

test("collectDeletedMessages: returns the deleted user message of every marker", () => {
	const events = [
		userMessage(0, "u1"),
		assistantMessage(1, 1, 1),
		userMessage(2, "u2"),
		assistantMessage(3, 2, 1),
		// delete u2 (turn 2): shadows surface nodes 2..3
		deletionMarker(4, 2, 3, [2, 3]),
		// delete u1 next: shadows surface nodes 0..1 plus the marker 4
		deletionMarker(5, 0, 4, [0, 1, 4])
	];
	const deleted = collectDeletedMessages(events);
	assert.deepEqual(deleted.map((item) => item.messageId), ["u1", "u2"]);
	assert.deepEqual(deleted.map((item) => item.seq), [0, 2]);
});

test("collectDeletedMessages: ignores compaction checkpoints (different source)", () => {
	const checkpoint = {
		type: "user/message",
		seq: 3,
		time: 0,
		data: {
			role: "user",
			id: "compact-ckpt",
			content: [{ type: "text", text: "<compacted-summary>…" }],
			source: { kind: "plugin", plugin: "compact" }
		},
		surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
		sourceEventSeqs: [0, 1]
	};
	const events = [userMessage(0, "u1"), assistantMessage(1, 1, 1), checkpoint];
	assert.deepEqual(collectDeletedMessages(events), []);
});

test("isDeleteMarker / marker message identity round-trip", () => {
	const marker = deletionMarkerMessage("m1");
	assert.equal(marker.role, "user");
	// The format-mandated plugin source shape: the package name is the identity,
	// and nothing else may ride along (an off-schema source makes the Session
	// format migration chain refuse the whole log).
	assert.deepEqual(marker.source, { kind: "plugin", plugin: PKG_NAME });
	assert.deepEqual(deletionMarkerSource(), { kind: "plugin", plugin: PKG_NAME });
	assert.equal(isDeleteMarker(eventFor(marker)), true);
	assert.equal(isDeleteMarker({ type: "user/message", surfaceOp: "append", data: userMessage(0, "u1").data }), false);
	assert.equal(isDeleteMarker({ type: "compaction/summary", surfaceOp: { op: "replace", start: 0, end: 0 }, data: {} }), false);
});

test("isDeleteMarker: recognizes the legacy (format-invalid) marker shape", () => {
	// Historic logs written before the identity fix carry `name`/`operation`
	// instead of `plugin`. Reading them must keep working.
	const legacy = {
		type: "user/message",
		seq: 7,
		time: 0,
		data: {
			role: "user",
			id: "legacy-marker",
			content: [{ type: "text", text: "deleted" }],
			source: { kind: "plugin", name: PKG_NAME, operation: "delete" }
		},
		surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
		sourceEventSeqs: [0, 1]
	};
	assert.equal(isDeleteMarker(legacy), true);
	// A legacy marker must still be recognized as a deleted-message source.
	const events = [userMessage(0, "u1"), assistantMessage(1, 1, 1), legacy];
	assert.deepEqual(collectDeletedMessages(events), [{ messageId: "u1", seq: 0 }]);
	// Other plugins' legacy-shaped sources are not this plugin's markers.
	assert.equal(isDeleteMarker({
		...legacy,
		data: { ...legacy.data, source: { kind: "plugin", name: "some-other-plugin", operation: "delete" } }
	}), false);
});

test("currentTailUserMessage: last genuine user message on the surface", () => {
	const events = [
		userMessage(0, "u1"),
		assistantMessage(1, 1, 1),
		userMessage(2, "u2"),
		assistantMessage(3, 2, 1)
	];
	assert.deepEqual(currentTailUserMessage([0, 1, 2, 3], EVENT_AT(events)), { messageId: "u2", seq: 2 });
});

test("currentTailUserMessage: ignores injected context / markers", () => {
	const events = [
		userMessage(0, "u1"),
		userMessage(1, "ckpt", { sourceKind: "plugin" })
	];
	assert.deepEqual(currentTailUserMessage([0, 1], EVENT_AT(events)), { messageId: "u1", seq: 0 });
});

test("currentTailUserMessage: none when empty or all pre-boundary", () => {
	assert.equal(currentTailUserMessage([], EVENT_AT([])), null);
	const events = [userMessage(0, "u1", { sourceKind: "plugin" })];
	assert.equal(currentTailUserMessage([0], EVENT_AT(events)), null);
});

const commandRun = (seq, commandId) => ({ type: "command/run", seq, time: 0, data: { commandId, name: "compact", args: "", source: { kind: "user" } } });
const commandDone = (seq, commandId, kind) => ({ type: "command/done", seq, time: 0, data: { commandId, kind, text: "x" } });
const compactionEndErr = (seq, commandId) => ({ type: "compaction/end", seq, time: 0, data: { compactionId: "c-" + commandId, sourceCommandId: commandId, error: "boom" } });

test("collectFailedCompactionGroups: detects failed /compact groups only", () => {
	const events = [
		commandRun(0, "ok-1"), commandDone(1, "ok-1", "success"),
		commandRun(2, "bad-1"), compactionEndErr(3, "bad-1"), commandDone(4, "bad-1", "error"),
		userMessage(5, "u2")
	];
	const groups = collectFailedCompactionGroups(events);
	assert.deepEqual(groups.map((g) => g.commandId), ["bad-1"]);
});

test("newestDeletable: failed compact after the last user message wins (crossable card)", () => {
	const events = [
		userMessage(0, "u1"),
		assistantMessage(1, 1, 1),
		commandRun(2, "bad-1"), compactionEndErr(3, "bad-1"), commandDone(4, "bad-1", "error")
	];
	const nodes = [0, 1];
	const target = newestDeletable(events, nodes, (s) => events[s] ?? null, new Set());
	assert.deepEqual(target, { kind: "compact", commandId: "bad-1", seq: 2 });
});

test("newestDeletable: deleted failed compact yields the older user message", () => {
	const events = [
		userMessage(0, "u1"),
		assistantMessage(1, 1, 1),
		commandRun(2, "bad-1"), compactionEndErr(3, "bad-1"), commandDone(4, "bad-1", "error")
	];
	const nodes = [0, 1];
	const target = newestDeletable(events, nodes, (s) => events[s] ?? null, new Set(["bad-1"]));
	assert.deepEqual(target, { kind: "message", messageId: "u1", seq: 0 });
});

test("newestDeletable: real user message newer than a failed compact wins", () => {
	const events = [
		userMessage(0, "u1"),
		commandRun(1, "bad-1"), compactionEndErr(2, "bad-1"), commandDone(3, "bad-1", "error"),
		userMessage(4, "u2"), assistantMessage(5, 2, 1)
	];
	const nodes = [0, 4, 5];
	const target = newestDeletable(events, nodes, (s) => events[s] ?? null, new Set());
	assert.deepEqual(target, { kind: "message", messageId: "u2", seq: 4 });
});

test("newestDeletable: none when no user message and no failed compact", () => {
	const events = [assistantMessage(0, 1, 1)];
	assert.equal(newestDeletable(events, [0], (s) => events[s] ?? null, new Set()), null);
});
