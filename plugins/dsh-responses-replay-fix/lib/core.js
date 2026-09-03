/**
 * dsh-responses-replay-fix — 回放规整核心（纯函数，可单测）。
 *
 * 背景：部分 OpenAI-Responses 兼容网关（典型：中信 www.wxzjai.com）出站
 * 响应不规范，但入站校验却按 OpenAI 官方规则严格执行，导致 DSH 回放历史时
 * 被 400 拒绝：
 *
 * 1. `Invalid 'id': message id must be a string starting with 'msg_'`
 *    网关返回的 assistant message item id 是裸 UUID（如
 *    `5aa65569-9d38-408e-bac1-70983e4b2840`）。DSH 把该 id 存入 replayState
 *    的 textSignature，下一轮原样作为 Responses 输入消息 id 回发 → 被拒。
 *    规整：非 `msg_` 开头的 id 补 `msg_` 前缀（≤64 字符约束，超长做截断）。
 *
 * 2. `The reasoning_text in the thinking mode must be passed back to the API`
 *    网关返回的 reasoning item 只有 `summary`（明文推理全文在
 *    `summary[0].text`），`content` 为 null。DSH 把整个 item 原样存入
 *    thinkingSignature，回放时原样 push 进输入 → thinking 模式下网关要求
 *    reasoning item 必须带明文 `reasoning_text`。
 *    规整：content 缺失明文 reasoning_text 时，用 summary 文本补
 *    `content: [{ type: "reasoning_text", text }]`。
 */

/** `msg_` 前缀 + 后缀最大总长（OpenAI 约束 64 字符）。 */
const MAX_MSG_ID_LENGTH = 64;

/**
 * 规整一个 Responses 消息 id：必须 `msg_` 开头且 ≤64 字符。
 * 非 `msg_` 开头的 id 补前缀；超出长度则截断到上限。
 * @param id - 网关返回的原始 item id。
 * @returns 可被严格网关接受的 `msg_...` id。
 */
export function normalizeMessageId(id) {
	if (typeof id !== "string" || id.length === 0) return id;
	const withPrefix = id.startsWith("msg_") ? id : `msg_${id}`;
	if (withPrefix.length <= MAX_MSG_ID_LENGTH) return withPrefix;
	return withPrefix.slice(0, MAX_MSG_ID_LENGTH);
}

/**
 * 规整一个 reasoning item 的 id。
 *
 * 与 message item 不同，reasoning item 在规范网关（官方 OpenAI、morph）里是
 * `rs_` 前缀；中信网关则返回 `msg_` 前缀。两者都是合法可回传的形式，保持
 * 原样。只有**裸 UUID**（既非 `rs_` 也非 `msg_`）才补 `msg_` 前缀 —— 那正是
 * b-ai / 部分中信响应里出现、会被严格网关拒绝的形态。
 * @param id - reasoning item 的原始 id。
 * @returns 规整后的 id。
 */
export function normalizeReasoningId(id) {
	if (typeof id !== "string" || id.length === 0) return id;
	if (id.startsWith("msg_") || id.startsWith("rs_")) return id;
	const withPrefix = `msg_${id}`;
	if (withPrefix.length <= MAX_MSG_ID_LENGTH) return withPrefix;
	return withPrefix.slice(0, MAX_MSG_ID_LENGTH);
}

/**
 * 规整 `textSignature` 字符串（`{"v":1,"id":"..."}` 或旧式裸字符串）。
 * id 不是 `msg_` 前缀时补前缀；解析失败的字符串原样返回。
 * @param signature - replayState block 上的 textSignature。
 * @returns 规整后的 textSignature（尽力而为，失败返回入参）。
 */
export function normalizeTextSignature(signature) {
	if (typeof signature !== "string" || signature.length === 0) return signature;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature);
			if (typeof parsed !== "object" || parsed === null) return signature;
			if (typeof parsed.id === "string") {
				const next = normalizeMessageId(parsed.id);
				if (next === parsed.id) return signature;
				return JSON.stringify({ ...parsed, id: next });
			}
			return signature;
		} catch {
			// 非 JSON 签名走下面的裸字符串路径。
		}
	}
	// 旧式：整个签名就是一个 id。
	const next = normalizeMessageId(signature);
	return next === signature ? signature : next;
}

/** 一条 reasoning item 的 content 是否已带明文 reasoning_text。 */
function hasPlainReasoningText(item) {
	const content = Array.isArray(item?.content) ? item.content : [];
	return content.some((block) => block && block.type === "reasoning_text" && typeof block.text === "string" && block.text.length > 0);
}

