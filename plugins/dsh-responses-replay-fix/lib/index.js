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
 * 生效名单通过 DSH settings 段 `responses-replay-fix.providers` 配置
 * （settings.yaml 顶层键；默认 `["zhongxin"]`）。例如：
 *
 *   ```yaml
 *   responses-replay-fix:
 *     providers: [zhongxin, b-ai]
 *   ```
 *
 * 空数组或未配置时按默认处理（未配置 → `["zhongxin"]`，显式空数组 → 不
 * 修复任何 provider）。改动写进 settings 后对后续请求即时生效（每次请求
 * 读取当前解析值），无需重启。
 */

import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { normalizeMessages, resolveProviders } from "./core.js";

/** 本插件依赖的服务。 */
const inject = [];

/** settings 段名（settings.yaml 顶层键）。 */
const SETTINGS_NAMESPACE = "responses-replay-fix";

/** 默认命中的 provider（settings 未配置时）。 */
const DEFAULT_PROVIDERS = ["zhongxin"];

/** settings 段 schema：一个 provider 名单。 */
const Config = z.object({
	providers: z.array(z.string()).default([...DEFAULT_PROVIDERS])
});

/** 标记：防止 patch 被重复应用（HMR / 重复加载时）。 */
const PATCHED = Symbol("dsh-responses-replay-fix.patched");

/**
 * Apply：注册 settings 段并包装 PiAiAdapter 的流式入口。
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
	prototype[PATCHED] = true;

	/** 当前权威配置：settings 段解析值；settings 服务缺席时退回组合 entry。 */
	let source = () => ({ providers: [...DEFAULT_PROVIDERS] });
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, { providers: [...DEFAULT_PROVIDERS] }, {
			setSource: (current) => {
				source = current;
			},
			onChange: () => {}
		});
	});

	prototype.streamWithSnapshot = async function* patchedStreamWithSnapshot(options, snapshot) {
		const provider = options?.provider;
		if (provider !== undefined && Array.isArray(options.messages)) {
			const providers = resolveProviders(source().providers);
			if (providers.length > 0 && providers.includes(provider)) {
				try {
					options = { ...options, messages: normalizeMessages(options.messages) };
				} catch (error) {
					logger?.warn?.("[responses-replay-fix] message normalization failed:", error?.message ?? error);
				}
			}
		}
		yield* original.call(this, options, snapshot);
	};
	logger?.info?.("[responses-replay-fix] active; providers:", JSON.stringify(resolveProviders(source().providers)));
}

export { Config, apply, inject };
