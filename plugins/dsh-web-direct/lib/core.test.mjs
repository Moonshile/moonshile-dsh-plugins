import assert from "node:assert/strict";
import test from "node:test";
import { isPublicIp, mapAnthropicResponse, pinnedLookup } from "./core.js";

test("isPublicIp: accepts real public addresses", () => {
	for (const address of ["172.66.147.243", "104.20.23.154", "123.125.246.121", "8.8.8.8", "172.32.0.1", "2606:4700:10::ac42:93f3"]) {
		assert.equal(isPublicIp(address), true, address);
	}
});

test("isPublicIp: rejects the fake-ip / benchmarking block", () => {
	for (const address of ["198.18.0.1", "198.19.0.1", "198.19.13.38", "198.19.2.211"]) {
		assert.equal(isPublicIp(address), false, address);
	}
});

test("isPublicIp: rejects private, loopback, link-local and CGNAT", () => {
	for (const address of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0"]) {
		assert.equal(isPublicIp(address), false, address);
	}
});

test("isPublicIp: rejects multicast, reserved and TEST-NET blocks", () => {
	for (const address of ["224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255", "192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1"]) {
		assert.equal(isPublicIp(address), false, address);
	}
});

test("isPublicIp: IPv6 special ranges and IPv4-mapped addresses", () => {
	for (const address of ["::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "2002::1", "2001:0::1"]) {
		assert.equal(isPublicIp(address), false, address);
	}
	assert.equal(isPublicIp("::ffff:198.19.13.38"), false);
	assert.equal(isPublicIp("::ffff:172.66.147.243"), true);
	assert.equal(isPublicIp("[2606:4700:10::ac42:93f3]"), true);
});

test("isPublicIp: malformed input is not public", () => {
	for (const address of ["not-an-ip", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.2.3.a", ""]) {
		assert.equal(isPublicIp(address), false, JSON.stringify(address));
	}
});

test("pinnedLookup: serves only the validated addresses", () => {
	const lookup = pinnedLookup([
		{ address: "172.66.147.243", family: 4 },
		{ address: "2606:4700:10::ac42:93f3", family: 6 },
	]);
	const single = lookup("example.com", { family: 0 }, () => {});
	assert.equal(single, undefined);

	let first;
	lookup("example.com", { family: 0 }, (error, address, family) => {
		first = { error, address, family };
	});
	assert.equal(first.error, null);
	assert.equal(first.address, "172.66.147.243");
	assert.equal(first.family, 4);

	let v6;
	lookup("example.com", { family: 6 }, (error, address, family) => {
		v6 = { error, address, family };
	});
	assert.equal(v6.address, "2606:4700:10::ac42:93f3");

	let all;
	lookup("example.com", { all: true, family: 0 }, (error, addresses) => {
		all = { error, addresses };
	});
	assert.equal(all.addresses.length, 2);

	let missing;
	lookup("example.com", { family: 6, all: false }, () => {});
	pinnedLookup([{ address: "172.66.147.243", family: 4 }])("example.com", { family: 6 }, (error) => {
		missing = error;
	});
	assert.equal(missing.code, "ENOTFOUND");
});

test("mapAnthropicResponse: joins citations, dedupes urls, keeps optional fields", () => {
	const blocks = [
		{
			type: "web_search_tool_result",
			content: [
				{ type: "web_search_result", url: "https://a.test", title: "A", page_age: "2026-01-01" },
				{ type: "web_search_result", url: "https://b.test" },
				{ type: "web_search_result", url: "https://a.test", title: "A again" },
			],
		},
		{ type: "text", citations: [{ url: "https://a.test", cited_text: "excerpt a" }, { url: "https://c.test", cited_text: "unused" }] },
	];
	const result = mapAnthropicResponse({ content: blocks });
	assert.deepEqual(result, {
		sources: [
			{ url: "https://a.test", title: "A", snippet: "excerpt a", publishedAt: "2026-01-01" },
			{ url: "https://b.test" },
		],
		truncated: false,
	});
});

test("mapAnthropicResponse: no result block is a provider error", () => {
	assert.throws(
		() => mapAnthropicResponse({ content: [{ type: "text", text: "no search happened" }] }),
		(error) => error.code === "WEB_PROVIDER_ERROR",
	);
});
