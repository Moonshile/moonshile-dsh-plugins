/**
 * In-memory proof that dsh-last-turn-delete's marker source shape keeps a v4
 * session log valid under a real 0.2 kernel.
 *
 * It migrates one real v3 session to v4, appends the plugin's own marker event
 * over a deletable user message, and cold-reads the result with the strict
 * validators; then repeats with the retired `{ kind: "plugin", plugin }` shape
 * as a negative control, and prints what `isDeleteMarker` recognises.
 *
 * Read-only: it never writes the session file it is given.
 *
 * usage:
 *   DSH_TREE=<dir with @deepseek-ai/0.2 packages> \
 *   PLUGIN_DIR=<plugin dir> \
 *   node scripts/plugin-v4-roundtrip-check.mjs <session.v3.jsonl.zstd>
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const DSH = process.env.DSH_TREE ?? "/tmp/dsh-probe/node_modules/@deepseek-ai";
const PLUGIN = process.env.PLUGIN_DIR ?? new URL("../plugins/dsh-last-turn-delete", import.meta.url).pathname;
const catalog = await import(`${DSH}/dsh-session-format-catalog/lib/index.js`);
const misc = await import(`${DSH}/dsh-session-format-v3-to-v4/lib/index.js`);
const pluginCore = await import(`${PLUGIN}/lib/core.js`);
const { sessionFormatCatalog, historicalSessionFormatCatalog, createSessionFormatCatalogWithChildren } = catalog;
const { historicalChildCatalogSource } = misc;

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function frames(buffer) {
  const poses = []; let i = 0;
  while ((i = buffer.indexOf(MAGIC, i)) !== -1) { poses.push(i); i += 4; }
  const out = [];
  for (let k = 0; k < poses.length; k++) {
    const end = k + 1 < poses.length ? poses[k + 1] : buffer.length;
    try { out.push(zstdDecompressSync(buffer.subarray(poses[k], end)).toString("utf8")); } catch {}
  }
  return out;
}

function restoreRows(rows, header, createRestore) {
  const restore = createRestore(header);
  for (const row of rows) restore.decodeRow(row);
  return restore.finish();
}

const path = process.argv[2];
const raw = readFileSync(path);
const parts = frames(raw);
const header = JSON.parse(parts[0].replace(/\n$/, ""));
const rows = parts.slice(1).flatMap((t) => t.split("\n").filter(Boolean)).map((l) => JSON.parse(l));
console.log("源会话:", header.id, "| 声明版本:", header.version, "| 行数:", rows.length);

// 1) 迁移到 v4（生产同款两段式：子会话事实 → child-bound catalog）
const artifact = restoreRows(rows, header, (h) => createSessionFormatCatalogWithChildren([]).createRestore(h, { recovery: "recoverable", validation: "transformed" }));
console.log("迁移后: 版本", artifact.header.version, "| 事件", artifact.events.length, "| inherited", artifact.inheritedEventCount);

// 2) 选一个可删的 append-origin 用户消息节点（不是受保护的系统头）
const target = artifact.events.find((e) => e.type === "user/message" && e.surfaceOp === "append" && e.data?.source?.kind === "user" && e.seq > 0);
if (target === undefined) { console.log("没找到可删节点"); process.exit(0); }
console.log("删除目标: seq", target.seq, "| 文本", JSON.stringify(target.data.content?.[0]?.text ?? "").slice(0, 60));

// 3) 用插件真实代码造标记事件（新形态）
function markerEvent(source, seq, time) {
  const message = pluginCore.deletionMarkerMessage("marker-" + seq);
  message.source = source;
  return { type: "user/message", seq, time, data: message, surfaceOp: { op: "replace", startSeq: target.seq, endSeq: target.seq }, sourceEventSeqs: [target.seq] };
}

function coldRead(events, label, source) {
  const extended = [...events, markerEvent(source, events.length, events.at(-1).time + 1)];
  const toRow = (value) => {
    if (value instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(value).replace(/\n$/, ""));
    if (typeof value === "string") return JSON.parse(value.replace(/\n$/, ""));
    return value;
  };
  const headerRow = toRow(sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount));
  const rowsAll = [headerRow, ...extended.map((e) => toRow(sessionFormatCatalog.encodeCurrentEvent(e)))];
  try {
    const result = restoreRows(rowsAll.slice(1), rowsAll[0], (h) => sessionFormatCatalog.createRestore(h, { recovery: "strict", validation: "current" }));
    console.log(`  [${label}] 严格冷读: ✅ 通过（事件 ${result.events.length}）`);
    return true;
  } catch (error) {
    console.log(`  [${label}] 严格冷读: ❌ 拒绝 — ${error.message}`);
    return false;
  }
}

console.log("\n=== 新形态 source（修复后的插件会写这个）===");
const fresh = markerEvent(pluginCore.deletionMarkerSource(), 0, 0);
console.log("  source =", JSON.stringify(fresh.data.source));
coldRead(artifact.events, "plugin:dsh-last-turn-delete", pluginCore.deletionMarkerSource());

console.log("\n=== 旧形态 source（修复前的插件写的，负向对照）===");
try { coldRead(artifact.events, "plugin wrapper", { kind: "plugin", plugin: "dsh-last-turn-delete" }); }
catch (error) { console.log(`  [plugin wrapper] ❌ 连编码都过不去 — ${error.message}`); }

console.log("\n=== 插件读取端能否认出两代形态（含 v3→v4 迁移后的形状）===");
for (const [label, event] of [
  ["新形态", markerEvent(pluginCore.deletionMarkerSource(), 0, 0)],
  ["迁移后形态（迁移把 plugin 展平成 plugin:<name>）", markerEvent({ kind: "plugin:dsh-last-turn-delete" }, 0, 0)],
  ["迁移前形态", markerEvent({ kind: "plugin", plugin: "dsh-last-turn-delete" }, 0, 0)],
  ["更老的 name/operation 形态", markerEvent({ kind: "plugin", name: "dsh-last-turn-delete", operation: "delete" }, 0, 0)],
]) console.log(`  ${label}: isDeleteMarker = ${pluginCore.isDeleteMarker(event)}`);
