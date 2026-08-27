/**
 * dsh-workspace-sort — host plugin: 侧边栏工作区顺序**每日**按最近活动刷新一次。
 *
 * DSH 原生的工作区顺序是手动拖拽（`workspaceIds` 持久数组），"Last updated"
 * 视图选项只作用于组内会话排序。本插件在宿主侧监听 `session/event`（会话
 * append feed）累计各工作区的最近活动时间，并且**每天最多重排一次**：
 * 日历日的第一次活动触发一次全量排序（按累计活动降序，未记录活动的工作区
 * 保持原相对顺序），当天其余时间顺序完全稳定，不再频繁跳动。
 *
 * 设计取舍：
 * - 每天一次全量排序：解决"顺序频繁变动"的痛点；早上打开侧栏即为截至
 *   昨天的活动顺序。
 * - 排序依据：本插件自启动以来累计的 `session/event` 活动时间。服务器在
 *   当天重启后，当天的首次排序可能因活动样本不足而较弱，次日起即准确
 *   （累计了一整天）。
 * - 持久化：`~/.dsh/workspace-sort-state.json` 记录上次排序日期（可用
 *   `DSH_HOME` 环境变量覆盖家目录）。
 * - 与手动拖拽互斥：排序日会把工作区按活动重排——这是本插件的既定语义；
 *   当天内手动拖拽的顺序不会被自动改动，第二天刷新时会再次按活动重排。
 * - 不参与未归属（ungrouped）会话；排序失败仅记日志，不影响会话本身。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** 本插件依赖的服务。 */
const inject = ["workspaceRegistry"];

/** 状态文件名（放在 DSH 家目录下）。 */
const STATE_FILENAME = "workspace-sort-state.json";

function stateFilePath() {
	const home = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
	return path.join(home, STATE_FILENAME);
}

async function loadState(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return {};
	}
}

async function saveState(file, state) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(state));
}

/** 本地日历日（UTC 日期即可，跨日边界以第一个活动为准）。 */
function today() {
	return new Date().toISOString().slice(0, 10);
}

/**
 * 按活动时间降序排列工作区 id。JS 的 Array#sort 是稳定排序，因此活动未知
 * 或并列的工作区保持原相对顺序。纯函数，便于测试。
 * @param ids - 当前顺序的工作区 id 列表。
 * @param activity - Map<workspaceId, lastActivityMs>。
 * @returns 排序后的 id 列表。
 */
export function computeSortedOrder(ids, activity) {
	return [...ids].sort((a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0));
}

function apply(ctx) {
	const info = (...args) => ctx.logger?.info("[workspace-sort]", ...args);
	const warn = (...args) => ctx.logger?.warn("[workspace-sort]", ...args);

	/** workspaceId -> 最近活动时间（ms）。 */
	const activity = new Map();
	const stateFile = stateFilePath();
	/** 上次完成排序的日期；"" 表示从未排过（空状态文件）。 */
	let lastSortedDate = "";
	let sorting = false;

	loadState(stateFile)
		.then((state) => {
			lastSortedDate = state.lastSortedDate ?? "";
		})
		.catch(() => {
			lastSortedDate = "";
		});

	/**
	 * 全量排序：把工作区重排为 sorted 顺序。逐位纠正，每次 `insertBefore`
	 * 都返回提交后的完整顺序并作为下一次的基准；失败即中止，次日重试。
	 */
	async function sortAll() {
		if (sorting) return;
		sorting = true;
		try {
			const list = ctx.workspaceRegistry.list();
			const order = list.map((workspace) => workspace.id);
			if (order.length < 2) return;
			const sorted = computeSortedOrder(order, activity);
			let current = order;
			for (let i = 0; i < sorted.length; i++) {
				if (current[i] === sorted[i]) continue;
				const j = current.indexOf(sorted[i]);
				if (j === -1) continue;
				current = await ctx.workspaceRegistry.insertBefore(current[j], current[i]);
			}
			info(`daily re-sort done (${order.length} workspaces)`);
		} catch (err) {
			warn("daily re-sort failed:", err?.message ?? err);
		} finally {
			sorting = false;
		}
	}

	async function onActivity(workspaceId) {
		activity.set(workspaceId, Date.now());
		if (lastSortedDate === today()) return; // 今天已排过，保持稳定
		await sortAll();
		lastSortedDate = today();
		activity.clear();
		activity.set(workspaceId, Date.now());
		try {
			await saveState(stateFile, { lastSortedDate });
		} catch (err) {
			warn("state save failed:", err?.message ?? err);
		}
	}

	ctx.on("session/event", (session) => {
		let owner = null;
		try {
			for (const workspace of ctx.workspaceRegistry.list()) {
				if (workspace.sessionIds.includes(session.id)) {
					owner = workspace;
					break;
				}
			}
		} catch {
			return;
		}
		if (owner === null) return; // ungrouped
		onActivity(owner.id).catch((err) => warn("activity handling failed:", err?.message ?? err));
	});

	info("plugin active (daily workspace sort)");
}

export { inject, apply };
