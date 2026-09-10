#!/usr/bin/env node
/**
 * Repair the format-invalid deletion-marker source written by
 * `dsh-last-turn-delete` 0.1.0 into durable Session logs.
 *
 * ## Why this exists
 *
 * `lib/core.js` used to write its deletion marker as
 * `source: { kind: "plugin", name: "dsh-last-turn-delete", operation: "delete" }`.
 * The DSH Session format admits exactly one plugin message-source shape —
 * `{ kind: "plugin", plugin: <package name>, form?, sections?, summary? }`
 * (`@deepseek-ai/dsh-llm` `MessageSourceMap`, enforced on read by
 * `@deepseek-ai/dsh-session-format-v0-to-v1`). Every `user/message` row
 * carrying that invented `name`/`operation` source therefore makes the whole
 * Session unloadable:
 *
 *     failed to observe session "...": @deepseek-ai/dsh-session-format-v0-to-v1
 *     refuses this format v0 Session: user/message <seq> source has unexpected
 *     member "name"; source v0 artifact remains unchanged
 *
 * The plugin now writes the valid shape, and `isDeleteMarker` still recognizes
 * the old one — but a Session the format validator refuses never reaches a
 * marker reader at all. The durable row itself has to change.
 *
 * ## What it does
 *
 * Rewrites exactly those `user/message` rows whose `data.source` carries the
 * legacy shape, and nothing else. Everything else is preserved byte for byte
 * within its row: the `version: 0` header (so DSH's own migration chain still
 * owns the upgrade), the framing, and the row order. The rewritten container
 * keeps the one structural invariant the reader asserts — frame 0 holds
 * exactly the header line — and every frame stays independently decodable and
 * checksummed, exactly as the persistence backend writes them.
 *
 * Before a repaired file replaces the original, it is frozen in memory, then
 * run through the installed DSH format catalog (the same adjacent migration
 * chain plus released validation the host uses on open). A file that does not
 * restore is discarded and the original is left untouched.
 *
 * ## Usage
 *
 *     node scripts/repair-deletion-marker-source.mjs <path...>              # dry run
 *     node scripts/repair-deletion-marker-source.mjs --apply <path...>      # repair
 *
 * A path may be a session directory, a `session.jsonl.zstd` file, or a
 * sessions root (scanned recursively). The original is copied to
 * `session.jsonl.zstd.repair-backup-<timestamp>` before replacement. Running
 * it twice is a no-op: repaired rows no longer match.
 */
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const LOG_SUFFIX = ".jsonl.zstd";
const LEGACY_PLUGIN_NAME = "dsh-last-turn-delete";
const LEGACY_SOURCE_KEYS = ["kind", "name", "operation"];
const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * Resolve the installed DSH format catalog. The repair depends on the host's
 * own reader, so a missing harness is a hard error rather than a skipped check.
 * @returns the build-static catalog module namespace.
 */
async function loadCatalog() {
	const override = process.env.DSH_SESSION_FORMAT_CATALOG;
	const candidates = override === undefined
		? [
			"@deepseek-ai/dsh-session-format-catalog",
			"/Users/duankaiqiang/.nvm/versions/node/v26.5.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js"
		]
		: [override];
	const failures = [];
	for (const candidate of candidates) {
		try {
			return await import(candidate);
		} catch (error) {
			failures.push(`${candidate}: ${error.message}`);
		}
	}
	throw new Error(`cannot load @deepseek-ai/dsh-session-format-catalog\n  ${failures.join("\n  ")}`);
}

