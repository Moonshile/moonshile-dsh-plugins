/**
 * dsh-web-direct / core — dependency-free logic: address classification,
 * pinned-lookup construction, and Anthropic-Messages search mapping.
 *
 * Kept separate from `index.js` on purpose: the workspace cannot resolve the
 * DSH packages (`@deepseek-ai/*`) that the wiring imports, so the unit tests
 * import this module instead. Nothing here touches the network or a DSH service.
 *
 * @module dsh-web-direct/core
 */

const IPV4_MAX_OCTET = 255;

/**
 * Whether an address is globally reachable unicast — the property the stock
 * fetch provider's SSRF guard requires. This is a conservative subset of
 * `ipaddr.js`'s ranges: everything ipaddr.js calls non-unicast that a public
 * DNS could plausibly return is rejected here, including the 198.18.0.0/15
 * benchmarking block that Clash/Mihomo fake-ip mode hands out.
 *
 * @param input - textual IPv4 or IPv6 address (brackets are tolerated).
 * @returns true only for a public unicast destination.
 */
function isPublicIp(input) {
	const text = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
	if (text.includes(":")) return isPublicIpv6(text);
	return isPublicIpv4(text);
}

/**
 * Classify one dotted-quad address.
 * @param text - IPv4 address.
 * @returns true when it is public unicast.
 */
function isPublicIpv4(text) {
	const parts = text.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > IPV4_MAX_OCTET)) return false;
	const [a, b, c] = octets;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast/reserved
	if (a === 169 && b === 254) return false; // link-local
	if (a === 172 && b >= 16 && b <= 31) return false; // private
	if (a === 192 && b === 168) return false; // private
	if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking — Clash/Mihomo fake-ip
	if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
	return true;
}

/**
 * Classify one IPv6 address (compressed forms included). Transition and
 * translation prefixes (6to4, Teredo, IPv4-mapped) are unwrapped or refused
 * because their eventual IPv4 destination cannot be judged here.
 * @param text - IPv6 address.
 * @returns true when it is public unicast.
 */
function isPublicIpv6(text) {
	const value = text.toLowerCase();
	if (value === "::" || value === "::1") return false;
	if (value.startsWith("::ffff:")) return isPublicIpv4(value.slice(7));
	if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return false; // link-local fe80::/10
	if (value.startsWith("fc") || value.startsWith("fd")) return false; // unique local fc00::/7
	if (value.startsWith("ff")) return false; // multicast ff00::/8
	if (value.startsWith("2002:")) return false; // 6to4
	if (value.startsWith("2001:0:")) return false; // Teredo
	return true;
}

/**
 * Build the Undici `connect.lookup` that serves a fixed, already-validated
 * address set, so the transport cannot re-resolve to a fake-ip answer.
 *
 * @param addresses - validated `{ address, family }` entries.
 * @returns a Node-compatible lookup callback.
 */
function pinnedLookup(addresses) {
	return (hostname, options, callback) => {
		const family = typeof options.family === "number" ? options.family : options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : 0;
		const eligible = family === 0 ? addresses : addresses.filter((entry) => entry.family === family);
		const selected = eligible[0];
		if (selected === void 0) {
			callback(
				Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), { code: "ENOTFOUND", hostname }),
				options.all === true ? [] : "",
				family,
			);
			return;
		}
		if (options.all === true) {
			callback(null, eligible.map((entry) => ({ ...entry })));
			return;
		}
		callback(null, selected.address, selected.family);
	};
}

/**
 * Build a `url -> cited_text` map from every text block's citations. Anthropic
 * `web_search_result` items carry no inline snippet, so the excerpt comes from
 * the citation keyed by URL (first occurrence wins).
 *
 * @param blocks - response content blocks.
 * @returns the snippet map.
 */
function citationSnippets(blocks) {
	const map = new Map();
	for (const block of blocks) {
		if (block.type !== "text") continue;
		for (const cite of block.citations ?? []) {
			if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
				map.set(cite.url, cite.cited_text);
			}
		}
	}
	return map;
}

/**
 * Normalize an Anthropic Messages response into the seam's search result:
 * walk `web_search_tool_result` blocks, join each item to its citation
 * snippet, and dedupe by URL.
 *
 * @param response - the parsed Messages response body.
 * @returns `{ sources, truncated }`.
 * @throws {Error} with `code` `WEB_PROVIDER_ERROR` when native search produced no result block.
 */
function mapAnthropicResponse(response) {
	const blocks = response.content ?? [];
	const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
	if (resultBlocks.length === 0) {
		throw Object.assign(new Error("DeepSeek returned no web_search_tool_result blocks; native web search did not trigger"), { code: "WEB_PROVIDER_ERROR" });
	}
	const snippets = citationSnippets(blocks);
	const seen = new Set();
	const sources = [];
	for (const block of resultBlocks) {
		for (const item of block.content ?? []) {
			if (item.type !== "web_search_result" || item.url.length === 0 || seen.has(item.url)) continue;
			seen.add(item.url);
			const source = { url: item.url };
			if (item.title != null && item.title.length > 0) source.title = item.title;
			const snippet = snippets.get(item.url);
			if (snippet != null) source.snippet = snippet;
			if (item.page_age != null && item.page_age.length > 0) source.publishedAt = item.page_age;
			sources.push(source);
		}
	}
	return { sources, truncated: false };
}

export { citationSnippets, isPublicIp, isPublicIpv4, isPublicIpv6, mapAnthropicResponse, pinnedLookup };