/** 取一条 reasoning item 可用的明文推理文本（summary 优先，逐项拼接）。 */
function plainReasoningTextFromSummary(item) {
	const summary = Array.isArray(item?.summary) ? item.summary : [];
	const parts = summary
		.map((entry) => (typeof entry === "string" ? entry : entry?.text))
		.filter((text) => typeof text === "string" && text.length > 0);
	return parts.join("\n\n");
}

/**
 * 规整 `thinkingSignature` 字符串（reasoning item 的 JSON）。
 * - id 非 `msg_` 前缀 → 补前缀。
 * - thinking 模式需要明文 `reasoning_text`：content 缺明文时，用 summary 文本
 *   补 `content: [{ type: "reasoning_text", text }]`（encrypted_content 与
 *   摘要保留，仅补明文，避免把网关给的摘要语义改成别的）。
 * @param signature - replayState block 上的 thinkingSignature。
 * @returns 规整后的 thinkingSignature；无法解析/无需修改时返回入参。
 */
export function normalizeThinkingSignature(signature) {
	if (typeof signature !== "string" || signature.length === 0) return signature;
	let item;
	try {
		item = JSON.parse(signature);
	} catch {
		return signature;
	}
	if (typeof item !== "object" || item === null || Array.isArray(item)) return signature;
	let changed = false;
	const next = { ...item };
	if (typeof next.id === "string") {
		const fixedId = normalizeReasoningId(next.id);
		if (fixedId !== next.id) {
			next.id = fixedId;
			changed = true;
		}
	}
	if (!hasPlainReasoningText(next)) {
		const text = plainReasoningTextFromSummary(next);
		if (text.length > 0) {
			next.content = [{ type: "reasoning_text", text }];
			changed = true;
		}
	}
	return changed ? JSON.stringify(next) : signature;
}

/**
 * 规整一条 durable assistant 消息里 replayState.blocks 的签名。
 * 只触碰 `textSignature` / `thinkingSignature` 字符串；其它字段原样保留。
 * 不改入参，返回新对象；没有需要修改时返回原消息（同一引用）。
 * @param message - harness 持久化的 assistant 消息（含 source.replayState.blocks）。
 * @returns 规整后的消息。
 */
export function normalizeAssistantMessage(message) {
	if (!message || message.role !== "assistant") return message;
	const source = message.source;
	if (!source || source.kind !== "model") return message;
	const replayState = source.replayState;
	const blocks = replayState?.blocks;
	if (!Array.isArray(blocks) || blocks.length === 0) return message;
	let changed = false;
	const nextBlocks = blocks.map((block) => {
		if (!block || typeof block !== "object") return block;
		const next = { ...block };
		if (typeof block.textSignature === "string") {
			const fixed = normalizeTextSignature(block.textSignature);
			if (fixed !== block.textSignature) {
				next.textSignature = fixed;
				changed = true;
			}
		}
		if (typeof block.thinkingSignature === "string") {
			const fixed = normalizeThinkingSignature(block.thinkingSignature);
			if (fixed !== block.thinkingSignature) {
				next.thinkingSignature = fixed;
				changed = true;
			}
		}
		return next;
	});
	if (!changed) return message;
	return {
		...message,
		source: {
			...source,
			replayState: { ...replayState, blocks: nextBlocks }
		}
	};
}

/**
 * 规整一整个请求上下文：只对 role=assistant 且带 model replayState 的消息
 * 生效；其余消息原样保留（同一引用）。
 * @param messages - harness 请求消息数组。
 * @returns 规整后的消息数组。
 */
export function normalizeMessages(messages) {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const next = messages.map((message) => {
		const fixed = normalizeAssistantMessage(message);
		if (fixed !== message) changed = true;
		return fixed;
	});
	return changed ? next : messages;
}

/**
 * 由 settings 段的 providers 值解析"生效的 provider 集合"。
 *
 * 语义：
 * - `undefined`/缺省 → 使用默认名单（`["zhongxin"]`）；
 * - 显式空数组 → 空集合（不修复任何 provider，可用于关闭本插件效果）；
 * - 其它数组 → 按给定名单生效（原样、去重、保留顺序）。
 * @param providers - settings 段 `responses-replay-fix.providers` 的解析值。
 * @param defaults - 缺省时的名单（测试可注入）。
 * @returns 生效的 provider 数组。
 */
export function resolveProviders(providers, defaults = ["zhongxin"]) {
	if (!Array.isArray(providers)) return [...defaults];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const name of providers) {
		if (typeof name === "string" && name.length > 0 && !seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}
