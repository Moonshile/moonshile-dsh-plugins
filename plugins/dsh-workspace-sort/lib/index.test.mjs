import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSortedOrder } from "./index.js";

test("按活动降序排列", () => {
	const activity = new Map([
		["a", 200],
		["b", 100],
		["c", 50],
	]);
	assert.deepEqual(computeSortedOrder(["a", "b", "c"], activity), ["a", "b", "c"]);
	assert.deepEqual(computeSortedOrder(["c", "b", "a"], activity), ["a", "b", "c"]);
});

test("活动未知或并列时保持原相对顺序（稳定排序）", () => {
	const activity = new Map([["b", 100]]);
	// b 有活动置顶；a/c/d 未知(0)，保持原相对顺序 c, a, d
	assert.deepEqual(computeSortedOrder(["c", "a", "b", "d"], activity), ["b", "c", "a", "d"]);
});

test("空列表 / 单元素", () => {
	assert.deepEqual(computeSortedOrder([], new Map()), []);
	assert.deepEqual(computeSortedOrder(["x"], new Map()), ["x"]);
});
