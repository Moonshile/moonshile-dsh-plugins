/**
 * dsh-responses-replay-fix — host 插件。
 *
 * 解决一类 OpenAI-Responses 兼容网关（典型：中信 www.wxzjai.com）的
 * 历史回放被 400 拒绝的问题：
 *
 *   1. `Invalid 'id': message id must be a string starting with 'msg_'`
 *      —— 网关返回的 assistant message item id 是裸 UUID，DSH 存进
 *      textSignature 后原样回发，被严格网关拒绝。
 *   2. `The reasoning_text in the thinking mode must be passed back to the API`
 *      —— 网关返回的 reasoning item 只有 summary、content 为 null，回放时
 *      缺明文 `reasoning_text`，thinking 模式下被网关拒绝。
 *
 * 做法：在宿主 LLM 适配器（llm-pi-ai 的 PiAiAdapter）每次发请求前，对回放
 * 的 durable assistant 消息做规整 —— 消息 id 补 `msg_` 前缀、reasoning item
 * 用 summary 文本补明文 `reasoning_text`。只影响命中 provider 名单的请求；
 * 规则均为"缺失才补/不合法才改"，对规范网关（morph、官方 OpenAI）是无操作。
 *
 * 目标 provider 名单默认 `zhongxin`；可用环境变量
 * `DSH_RESPONSES_REPLAY_FIX_PROVIDERS`（逗号分隔）覆盖。
 */

import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { normalizeMessages } from "./core.js";

/** 本插件依赖的服务。 */
const inject = [];

/** 默认命中的 provider；环境变量可覆盖（逗号分隔）。 */
function targetProviders() {
	const raw = process.env.DSH_RESPONSES_REPLAY_FIX_PROVIDERS;
	if (raw !== undefined && raw.trim().length > 0) {
		return new Set(raw.split(",").map((name) => name.trim()).filter(Boolean));
	}
	return new Set(["zhongxin"]);
}

/** 标记：防止 patch 被重复应用（HMR / 重复加载时）。 */
const PATCHED = Symbol("dsh-responses-replay-fix.patched");

/**
 * Apply：包装 PiAiAdapter 的流式入口，在发给网关前规整回放历史。
 *
 * 包装点选 `streamWithSnapshot(options, snapshot)`：所有调用路径
 * （`stream(options)` 与 `prepareCall(...).stream` 闭包）都经它下发，
 * 在此规整 `options.messages`（durable assistant 消息）一处即全覆盖。
 */
function apply(ctx) {
	const logger = ctx.logger;
	const prototype = PiAiAdapter?.prototype;
	const original = prototype?.streamWithSnapshot;
	if (typeof original !== "function") {
		logger?.warn?.("[responses-replay-fix] PiAiAdapter.prototype.streamWithSnapshot not found; skipping patch");
		return;
	}
	if (prototype[PATCHED]) {
		logger?.info?.("[responses-replay-fix] already patched");
		return;
	}
	const targets = targetProviders();
	prototype[PATCHED] = true;
	prototype.streamWithSnapshot = async function* patchedStreamWithSnapshot(options, snapshot) {
		const provider = options?.provider;
		if (provider !== undefined && targets.has(provider) && Array.isArray(options.messages)) {
			try {
				options = { ...options, messages: normalizeMessages(options.messages) };
			} catch (error) {
				logger?.warn?.("[responses-replay-fix] message normalization failed:", error?.message ?? error);
			}
		}
		yield* original.call(this, options, snapshot);
	};
	logger?.info?.("[responses-replay-fix] active for providers:", [...targets].join(", "));
}

export { apply, inject };
