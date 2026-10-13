#!/usr/bin/env node
/**
 * Audit a DSH sessions root for `dsh-last-turn-delete` markers and for the two
 * message-source shapes the Session format migration chain refuses.
 *
 * ## Why this exists
 *
 * Session logs are read back through a versioned format chain, and that chain is
 * strict about two things this plugin family touches:
 *
 * 1. `user/message.data.source` — format v3 accepts exactly one plugin wrapper
 *    (`{ kind: "plugin", plugin: <package> }`) and format v4 *refuses* it
 *    ("format v4 message requires a producer-owned source kind"), rewriting it to
 *    `{ kind: "plugin:<package>" }` during the v3→v4 migration. So a plugin that
 *    still writes the v3 wrapper makes its Session unopenable on the next read,
 *    and a reader that only matches the v3 wrapper stops recognizing its own
 *    markers in already-migrated logs.
 * 2. `surfaceOp` on a replaced surface event — format v3 requires exactly
 *    `{ op: "replace", startSeq, endSeq }`; the pre-v3 spelling `{ start, end }`
 *    is converted by the v2→v3 stage and must therefore only exist in files whose
 *    own header declares an older version.
 *
 * Run this before upgrading the host so you know the blast radius: which
 * Sessions must still be readable afterwards, and whether any of them is already
 * unopenable for a reason unrelated to the upgrade.
 *
 * ## Session log encoding
 *
 * A log is a concatenation of independent Zstandard frames (one for the header
 * line, then one per durable append batch). Node's streaming/one-shot zstd
 * decoders stop after the *first* frame, so this script locates every frame
 * magic and decodes each frame separately. A false-positive magic inside
 * compressed payload is handled by retrying with a wider span.
 *
 * ## Usage
 *
 *     node scripts/audit-session-markers.mjs
 *     node scripts/audit-session-markers.mjs --root ~/.dsh/sessions
 *     node scripts/audit-session-markers.mjs --plugin dsh-last-turn-delete --json
 *     node scripts/audit-session-markers.mjs --fail-on-risk   # exit 1 on any risk
 *
 * Read-only: it never writes to a Session log, a storage file, or the host.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_SUFFIX = ".jsonl.zstd";
/** Physical header version that first requires `startSeq`/`endSeq` and the producer-owned source kind family. */
const STRICT_SURFACE_OP_VERSION = 3;
const V4_VERSION = 4;

function parseArgs(argv) {
	const options = {
		root: process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : join(homedir(), ".dsh", "sessions"),
		plugin: "dsh-last-turn-delete",
		json: false,
		failOnRisk: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--root") options.root = argv[++index];
		else if (arg === "--plugin") options.plugin = argv[++index];
		else if (arg === "--json") options.json = true;
		else if (arg === "--fail-on-risk") options.failOnRisk = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`unknown argument "${arg}"`);
	}
	return options;
}

/** Decode every Zstandard frame of one session log into its JSONL text. */
function decodeLog(buffer) {
	const poses = [];
	let cursor = 0;
	while ((cursor = buffer.indexOf(FRAME_MAGIC, cursor)) !== -1) {
		poses.push(cursor);
		cursor += FRAME_MAGIC.length;
	}
	let text = "";
	let failedFrames = 0;
	for (let index = 0; index < poses.length; index += 1) {
		let decoded = false;
		for (let span = 1; span <= 3 && !decoded; span += 1) {
			const end = index + span < poses.length ? poses[index + span] : buffer.length;
			try {
				text += zstdDecompressSync(buffer.subarray(poses[index], end)).toString("utf8");
				decoded = true;
				index += span - 1;
			} catch {
				/* a magic inside compressed payload: widen the span and retry */
			}
		}
		if (!decoded) failedFrames += 1;
	}
	return { text, frames: poses.length, failedFrames };
}

/** Version declared by a canonical generation filename; 0 for the unversioned legacy name. */
function generationVersion(filename) {
	const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(filename);
	return match === null ? 0 : Number(match[1] ?? 0);
}

/** Canonical generation selected at runtime: the numerically highest one. */
function selectGeneration(files) {
	let selected = null;
	for (const file of files) {
		const version = generationVersion(file);
		if (selected === null || version > selected.version) selected = { file, version };
	}
	return selected;
}