/** Locate complete concatenated Zstandard frames (mirrors the JSONL backend). */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) throw new Error(`torn Zstandard frame header at byte ${offset}`);
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
		offset += 4;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		for (;;) {
			if (buffer.length - offset < 3) throw new Error(`torn Zstandard block header at byte ${offset}`);
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`);
			offset += blockType === 1 ? 1 : blockSize;
			if (lastBlock) break;
		}
		if (checksum) offset += 4;
		frames.push({ start, end: offset });
	}
	return frames;
}

/**
 * Decode the concatenated-frame container into its plaintext JSONL text.
 * @param buffer - complete `.jsonl.zstd` bytes.
 * @returns the decoded JSONL text.
 */
function decodeContainer(buffer) {
	const frames = scanZstdFrames(buffer);
	const parts = frames.map(({ start, end }, index) => {
		try {
			return zstdDecompressSync(buffer.subarray(start, end));
		} catch (error) {
			throw new Error(`Zstandard frame ${index} at byte ${start} failed validation`, { cause: error });
		}
	});
	return Buffer.concat(parts).toString("utf8");
}

/**
 * Whether a parsed row is exactly the legacy marker this tool corrects: one
 * `user/message` surface replacement whose `data.source` is
 * `{ kind: "plugin", name: "dsh-last-turn-delete", operation: "delete" }` and
 * carries no other member.
 * @param row - parsed physical row.
 * @returns true when the row carries the invalid plugin source.
 */
function hasLegacySource(row) {
	if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
	if (row.type !== "user/message") return false;
	const data = row.data;
	if (data === null || typeof data !== "object") return false;
	const source = data.source;
	if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
	const keys = Object.keys(source);
	if (keys.length !== LEGACY_SOURCE_KEYS.length) return false;
	for (const key of LEGACY_SOURCE_KEYS) if (!Object.hasOwn(source, key)) return false;
	return source.kind === "plugin"
		&& source.name === LEGACY_PLUGIN_NAME
		&& source.operation === "delete";
}

/**
 * Rewrite one decoded JSONL text, correcting the legacy marker source on the
 * affected rows only.
 * @param text - decoded JSONL text (no requirement on a trailing newline).
 * @returns `{ text, rewritten, seqs }` with the repaired text (newline-terminated).
 */
function repairText(text) {
	const hadTrailingNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (hadTrailingNewline) lines.pop();
	const seqs = [];
	const rewritten = lines.map((line, index) => {
		if (line.trim() === "") return line;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			// A row that is not valid JSON is not this tool's business: leave it
			// byte-identical so any pre-existing corruption stays visible.
			return line;
		}
		if (!hasLegacySource(row)) return line;
		row.data.source = { kind: "plugin", plugin: LEGACY_PLUGIN_NAME };
		seqs.push(typeof row.seq === "number" ? row.seq : index);
		return JSON.stringify(row);
	});
	return { text: `${rewritten.join("\n")}\n`, rewritten: seqs.length, seqs };
}

/**
 * Encode repaired JSONL text as the backend's container: frame 0 is exactly
 * the header line, frame 1 carries every event row.
 * @param text - repaired JSONL text, newline-terminated.
 * @returns the encoded `.jsonl.zstd` bytes.
 */
function encodeContainer(text) {
	const boundary = text.indexOf("\n");
	if (boundary < 0) throw new Error("repaired log has no header line");
	const headerLine = Buffer.from(text.slice(0, boundary + 1), "utf8");
	const eventBytes = Buffer.from(text.slice(boundary + 1), "utf8");
	const frames = [zstdCompressSync(headerLine, CHECKSUM_OPTIONS)];
	if (eventBytes.length > 0) frames.push(zstdCompressSync(eventBytes, CHECKSUM_OPTIONS));
	return Buffer.concat(frames);
}

/**
 * Run one decoded text through the installed migration chain and released
 * current validation, exactly as the host does when it opens the log.
 * @param sessionFormatCatalog - the installed catalog.
 * @param text - candidate JSONL text.
 * @returns the restored event count.
 */
function restoreWithCatalog(sessionFormatCatalog, text) {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) throw new Error("empty session log");
	const header = JSON.parse(lines[0]);
	const restore = sessionFormatCatalog.createRestore(header, {
		recovery: "strict",
		validation: "transformed"
	});
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "") continue;
		restore.decodeRow(JSON.parse(lines[index]));
	}
	return restore.finish().events.length;
}

/**
 * Collect every candidate session log path below the given arguments.
 * @param paths - files, session directories, or sessions roots.
 * @returns sorted unique log file paths.
 */
function collectLogs(paths) {
	const found = new Set();
	const visit = (path) => {
		const info = statSync(path, { throwIfNoEntry: false });
		if (info === undefined) throw new Error(`path does not exist: ${path}`);
		if (info.isFile()) {
			if (!path.endsWith(LOG_SUFFIX)) throw new Error(`not a session log: ${path}`);
			found.add(resolve(path));
			return;
		}
		// A session directory holds the log itself; a sessions root holds
		// per-session directories, so accept both depths.
		const direct = join(path, `session${LOG_SUFFIX}`);
		if (statSync(direct, { throwIfNoEntry: false })?.isFile() === true) found.add(resolve(direct));
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			visit(join(path, entry.name));
		}
	};
	for (const path of paths) visit(resolve(path));
	return [...found].sort();
}

/**
 * Repair one session log.
 * @param catalog - the installed format catalog.
 * @param logPath - the `.jsonl.zstd` file to inspect.
 * @param apply - whether to write the repaired log.
 * @returns a summary record for reporting.
 */
function repairLog(catalog, logPath, apply) {
	const original = readFileSync(logPath);
	const decoded = decodeContainer(original);
	const { text, rewritten, seqs } = repairText(decoded);
	if (rewritten === 0) return { logPath, status: "clean", rewritten: 0, seqs };

	const restoredEvents = restoreWithCatalog(catalog, text);
	const repaired = encodeContainer(text);
	// The repaired bytes must round-trip to exactly the text that was verified.
	const check = decodeContainer(repaired);
	if (check !== text) throw new Error("repaired container does not round-trip to the verified text");
	if (!apply) return { logPath, status: "would-repair", rewritten, seqs, restoredEvents };

	const backupPath = `${logPath}.repair-backup-${Date.now()}`;
	copyFileSync(logPath, backupPath);
	const stagedPath = `${logPath}.repair-staged-${process.pid}`;
	try {
		writeFileSync(stagedPath, repaired);
		renameSync(stagedPath, logPath);
	} catch (error) {
		if (statSync(stagedPath, { throwIfNoEntry: false }) !== undefined) unlinkSync(stagedPath);
		throw error;
	}
	return {
		logPath,
		status: "repaired",
		rewritten,
		seqs,
		restoredEvents,
		backupPath,
		originalBytes: original.length,
		repairedBytes: repaired.length,
		originalDigest: createHash("sha256").update(original).digest("hex").slice(0, 12),
		repairedDigest: createHash("sha256").update(repaired).digest("hex").slice(0, 12)
	};
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const targets = argv.filter((argument) => argument !== "--apply");
if (targets.length === 0) {
	console.error("usage: repair-deletion-marker-source.mjs [--apply] <path...>");
	console.error("  <path> is a session directory, a session.jsonl.zstd file, or a sessions root");
	process.exit(2);
}

const { sessionFormatCatalog } = await loadCatalog();
const logs = collectLogs(targets);
console.log(`${apply ? "Repairing" : "Dry run over"} ${logs.length} session log(s)`);

let cleaned = 0;
let repaired = 0;
const failures = [];
for (const logPath of logs) {
	try {
		const result = repairLog(sessionFormatCatalog, logPath, apply);
		if (result.status === "clean") {
			cleaned += 1;
			continue;
		}
		repaired += 1;
		const label = result.status === "repaired" ? "repaired" : "would repair";
		console.log(`  ${label}: ${logPath}`);
		console.log(`    rows rewritten: ${result.rewritten} (seq ${result.seqs.join(", ")})`);
		console.log(`    restored events: ${result.restoredEvents}`);
		if (result.backupPath !== undefined) {
			console.log(`    backup: ${basename(result.backupPath)} (${result.originalBytes} -> ${result.repairedBytes} bytes)`);
			console.log(`    sha256: ${result.originalDigest} -> ${result.repairedDigest}`);
		}
	} catch (error) {
		failures.push({ logPath, message: error.message });
		console.error(`  FAILED: ${logPath}`);
		console.error(`    ${error.message}`);
	}
}

console.log(
	`${apply ? "Repaired" : "Repairable"}: ${repaired}  clean: ${cleaned}  failed: ${failures.length}`
);
if (failures.length > 0) process.exit(1);
if (!apply && repaired > 0) console.log("Re-run with --apply to write the repairs.");
