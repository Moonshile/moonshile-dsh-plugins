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
 * 做法：在宿主 LLM 适配器每次发请求前，对回放的 durable assistant 消息做
 * 规整 —— 消息 id 补 `msg_` 前缀、reasoning item 用 summary 文本补明文
 * `reasoning_text`。只影响命中 provider 名单的请求；规则均为"缺失才补/
 * 不合法才改"，对规范网关（morph、官方 OpenAI）是无操作。
 *
 * 生效名单通过**本插件的 cordis entry config** 配置（DSH 0.2 起 settings 段就是
 * 插件自己的 entry config；0.1.x 同样读得到 entry config）。写在 profile 的
 * `cordis.patch.yml` 里：
 *
 *   ```yaml
 *   - id: responses-replay-fix
 *     name: dsh-responses-replay-fix
 *     config:
 *       providers: [zhongxin, b-ai]
 *   ```
 *
 * 未配置 → `["zhongxin"]`；显式空数组 → 不修复任何 provider。
 * 注意：0.1.x 的 `settings.yaml` 段已不再被读取（0.2 移除了 `settings.installSection`，
 * 并把 settings.yaml 整体迁移进 profile 的 cordis.patch.yml entry config）。
 *
 * 实现要点（为什么从 `ctx.llm` 取实例包装，而不是 patch 模块 class）：
 *
 *   插件以 profile bundle 安装时，`@deepseek-ai/dsh-llm-pi-ai` 通过 pnpm
 *   `link:`（开发）或 registry（发布）解析出的模块副本，不一定与宿主进程
 *   加载的是同一个 realpath —— Node 的 ESM 缓存按 URL 去重，两个不同副本
 *   就是两个不同的 class，patch 其 prototype 不会作用到宿主实际调用的那
 *   个。因此本插件不 import 该模块，而是从 `ctx.llm` 服务（宿主进程内的
 *   单例）取已注册 adapter 的**实例**，在实例上挂 own `streamWithSnapshot`
 *   包装（own property 遮蔽原型方法）。llm-pi-ai 的 `prepareCall` 闭包与
 *   `stream()` 都经 `this.streamWithSnapshot` 动态下发，own property 一定
 *   命中，无论模块在哪份副本里被实例化。
 */

import z from "@deepseek-ai/schemastery";
import { normalizeMessages, resolveProviders } from "./core.js";

/** 本插件依赖的服务。 */
const inject = [];

/** 默认命中的 provider（entry config 未配置时）。 */
const DEFAULT_PROVIDERS = ["zhongxin"];

/** entry config schema：一个 provider 名单（cordis 用它校验/补默认值）。 */
const Config = z.object({
	providers: z.array(z.string()).default([...DEFAULT_PROVIDERS])
});

/** 标记：防止同一 adapter 实例被重复包装（HMR / 重复加载时）。 */
const PATCHED = Symbol("dsh-responses-replay-fix.patched");

/**
 * 包装一个 adapter 实例的 `streamWithSnapshot`（async generator）。
 * 规整 `options.messages` 后 `yield*` 交给原方法，完整转发其产出与终止。
 */
function wrapAdapterStream(adapter, readProviders, logger) {
	if (!adapter || typeof adapter.streamWithSnapshot !== "function" || adapter[PATCHED]) return;
	adapter[PATCHED] = true;
	const original = adapter.streamWithSnapshot;
	adapter.streamWithSnapshot = async function* patchedStreamWithSnapshot(options, snapshot) {
		const provider = options?.provider;
		if (provider !== undefined && Array.isArray(options.messages)) {
			const providers = resolveProviders(readProviders().providers);
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
}

/**
 * Apply：读取本 entry 的 config，并包装宿主 `ctx.llm` 上已注册各 adapter 实例的
 * `streamWithSnapshot`。llm-pi-ai 在 base bundle 中先于本插件注册路由；
 * `llm/adapters-updated` 在路由变更（provider 增删 / HMR）时重发，届时重新
 * 扫描补包装。PATCHED 标记保证同一实例只包装一次。
 */
function apply(ctx, entryConfig) {
	const logger = ctx.logger;

	/**
	 * 当前生效的 provider 名单：本插件 entry 的 `config.providers`（profile patch
	 * 可覆盖），缺省时退回内置默认。entry config 变更会让 cordis 重新 apply，
	 * 所以这里每次读取入参快照即可。
	 */
	const source = () => ({ providers: entryConfig?.providers ?? [...DEFAULT_PROVIDERS] });

	/** 包装 llm 服务当前注册的全部 adapter 实例。 */
	const wrapRegisteredAdapters = (llm) => {
		if (!llm?.adapters) return;
		for (const registration of llm.adapters.values()) {
			wrapAdapterStream(registration?.adapter, () => source(), logger);
		}
	};
	ctx.inject(["llm"], (llmCtx) => {
		wrapRegisteredAdapters(llmCtx.llm ?? llmCtx);
	});
	// 路由变更（HMR / provider 增删 / adapter 重注册）后重新扫描。
	ctx.on?.("llm/adapters-updated", () => {
		const llm = ctx.get("llm");
		if (llm) wrapRegisteredAdapters(llm);
	});

	logger?.info?.("[responses-replay-fix] active; providers:", JSON.stringify(resolveProviders(source().providers)));
}

export { Config, apply, inject };