function walk(root) {
	const sessions = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const projectDir = join(root, project.name);
		for (const session of readdirSync(projectDir, { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			const dir = join(projectDir, session.name);
			const logs = readdirSync(dir).filter((name) => name.endsWith(LOG_SUFFIX));
			if (logs.length === 0) continue;
			const selected = selectGeneration(logs);
			sessions.push({ dir, logs, selected: { ...selected, path: join(dir, selected.file) } });
		}
	}
	return sessions;
}

function surfaceOpStyle(event) {
	const op = event?.surfaceOp;
	if (op === "append") return "append";
	if (op === undefined) return "absent";
	if (typeof op !== "object" || op === null || Array.isArray(op)) return "invalid";
	if (Object.hasOwn(op, "startSeq") && Object.hasOwn(op, "endSeq")) return "startSeq/endSeq";
	if (Object.hasOwn(op, "start") && Object.hasOwn(op, "end")) return "start/end (pre-v3)";
	return "invalid";
}

function sourceShape(message, plugin) {
	const source = message?.source;
	if (typeof source !== "object" || source === null) return undefined;
	if (source.kind === "plugin" && source.plugin === plugin) return "plugin-wrapper";
	if (source.kind === `plugin:${plugin}`) return "producer-kind";
	if (source.kind === "plugin" && source.name === plugin) return "legacy name/operation";
	return undefined;
}

function auditSession(session, plugin) {
	const { text, frames, failedFrames } = decodeLog(readFileSync(session.selected.path));
	const rows = text
		.split("\n")
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
	const header = rows.find((row) => row?.type === "session");
	const version = typeof header?.version === "number" ? header.version : session.selected.version;
	const findings = { markers: 0, shapes: {}, surfaceOps: {}, risks: [] };
	for (const row of rows) {
		if (row?.type !== "user/message") continue;
		const shape = sourceShape(row.data, plugin);
		if (shape === undefined) continue;
		findings.markers += 1;
		findings.shapes[shape] = (findings.shapes[shape] ?? 0) + 1;
		const style = surfaceOpStyle(row);
		findings.surfaceOps[style] = (findings.surfaceOps[style] ?? 0) + 1;
		if (shape === "legacy name/operation") findings.risks.push(`seq ${row.seq}: marker source carries the retired name/operation shape; every format reader refuses it`);
		if (style === "start/end (pre-v3)" && version >= STRICT_SURFACE_OP_VERSION) findings.risks.push(`seq ${row.seq}: surfaceOp uses start/end in a file declaring version ${version}`);
		if (shape === "plugin-wrapper" && version >= V4_VERSION) findings.risks.push(`seq ${row.seq}: retired plugin wrapper in a version ${version} file; the current reader refuses it`);
	}
	return { ...findings, version, frames, failedFrames, file: session.selected.file.split("/").pop() };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write("usage: node scripts/audit-session-markers.mjs [--root <dir>] [--plugin <name>] [--json] [--fail-on-risk]\n");
		return 0;
	}
	if (!statSync(options.root, { throwIfNoEntry: false })?.isDirectory()) {
		process.stderr.write(`not a sessions directory: ${options.root}\n`);
		return 2;
	}
	const sessions = walk(options.root);
	const affected = [];
	for (const session of sessions) {
		const findings = auditSession(session, options.plugin);
		if (findings.markers > 0) affected.push({ session: session.dir, ...findings });
	}
	const report = {
		root: options.root,
		plugin: options.plugin,
		sessions: sessions.length,
		sessionsWithMarkers: affected.length,
		markers: affected.reduce((sum, entry) => sum + entry.markers, 0),
		sessionsWithRisk: affected.filter((entry) => entry.risks.length > 0).length,
		affected,
	};
	if (options.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return report.sessionsWithRisk > 0 && options.failOnRisk ? 1 : 0;
	}
	process.stdout.write(`sessions root      : ${report.root}\n`);
	process.stdout.write(`marker plugin      : ${report.plugin}\n`);
	process.stdout.write(`sessions scanned   : ${report.sessions}\n`);
	process.stdout.write(`sessions with markers: ${report.sessionsWithMarkers} (${report.markers} marker rows)\n`);
	process.stdout.write(`sessions at risk   : ${report.sessionsWithRisk}\n`);
	for (const entry of affected) {
		const shapes = Object.entries(entry.shapes).map(([key, value]) => `${key}=${value}`).join(" ");
		const ops = Object.entries(entry.surfaceOps).map(([key, value]) => `${key}=${value}`).join(" ");
		process.stdout.write(`\n${entry.session.replace(report.root + "/", "")}\n`);
		process.stdout.write(`  ${entry.file} (declared version ${entry.version}, ${entry.frames} frames)\n`);
		process.stdout.write(`  markers: ${shapes}\n`);
		process.stdout.write(`  surfaceOp: ${ops}\n`);
		for (const risk of entry.risks) process.stdout.write(`  RISK ${risk}\n`);
	}
	if (report.sessionsWithMarkers === 0) process.stdout.write("\nno markers found\n");
	process.stdout.write(
		"\nreminder: the v3→v4 migration rewrites `plugin-wrapper` markers to `producer-kind`,\n" +
			"so a reader that only matches the wrapper stops seeing them after the upgrade.\n",
	);
	return report.sessionsWithRisk > 0 && options.failOnRisk ? 1 : 0;
}

process.exitCode = main();
