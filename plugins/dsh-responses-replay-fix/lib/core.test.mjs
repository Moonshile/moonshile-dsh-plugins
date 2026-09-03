import { test } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeMessageId,
	normalizeTextSignature,
	normalizeThinkingSignature,
	normalizeAssistantMessage,
	normalizeMessages,
	resolveProviders
} from "./core.js";

test("resolveProviders: undefined section falls back to defaults", () => {
	assert.deepEqual(resolveProviders(undefined), ["zhongxin"]);
});

test("resolveProviders: null section falls back to defaults", () => {
	assert.deepEqual(resolveProviders(null), ["zhongxin"]);
});

test("resolveProviders: explicit empty list disables all providers", () => {
	assert.deepEqual(resolveProviders([]), []);
});

test("resolveProviders: configured list wins, order preserved, duplicates dropped", () => {
	assert.deepEqual(resolveProviders(["zhongxin", "b-ai", "zhongxin"]), ["zhongxin", "b-ai"]);
});

test("resolveProviders: non-array garbage falls back to defaults", () => {
	assert.deepEqual(resolveProviders("zhongxin"), ["zhongxin"]);
	assert.deepEqual(resolveProviders(42), ["zhongxin"]);
});

test("resolveProviders: custom defaults respected when section missing", () => {
	assert.deepEqual(resolveProviders(undefined, ["morph"]), ["morph"]);
});

test("resolveProviders: empty-string entries are dropped", () => {
	assert.deepEqual(resolveProviders(["zhongxin", "", "b-ai"]), ["zhongxin", "b-ai"]);
});

test("normalizeMessageId: bare UUID gets msg_ prefix", () => {
	const id = normalizeMessageId("5aa65569-9d38-408e-bac1-70983e4b2840");
	assert.equal(id, "msg_5aa65569-9d38-408e-bac1-70983e4b2840");
});

test("normalizeMessageId: msg_ prefix preserved", () => {
	const id = normalizeMessageId("msg_9ca0b7ed-1158-42ba-9eb1-2333bdde26c6");
	assert.equal(id, "msg_9ca0b7ed-1158-42ba-9eb1-2333bdde26c6");
});

test("normalizeMessageId: over-64 id truncated to 64", () => {
	const long = "5aa65569-".repeat(10); // 80 chars
	const id = normalizeMessageId(long);
	assert.ok(id.startsWith("msg_"));
	assert.ok(id.length <= 64);
});

test("normalizeMessageId: empty/non-string returned unchanged", () => {
	assert.equal(normalizeMessageId(""), "");
	assert.equal(normalizeMessageId(undefined), undefined);
});

test("normalizeTextSignature: JSON textSignature with bare-uuid id fixed", () => {
	const signature = JSON.stringify({ v: 1, id: "5aa65569-9d38-408e-bac1-70983e4b2840" });
	const next = normalizeTextSignature(signature);
	assert.deepEqual(JSON.parse(next), { v: 1, id: "msg_5aa65569-9d38-408e-bac1-70983e4b2840" });
});

test("normalizeTextSignature: already-correct signature untouched (same ref)", () => {
	const signature = JSON.stringify({ v: 1, id: "msg_9ca0b7ed-1158-42ba-9eb1-2333bdde26c6" });
	assert.equal(normalizeTextSignature(signature), signature);
});

test("normalizeTextSignature: legacy plain-string signature fixed", () => {
	assert.equal(normalizeTextSignature("5aa65569-9d38-408e-bac1-70983e4b2840"), "msg_5aa65569-9d38-408e-bac1-70983e4b2840");
});

test("normalizeTextSignature: non-{ JSON (array) treated as legacy id and prefixed", () => {
	const sig = JSON.stringify([1, 2, 3]);
	assert.equal(normalizeTextSignature(sig), "msg_[1,2,3]");
});

test("normalizeTextSignature: JSON object without string id left alone", () => {
	const sig = JSON.stringify({ v: 1, phase: "final_answer" });
	assert.equal(normalizeTextSignature(sig), sig);
});

test("normalizeThinkingSignature: reasoning item with content null gains reasoning_text from summary", () => {
	const item = {
		id: "msg_d191415e-bca7-45a1-8249-d441b9f51c14",
		type: "reasoning",
		summary: [{ type: "summary_text", text: "The user says continue. Let me think." }],
		content: null,
		encrypted_content: null,
		status: null
	};
	const next = normalizeThinkingSignature(JSON.stringify(item));
	const parsed = JSON.parse(next);
	assert.deepEqual(parsed.content, [{ type: "reasoning_text", text: "The user says continue. Let me think." }]);
	assert.equal(parsed.id, item.id); // id already msg_ prefixed: unchanged
	assert.ok(parsed.summary); // summary retained
});

test("normalizeThinkingSignature: reasoning item without content field gains reasoning_text from summary", () => {
	const item = {
		id: "bd0d94fd-2e14-4a7e-b96c-53ea1254bc77", // bare uuid reasoning id (b-ai style)
		summary: [{ text: "multi-line\nthinking here" }]
	};
	const next = normalizeThinkingSignature(JSON.stringify(item));
	const parsed = JSON.parse(next);
	assert.deepEqual(parsed.content, [{ type: "reasoning_text", text: "multi-line\nthinking here" }]);
	assert.equal(parsed.id, "msg_bd0d94fd-2e14-4a7e-b96c-53ea1254bc77");
});

