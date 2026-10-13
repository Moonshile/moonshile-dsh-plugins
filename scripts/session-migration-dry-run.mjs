/**
 * Offline dry-run of the DSH session-format migration (v0/v1/v2/v3 → v4).
 *
 * Read-only: it decodes each session log, replays the *production* restore flow
 * against the target build's format catalog, and reports which sessions would
 * open and which would be refused. Nothing is written — no successor
 * generation, no lock file, no storage change.
 *
 * The flow mirrors dsh-session-persistence-jsonl's `prepareStoredMigration`:
 *   1. child facts: every session with header.origin === "subagent" and
 *      header.parentSession === <id> is decoded with the historical (version<=3)
 *      or current catalog at { recoverable, current } and reduced through
 *      `historicalChildCatalogSource`; a child that fails contributes an
 *      "unavailable descriptor" fact instead of failing the parent.
 *   2. the session itself: createSessionFormatCatalogWithChildren(facts)
 *      .createRestore(header, { recoverable, transformed }), every row after the
 *      header line fed through decodeRow(), then finish().
 *
 * Usage:
 *   node scripts/session-migration-dry-run.mjs --dsh <target dsh package dir> \
 *        [--root <sessions root>] [--limit N] [--verbose] [--json-out <file>]
 *
 *   `--dsh` is the *target* build's `@deepseek-ai/dsh` package directory, e.g.
 *   `/tmp/dsh-probe-020/node_modules/@deepseek-ai/dsh` for 0.2.0-rc.2, or the
 *   globally installed one for the version you run today. Run it against both:
 *   sessions that fail only on the target build are the real upgrade risk, while
 *   sessions failing on both are already broken today.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createRequire } from "node:module";

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function parseArgs(argv) {
	const options = { dsh: null, root: join(process.env.HOME, ".dsh", "sessions"), limit: 0, verbose: false, jsonOut: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dsh") options.dsh = argv[++index];
		else if (arg === "--root") options.root = argv[++index];
		else if (arg === "--limit") options.limit = Number(argv[++index]);
		else if (arg === "--verbose") options.verbose = true;
		else if (arg === "--json-out") options.jsonOut = argv[++index];
		else throw new Error(`unknown argument ${arg}`);
	}
	if (options.dsh === null) throw new Error("--dsh <installed 0.2 dsh package dir> is required");
	return options;
}

/** Split a concatenated multi-frame Zstandard log into its JSONL text, frame by frame. */
function* frames(buffer) {
	const poses = [];
	let cursor = 0;
	while ((cursor = buffer.indexOf(FRAME_MAGIC, cursor)) !== -1) {
		poses.push(cursor);
		cursor += FRAME_MAGIC.length;
	}
	for (let index = 0; index < poses.length; index += 1) {
		let done = false;
		for (let span = 1; span <= 3 && !done; span += 1) {
			const end = index + span < poses.length ? poses[index + span] : buffer.length;
			try {
				yield { index, text: zstdDecompressSync(buffer.subarray(poses[index], end)).toString("utf8"), torn: false };
				index += span - 1;
				done = true;
			} catch {
				/* false-positive magic inside payload: widen the span */
			}
		}
		if (!done) yield { index, text: "", torn: true };
	}
}

function generationVersion(filename) {
	const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(filename);
	return match === null ? 0 : Number(match[1] ?? 0);
}

function selectGeneration(files) {
	let selected = null;
	for (const file of files) {
		const version = generationVersion(file);
		if (selected === null || version > selected.version) selected = { file, version };
	}
	return selected;
}

function readHeader(path) {
	const buffer = readFileSync(path);
	for (const frame of frames(buffer)) {
		if (frame.torn) continue;
		const line = frame.text.split("\n")[0];
		return JSON.parse(line);
	}
	throw new Error("no decodable header frame");
}

/**
 * Feed one generation through a restore created by `createRestore`.
 * Mirrors MigratingJsonlRows.consume: unparsable rows are recorded and skipped;
 * once an issue is recorded, later rows stay skipped until a turn/end row
 * rethrows the original issue.
 */
function restoreGeneration(path, version, catalogModule, createRestore) {
	const buffer = readFileSync(path);
	let header = null;
	let restore = null;
	let issue = null;
	let rows = 0;
	let tornTail = false;
	let framesSeen = 0;
	for (const frame of frames(buffer)) {
		if (issue !== null) break;
		if (frame.index === 0) {
			if (frame.torn) throw new Error("header frame is not decodable");
			const value = JSON.parse(frame.text.replace(/\n$/, ""));
			const storedVersion = value.version;
			if (storedVersion !== version) throw new Error(`filename identifies v${version} but the header identifies v${storedVersion}`);
			header = value;
			restore = createRestore(header);
			framesSeen += 1;
			continue;
		}
		framesSeen += 1;
		if (frame.torn) {
			tornTail = true;
			break;
		}
		for (const line of frame.text.split("\n")) {
			if (line === "") continue;
			rows += 1;
			let row;
			try {
				row = JSON.parse(line);
			} catch (error) {
				issue ??= error;
				continue;
			}
			if (issue !== null) {
				if (typeof row === "object" && row !== null && row.type === "turn/end") throw issue;
				continue;
			}
			restore.decodeRow(row);
		}
	}
	if (restore === null) throw new Error("empty or header-less session log");
	const artifact = restore.finish();
	return { artifact, header, rows, frames: framesSeen, tornTail };
}

