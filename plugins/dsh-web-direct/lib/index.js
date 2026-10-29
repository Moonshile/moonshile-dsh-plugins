/**
 * dsh-web-direct — host plugin: make `web_search` / `web_fetch` bypass the
 * machine's fake-ip DNS and resolve to the real public address.
 *
 * Background: on some machines the OS resolver is hijacked by a VPN / zero-trust
 * tunnel (Clash-style "fake-ip", addresses in 198.18.0.0/15). Every hostname
 * then resolves to a reserved-range address, which:
 *   - makes web_fetch's SSRF guard deterministically reject it
 *     ("resolves to a non-public IP address", WEB_BLOCKED_URL), and
 *   - makes web_search's connection to api.deepseek.com flaky (the tunnel's
 *     per-connection forwarding intermittently black-holes reused sockets).
 *
 * This plugin does NOT touch the VPN, and it deliberately does NOT use the
 * process-wide outbound-proxy route (`HTTPS_PROXY` + `@deepseek-ai/dsh-http-proxy`):
 * that route also carries LLM, MCP and plugin traffic, so an environment whose
 * LLM endpoints include private/internal hosts breaks once those are handed to
 * a public-DNS proxy. Instead it registers two providers on the web seam only —
 * no other part of the process changes transport:
 *
 * - Fetch provider `http-direct`: reuses the battle-tested
 *   `@deepseek-ai/dsh-web-fetch-http` `HttpFetchProvider` (public-IP validation,
 *   address-pinned Undici transport, same-origin redirects, byte/charset caps)
 *   with an injected `resolveAddresses` that queries public DNS directly.
 * - Search provider `deepseek-direct`: calls DeepSeek's Anthropic-compatible
 *   Messages API with native `web_search_20250305` over a connection pinned to
 *   the endpoint's real public IP.
 *
 * `dns.setServers(...)` is called once so the c-ares channel (`dns.resolve4/6`,
 * which this plugin uses) answers with real addresses. The `getaddrinfo` channel
 * (`dns.lookup`) every other component uses is left untouched.
 */

import { setServers, promises as dns } from "node:dns";
import { isIP } from "node:net";
import { WebError } from "@deepseek-ai/dsh-web";
import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { isPublicIp, describeSearchStatus, describeSearchTransportFailure, mapAnthropicResponse, pinnedLookup, selectSearchAuth } from "./core.js";

/** The web capability seam this provider registers into. */
const inject = ["web"];

/** Public resolvers that answer with real (non-fake) addresses. */
const PUBLIC_RESOLVERS = ["223.5.5.5", "114.114.114.114"];

/** Provider ids this plugin registers and selects. */
const FETCH_PROVIDER_ID = "http-direct";
const SEARCH_PROVIDER_ID = "deepseek-direct";

/** Search defaults, aligned with the stock deepseek search provider. */
const SEARCH_DEFAULT_BASE = "https://api.deepseek.com/anthropic/v1";
const SEARCH_ENV_BASE = "DEEPSEEK_SEARCH_BASE_URL";
const SEARCH_DEFAULT_MODEL = "deepseek-v4-flash";
const SEARCH_API_VERSION = "2023-06-01";
const SEARCH_MAX_TOKENS = 4096;
const SEARCH_MAX_USES = 5;
const SEARCH_API_KEY_ENV = "DEEPSEEK_API_KEY";
const SEARCH_USER_AGENT = "deepseek-harness-direct/0.1.0";

/** Provider route `@deepseek-ai/dsh-llm-deepseek-account` registers; `request/context` records it per Session. */
const ACCOUNT_PROVIDER = "deepseek-account";

/** Transport limits, aligned with the stock HTTP fetch provider's defaults. */
const FETCH_LIMITS = {
	maxResponseBytes: 5_000_000,
	maxBodyChars: 100_000,
	timeoutMs: 30_000,
	maxRedirects: 5,
	userAgent: "deepseek-harness-direct/0.1.0 (+https://github.com/deepseek-ai)",
};

/** Build the abort error used while racing a DNS query against the caller. */
function abortError(signal) {
	return new Error("web-direct aborted during hostname resolution", { cause: signal?.reason });
}