test("normalizeThinkingSignature: reasoning item that already has plaintext reasoning_text untouched", () => {
	const item = {
		id: "rs_abc123",
		summary: [{ type: "summary_text", text: "summary" }],
		content: [{ type: "reasoning_text", text: "full plaintext reasoning", annotations: [] }],
		status: "completed"
	};
	const signature = JSON.stringify(item);
	assert.equal(normalizeThinkingSignature(signature), signature);
});

test("normalizeThinkingSignature: rs_-prefixed id kept (official OpenAI style)", () => {
	const item = {
		id: "rs_1afd5b5bdfb847909428bbb56c8e6536",
		type: "reasoning",
		summary: [{ type: "summary_text", text: "short summary" }],
		status: "completed"
	};
	const next = normalizeThinkingSignature(JSON.stringify(item));
	const parsed = JSON.parse(next);
	assert.equal(parsed.id, "rs_1afd5b5bdfb847909428bbb56c8e6536");
	assert.deepEqual(parsed.content, [{ type: "reasoning_text", text: "short summary" }]);
});

test("normalizeThinkingSignature: unparseable JSON returned unchanged", () => {
	const bad = "{not json";
	assert.equal(normalizeThinkingSignature(bad), bad);
});

test("normalizeAssistantMessage: rewrites replayState.blocks signatures on model assistant messages", () => {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		source: {
			kind: "model",
			provider: "zhongxin",
			model: "deepseek-v4-flash",
			replayState: {
				response: { api: "openai-responses", provider: "zhongxin" },
				blocks: [
					{ type: "text", textSignature: JSON.stringify({ v: 1, id: "5aa65569-9d38-408e-bac1-70983e4b2840" }) }
				]
			}
		}
	};
	const next = normalizeAssistantMessage(message);
	assert.notEqual(next, message); // changed -> new object
	assert.equal(
		JSON.parse(next.source.replayState.blocks[0].textSignature).id,
		"msg_5aa65569-9d38-408e-bac1-70983e4b2840"
	);
});

test("normalizeAssistantMessage: user messages untouched (same ref)", () => {
	const message = { role: "user", content: [{ type: "text", text: "hi" }] };
	assert.equal(normalizeAssistantMessage(message), message);
});

test("normalizeAssistantMessage: no replayState -> untouched", () => {
	const message = { role: "assistant", content: [], source: { kind: "model", provider: "zhongxin" } };
	assert.equal(normalizeAssistantMessage(message), message);
});

test("normalizeMessages: end-to-end over a mixed request", () => {
	const user = { role: "user", content: [{ type: "text", text: "hi" }] };
	const assistant = {
		role: "assistant",
		content: [
			{ type: "reasoning", text: "thinking text" },
			{ type: "text", text: "answer" }
		],
		source: {
			kind: "model",
			provider: "zhongxin",
			replayState: {
				response: { api: "openai-responses", provider: "zhongxin" },
				blocks: [
					{
						type: "reasoning",
						thinkingSignature: JSON.stringify({
							id: "msg_d191415e-bca7-45a1-8249-d441b9f51c14",
							summary: [{ text: "thinking text" }],
							type: "reasoning",
							content: null,
							encrypted_content: null,
							status: null
						})
					},
					{ type: "text", textSignature: JSON.stringify({ v: 1, id: "0f8f1401-1111-2222-3333-444455556666" }) }
				]
			}
		}
	};
	const fixed = normalizeMessages([user, assistant]);
	assert.equal(fixed[0], user);
	const blocks = fixed[1].source.replayState.blocks;
	assert.deepEqual(JSON.parse(blocks[0].thinkingSignature).content, [{ type: "reasoning_text", text: "thinking text" }]);
	assert.equal(JSON.parse(blocks[1].textSignature).id, "msg_0f8f1401-1111-2222-3333-444455556666");
});

test("normalizeMessages: no changes -> same array ref", () => {
	const ok = {
		role: "assistant",
		content: [],
		source: {
			kind: "model",
			replayState: {
				blocks: [{ type: "text", textSignature: JSON.stringify({ v: 1, id: "msg_abc" }) }]
			}
		}
	};
	const messages = [ok];
	assert.equal(normalizeMessages(messages), messages);
});

test("regression: zhongxin real captured reasoning signature (content null, encrypted null)", () => {
	// Captured verbatim from a zhongxin session (only text truncated).
	const signature = JSON.stringify({
		id: "msg_9b8be609-0dda-4f42-9d97-cfc71519429b",
		summary: [{ text: "undici index.js — but for ESM import, undici's package.json should have exports", type: "summary_text" }],
		type: "reasoning",
		content: null,
		encrypted_content: null,
		status: null
	});
	const parsed = JSON.parse(normalizeThinkingSignature(signature));
	assert.deepEqual(parsed.content, [{ type: "reasoning_text", text: "undici index.js — but for ESM import, undici's package.json should have exports" }]);
	assert.equal(parsed.id, "msg_9b8be609-0dda-4f42-9d97-cfc71519429b");
});