function collectGenerations(root) {
	const sessions = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const projectDir = join(root, project.name);
		for (const session of readdirSync(projectDir, { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			const dir = join(projectDir, session.name);
			const logs = readdirSync(dir).filter((name) => name.endsWith(".jsonl.zstd"));
			if (logs.length === 0) continue;
			const selected = selectGeneration(logs);
			sessions.push({ dir, file: selected.file, version: selected.version, path: join(dir, selected.file), project: project.name });
		}
	}
	return sessions;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const require = createRequire(join(options.dsh, "package.json"));
	const catalogPath = require.resolve("@deepseek-ai/dsh-session-format-catalog");
	const catalog = await import(catalogPath);
	const misc = await (async () => { try { return await import(require.resolve("@deepseek-ai/dsh-session-format-v3-to-v4")); } catch { return {}; } })();
	const { sessionFormatCatalog, historicalSessionFormatCatalog, createSessionFormatCatalogWithChildren } = catalog;
	const { historicalChildCatalogSource } = misc;
	const childBound = typeof createSessionFormatCatalogWithChildren === "function" && typeof historicalChildCatalogSource === "function";

	const sessions = collectGenerations(options.root);
	const index = new Map();
	for (const session of sessions) {
		let header;
		try {
			header = readHeader(session.path);
		} catch (error) {
			session.headerError = String(error?.message ?? error);
			continue;
		}
		session.header = header;
		index.set(header.id, session);
	}
	const childrenOf = new Map();
	for (const session of sessions) {
		const header = session.header;
		if (header === undefined || header.origin !== "subagent") continue;
		const parent = header.parentSession;
		if (parent === undefined) continue;
		if (!childrenOf.has(parent)) childrenOf.set(parent, []);
		childrenOf.get(parent).push(session);
	}

	const report = { root: options.root, dsh: options.dsh, catalogVersion: sessionFormatCatalog.readHeader !== undefined, generatedAt: new Date().toISOString(), totals: {}, failures: [], childWarnings: [], tornTails: [], migrated: 0 };
	let processed = 0;
	for (const session of sessions) {
		if (options.limit > 0 && processed >= options.limit) break;
		processed += 1;
		const label = `${session.project}/${basename(session.dir)}/${session.file}`;
		if (session.headerError !== undefined) {
			report.failures.push({ session: label, error: session.headerError, stage: "header" });
			continue;
		}
		const facts = [];
		for (const child of childBound ? childrenOf.get(session.header.id) ?? [] : []) {
			try {
				const { artifact } = restoreGeneration(child.path, child.version, child.version <= 3 ? historicalSessionFormatCatalog : sessionFormatCatalog, (header) => (child.version <= 3 ? historicalSessionFormatCatalog : sessionFormatCatalog).createRestore(header, { recovery: "recoverable", validation: "current" }));
				facts.push({ ...historicalChildCatalogSource(artifact), sourcePath: child.path });
			} catch (error) {
				report.childWarnings.push({ session: label, child: basename(child.dir), error: String(error?.message ?? error) });
				facts.push({ childId: child.header.id, childCreatedAt: child.header.createdAt, descriptorCount: 0, descriptor: null, sourcePath: child.path });
			}
		}
		try {
			const bound = childBound ? createSessionFormatCatalogWithChildren(facts) : null;
			const createRestore = (header) => (bound === null ? sessionFormatCatalog : bound).createRestore(header, { recovery: "recoverable", validation: "transformed" });
			const result = restoreGeneration(session.path, session.version, catalog, createRestore);
			report.migrated += 1;
			if (result.tornTail) report.tornTails.push({ session: label, note: "last frame undecodable (torn tail) — production recovers the complete records before it" });
			if (options.verbose) process.stderr.write(`ok    ${label} rows=${result.rows} events=${result.artifact.events.length}\n`);
		} catch (error) {
			report.failures.push({ session: label, error: String(error?.message ?? error), stage: "migrate", version: session.version, kind: error?.constructor?.name });
		}
	}
	report.childBound = childBound;
	report.totals = {
		sessions: sessions.length,
		processed,
		migrated: report.migrated,
		failed: report.failures.length,
		childWarnings: report.childWarnings.length,
		tornTails: report.tornTails.length,
	};
	if (options.jsonOut !== null) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(options.jsonOut, JSON.stringify(report, null, 2));
		process.stderr.write(`written ${options.jsonOut}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	}
}

await main();