/**
 * Race a non-cancellable c-ares query against the caller's signal, so tool
 * cancellation is not delayed by an in-flight lookup.
 * @param promise - the DNS query.
 * @param signal - optional caller signal.
 * @returns the query result, or rejects with the abort reason.
 */
function raceWithSignal(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Resolve a hostname against public DNS and return the validated, non-empty
 * public address set — the "correct address" the machine's fake-ip hid.
 * @param hostname - URL hostname (IPv6 literals may carry brackets).
 * @param signal - optional cancellation signal.
 * @returns public addresses as Undici lookup entries.
 * @throws {WebError} `WEB_BLOCKED_URL` when no public address is available.
 */
async function resolvePublicReal(hostname, signal) {
	const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	const literalFamily = isIP(bare);
	if (literalFamily !== 0) {
		if (!isPublicIp(bare)) throw new WebError(`URL hostname "${hostname}" is not a public IP address`, "WEB_BLOCKED_URL");
		return [{ address: bare, family: literalFamily }];
	}
	const [v4, v6] = await Promise.all([
		raceWithSignal(
			dns.resolve4(bare).catch(() => []),
			signal,
		),
		raceWithSignal(
			dns.resolve6(bare).catch(() => []),
			signal,
		),
	]);
	const answers = [...v4.map((address) => ({ address, family: 4 })), ...v6.map((address) => ({ address, family: 6 }))];
	const unique = [...new Map(answers.filter((entry) => isPublicIp(entry.address)).map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
	if (unique.length === 0) throw new WebError(`URL hostname "${hostname}" resolved to no public IP address`, "WEB_BLOCKED_URL");
	return unique;
}

/**
 * Resolve one search API key: the credentials service first (the Web Models
 * page writes there), then the launching environment.
 * @param ctx - plugin context, for the optional credentials service.
 * @returns the key, or undefined when unconfigured.
 */
async function resolveSearchApiKey(ctx) {
	const ambient = process.env[SEARCH_API_KEY_ENV];
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		try {
			const resolved = await credentials.resolve(credentialRef(SEARCH_API_KEY_ENV));
			if (resolved?.value != null && resolved.value.length > 0) return resolved.value;
		} catch {
			/* fall through to the ambient value */
		}
	}
	return ambient != null && ambient.length > 0 ? ambient : undefined;
}

/**
 * Resolve a DeepSeek Account token for this search, the way the stock provider
 * does: only when the initiating Session's latest request routed through the
 * account adapter, and only for the endpoint actually being dialled. A failed
 * resolution is not fatal — the API key stays a usable fallback.
 *
 * @param ctx - plugin context, for the account and agent services.
 * @param endpoint - the Messages endpoint this operation dispatches to.
 * @returns the account token, or undefined when this conversation is not on the account route.
 */
async function resolveAccountToken(ctx, endpoint) {
	const provider = ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider;
	if (provider !== ACCOUNT_PROVIDER) return undefined;
	try {
		const token = await ctx.get("deepseekAccount")?.resolveToken(endpoint);
		return typeof token === "string" && token.length > 0 ? token : undefined;
	} catch (error) {
		ctx.logger?.warn(`[web-direct] DeepSeek Account token resolution failed, falling back to ${SEARCH_API_KEY_ENV}: ${error?.message ?? error}`);
		return undefined;
	}
}

/**
 * Search through DeepSeek's native web search over a connection pinned to the
 * endpoint's real public IP rather than the machine's fake-ip answer.
 * @param ctx - plugin context (credential lookup).
 * @param request - the search request (`query`).
 * @param signal - cancellation signal.
 * @returns normalized sources.
 */
async function searchDirect(ctx, request, signal) {
	const endpoint = `${process.env[SEARCH_ENV_BASE] ?? SEARCH_DEFAULT_BASE}/messages`;
	const auth = selectSearchAuth({
		accountToken: await resolveAccountToken(ctx, endpoint),
		apiKey: await resolveSearchApiKey(ctx),
	});
	if (auth === undefined) {
		throw new WebError(
			`web-direct search has no credential: this conversation is not on a DeepSeek Account model, and "${SEARCH_API_KEY_ENV}" is empty. The search call goes to ${endpoint} on its own — it never uses the conversation model's access point — so store a valid key through the credentials service, export it in the launching environment, or sign in to DeepSeek and use a DeepSeek Account model.`,
			"WEB_PROVIDER_CREDENTIAL_MISSING",
		);
	}
	const addresses = await resolvePublicReal(new URL(endpoint).hostname, signal);
	const { Agent, fetch: undiciFetch } = await import("undici");
	const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: pinnedLookup(addresses) } });
	try {
		let response;
		try {
			response = await undiciFetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					...auth.headers,
					"anthropic-version": SEARCH_API_VERSION,
					"content-type": "application/json",
					accept: "application/json",
					"user-agent": SEARCH_USER_AGENT,
				},
				body: JSON.stringify({
					model: SEARCH_DEFAULT_MODEL,
					max_tokens: SEARCH_MAX_TOKENS,
					messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${request.query}` }] }],
					tools: [{ type: "web_search_20250305", name: "web_search", max_uses: SEARCH_MAX_USES }],
				}),
				...(signal !== void 0 ? { signal } : {}),
				dispatcher,
			});
		} catch (error) {
			if (signal?.aborted === true) throw new WebError("web-direct search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(describeSearchTransportFailure(error, endpoint), "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let detail;
			try {
				const parsed = await response.json();
				detail = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
			} catch {
				/* keep the status-only message */
			}
			if (signal?.aborted === true) throw new WebError("web-direct search aborted", "WEB_ABORTED");
			throw new WebError(describeSearchStatus({ endpoint, status: response.status, detail, authKind: auth.kind }), "WEB_PROVIDER_ERROR");
		}
		try {
			return mapAnthropicResponse(await response.json());
		} catch (error) {
			if (error instanceof WebError) throw error;
			throw new WebError(error?.message ?? String(error), error?.code ?? "WEB_PROVIDER_ERROR", { cause: error });
		}
	} finally {
		await dispatcher.close().catch(() => {});
	}
}

/**
 * Point a seam selection at this plugin's provider.
 *
 * The stock composition pins the seam to the built-in providers
 * (`fetchProvider: http`, `searchProvider: deepseek-official`), and the seam
 * reads that config once when it is constructed. So this plugin *claims* the
 * selection instead of deferring to the pinned value: a provider that registers
 * but is never selected leaves the tools exactly as broken as before. The
 * bundle patch declares the same ids, so this write is the belt to that
 * suspenders — it also covers a seam instance constructed before the patch.
 *
 * @param ctx - plugin context.
 * @param field - `fetchProviderId` or `searchProviderId`.
 * @param ours - the id this plugin registers.
 */
function selectProvider(ctx, field, ours) {
	const current = ctx.web[field];
	if (current === ours) return;
	ctx.web[field] = ours;
	ctx.logger?.info(`[web-direct] web.${field}: ${current === void 0 ? "(unset)" : `"${current}"`} -> "${ours}"`);
}

/** Apply: install public DNS for the c-ares channel, then register both providers. */
function apply(ctx) {
	try {
		setServers(PUBLIC_RESOLVERS);
	} catch (error) {
		ctx.logger?.warn("[web-direct] dns.setServers failed:", error?.message ?? error);
	}

	const fetchProvider = new HttpFetchProvider({ ...FETCH_LIMITS }, resolvePublicReal);
	// Register under our own id instead of the stock "http".
	fetchProvider.id = FETCH_PROVIDER_ID;
	ctx.web.registerFetchProvider(fetchProvider);
	ctx.web.registerSearchProvider({
		id: SEARCH_PROVIDER_ID,
		available: () => true,
		search: (request, signal) => searchDirect(ctx, request, signal),
	});

	selectProvider(ctx, "fetchProviderId", FETCH_PROVIDER_ID);
	selectProvider(ctx, "searchProviderId", SEARCH_PROVIDER_ID);
	ctx.logger?.info(`[web-direct] real-DNS web providers active (fetch=${FETCH_PROVIDER_ID}, search=${SEARCH_PROVIDER_ID})`);
}

export { FETCH_PROVIDER_ID, PUBLIC_RESOLVERS, SEARCH_PROVIDER_ID, apply, inject, resolvePublicReal };
