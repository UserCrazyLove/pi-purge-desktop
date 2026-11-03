"use strict";
/**
 * PI Purge — PI-Desktop host-side plugin entry.
 *
 * CommonJS on purpose (`.cjs`): this plugin lives inside a repository whose
 * package.json declares `"type": "module"`, and a `.js` entry would then be loaded as
 * ESM, where `module.exports` does not exist. PI-Desktop's own pi-extension importer
 * writes `main.cjs` for the same reason.
 *
 * Responsibilities:
 *   1. own the control panel (`ui.panel`) and answer its `pluginBridge` calls;
 *   2. keep the shared state directory that the agent extension
 *      (`extensions/pi-purge.extension.mjs`) reads and writes;
 *   3. register the two host commands that work without opening the panel.
 *
 * It never rewrites a system prompt itself — that hook lives in the agent sidecar. The two
 * halves meet on two files: `config.json` (last writer wins) and `status.json` (written by
 * the extension, read here for the panel).
 */
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ID = "local.pi-purge";
const VERSION = "0.2.4";
const EMBEDDED = "embedded";
const MODES = ["strict", "replace", "append"];

const PLUGIN_DIR = __dirname;
const EMBEDDED_PERSONA_FILE = path.join(PLUGIN_DIR, "persona", "embedded.md");

const COMMAND_OPEN = "pi-purge.openPanel";
const COMMAND_TOGGLE = "pi-purge.toggle";

/** Preview size, and the size above which a persona file is read only partially. */
const PREVIEW_CHARS = 4000;
const MAX_PERSONA_BYTES = 512 * 1024;

const MODES_INFO = [
	{
		id: "strict",
		title: "strict",
		summary: "只发人设 + 工作目录",
		detail: "宿主系统提示词整段丢掉。工具 schema 走 API 的 tools 参数，所以工具照旧可用。默认模式，变量最干净。",
	},
	{
		id: "replace",
		title: "replace",
		summary: "清掉身份句与内置文档段",
		detail: "按固定文案切除宿主身份句与 pi 文档段，工具说明和项目上下文保留。宿主改了文案时退化为 append，不会切坏。",
	},
	{
		id: "append",
		title: "append",
		summary: "只把人设挂到头部",
		detail: "宿主提示词原样保留。改动最小，也最弱——后面的宿主段落仍然有分量。",
	},
];

/* --- state directory ------------------------------------------------------- */

/**
 * Where the shared state lives, and why it is not a folder inside the plugin directory.
 *
 * PI-Desktop watches a development plugin's directory recursively: a state file written
 * there looks like a source edit, the host reloads the plugin, the reload writes state
 * again. So the first choice is the host's own per-plugin data directory (the path
 * `pi.plugin.getDataPath()` returns, by default `<pi-desktop>/plugins/data/<plugin id>`),
 * which the watcher does not cover. The plugin's own `state/` directory stays as a fallback
 * for a read-only data directory, and the last resort derives `<plugins root>/data/<id>`
 * from the plugin's own path.
 *
 * The agent extension resolves the same list in the same order, with the same
 * "first directory that really accepts a write" rule.
 */
const os = require("node:os");
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".pi-desktop", "plugins", "data", PLUGIN_ID);
/** Next to the manifest; written only when the host keeps its data somewhere else. */
const POINTER_FILE = path.join(PLUGIN_DIR, "state-location.json");
/** Filled from `pi.plugin.getDataPath()` in onLoad; empty until then. */
let hostDataDir = "";

function stateDirCandidates() {
	const dirs = [];
	if (hostDataDir) dirs.push(hostDataDir);
	dirs.push(DEFAULT_DATA_DIR);
	dirs.push(path.join(PLUGIN_DIR, "state"));
	dirs.push(path.join(path.dirname(path.dirname(PLUGIN_DIR)), "data", PLUGIN_ID));
	// Deduplicated: the host usually answers with exactly the default layout, and the panel
	// shows this list when no candidate is writable.
	return [...new Set(dirs)];
}

/**
 * Tell the extension where the host keeps this plugin's data, but only when that differs
 * from the layout it already assumes: writing the pointer file touches the plugin
 * directory, which for a development plugin means a reload.
 */
function writeStatePointer() {
	const target = hostDataDir || DEFAULT_DATA_DIR;
	if (target === DEFAULT_DATA_DIR) return;
	const text = `${JSON.stringify({ stateDir: target, note: "written by main.cjs: the host keeps plugin data elsewhere" }, null, 2)}\n`;
	try {
		const current = fs.existsSync(POINTER_FILE) ? fs.readFileSync(POINTER_FILE, "utf8") : "";
		if (current !== text) writeAtomic(POINTER_FILE, text);
	} catch {
		/* the default layout is still in the candidate list */
	}
}

function writableDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		// A pid-suffixed marker: the extension probes the same candidates, and two processes
		// sharing one marker name could delete each other's probe mid-write and then disagree
		// about which directory is usable for the rest of their lives.
		const probe = path.join(dir, `.pi-purge-probe-${process.pid}`);
		fs.writeFileSync(probe, "", "utf8");
		fs.unlinkSync(probe);
		return true;
	} catch {
		return false;
	}
}

let stateDir = "";
function resolveStateDir() {
	if (stateDir) return stateDir;
	for (const dir of stateDirCandidates()) {
		if (!writableDir(dir)) continue;
		stateDir = dir;
		return dir;
	}
	return "";
}

const configFile = () => path.join(resolveStateDir() || stateDirCandidates()[0], "config.json");
const statusFile = () => path.join(resolveStateDir() || stateDirCandidates()[0], "status.json");

/* --- small file helpers ----------------------------------------------------- */

/**
 * Write through a temporary name and rename, so the extension never reads a half file.
 *
 * Windows can refuse the replace for a moment while a scanner, indexer or backup tool
 * holds a handle without `FILE_SHARE_DELETE`; retry once, then clean up the temp file
 * rather than leave litter behind.
 */
function writeAtomic(file, text) {
	const temp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temp, text, "utf8");
	try {
		fs.renameSync(temp, file);
	} catch (first) {
		try {
			fs.renameSync(temp, file);
		} catch {
			try {
				fs.unlinkSync(temp);
			} catch {
				/* nothing left to clean up */
			}
			throw first;
		}
	}
}

/**
 * Read a JSON object. `error` distinguishes "the file is not there" from "the file is
 * there but unreadable", because treating the second as the first would silently replace
 * a user's mode and persona with defaults.
 */
function readJsonFile(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (cause) {
		const missing = cause && cause.code === "ENOENT";
		return { value: null, exists: !missing, error: missing ? "" : String(cause && cause.message ? cause.message : cause) };
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, exists: true, error: "不是一个 JSON 对象" };
		return { value: parsed, exists: true, error: "" };
	} catch (cause) {
		return { value: null, exists: true, error: `JSON 解析失败：${cause && cause.message ? cause.message : cause}` };
	}
}

/* --- configuration ---------------------------------------------------------- */

/** Defaults used only when the file is absent; a corrupt file is reported, never merged. */
const DEFAULTS = { enabled: false, mode: "strict", source: EMBEDDED };

function readConfigFile() {
	const read = readJsonFile(configFile());
	if (!read.exists) return { stored: {}, exists: false, error: "" };
	return { stored: read.value ?? {}, exists: true, error: read.error };
}

function readConfig() {
	const { stored, exists, error } = readConfigFile();
	const config = {
		enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULTS.enabled,
		mode: MODES.includes(stored.mode) ? stored.mode : DEFAULTS.mode,
		source: typeof stored.source === "string" && stored.source.trim() ? stored.source.trim() : DEFAULTS.source,
		updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : "",
		updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
	};
	return { config, exists, error };
}

/** Merge a patch into the file and return the stored result. Refuses a corrupt file. */
function updateConfig(patch, writer) {
	const current = readConfigFile();
	if (current.error) {
		const error = new Error(`config.json 已损坏，先修好或删掉它：${current.error}`);
		error.code = "CONFIG_CORRUPT";
		throw error;
	}
	const next = { ...current.stored };
	for (const key of ["enabled", "mode", "source"]) {
		if (patch[key] !== undefined) next[key] = patch[key];
	}
	next.updatedBy = writer;
	next.updatedAt = new Date().toISOString();
	const dir = resolveStateDir();
	if (!dir) {
		const error = new Error(`state 目录不可写：${stateDirCandidates().join(" / ")}`);
		error.code = "STATE_NOT_WRITABLE";
		throw error;
	}
	writeAtomic(path.join(dir, "config.json"), `${JSON.stringify(next, null, 2)}\n`);
	return readConfig().config;
}

/**
 * Normalise a persona source. A relative path is resolved here, on the host side, so both
 * processes work on the same absolute file instead of resolving it against two different
 * working directories.
 */
function normalizeSource(value) {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return EMBEDDED;
	if (trimmed.toLowerCase() === EMBEDDED) return EMBEDDED;
	return path.resolve(trimmed);
}

/* --- persona description ---------------------------------------------------- */

/**
 * Describe a persona source for the panel: size, first lines, and any read error.
 * Cached by `mtimeMs:size`, because the panel polls this roughly once a second while open.
 */
let personaCache = { key: "", value: null };

function readBounded(file, limit) {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, limit);
		const buffer = Buffer.alloc(length);
		if (length > 0) fs.readSync(fd, buffer, 0, length, 0);
		return { text: buffer.toString("utf8"), size };
	} finally {
		fs.closeSync(fd);
	}
}

function describeSource(source) {
	const wanted = normalizeSource(source);
	let text = "";
	let error = "";
	const warnings = [];
	let truncated = false;
	let bytes = 0;
	let key = `${wanted}:embedded`;
	let mtime = 0;

	if (wanted === EMBEDDED) {
		try {
			const info = fs.statSync(EMBEDDED_PERSONA_FILE);
			mtime = info.mtimeMs;
			key = `${wanted}:${mtime}:${info.size}`;
			const read = readBounded(EMBEDDED_PERSONA_FILE, MAX_PERSONA_BYTES + PREVIEW_CHARS);
			text = read.text.trim();
			bytes = read.size;
		} catch {
			error = "读不到 persona/embedded.md";
			warnings.push("扩展在缺这个文件时会退回内联的内置人设文本，注入仍然可用；面板预览则显示为空。");
		}
	} else {
		try {
			const info = fs.statSync(wanted);
			if (info.isDirectory()) throw new Error("这是一个目录，不是文件");
			mtime = info.mtimeMs;
			bytes = info.size;
			key = `${wanted}:${mtime}:${info.size}`;
			const read = readBounded(wanted, MAX_PERSONA_BYTES + PREVIEW_CHARS);
			text = read.text.trim();
			truncated = read.size > MAX_PERSONA_BYTES;
			if (truncated) {
				warnings.push(`文件 ${Math.round(read.size / 1024)} KB，超过 ${MAX_PERSONA_BYTES / 1024} KB：这里只预览开头，扩展仍会整份读进系统提示词。`);
			}
			if (read.text.startsWith("\ufeff") || /\u0000/.test(read.text.slice(0, 64))) {
				warnings.push("文件看起来不是 UTF-8（有 BOM 或空字节）：扩展按 UTF-8 读取会把正文变成乱码，请另存为 UTF-8。");
			}
		} catch (cause) {
			// Same wording the extension uses, so the panel and `/purge status` agree.
			error = cause && cause.code === "ENOENT" ? "文件不存在" : cause instanceof Error ? cause.message : String(cause);
		}
	}

	// Caching only pays off for large files. A persona file of a few KB is re-read on every
	// poll instead, so an edit that keeps the same size and a coarse timestamp can never go
	// unnoticed; `mtimeMs:size` is only trusted for big files written a moment ago.
	const cacheEligible = bytes > 64 * 1024 && mtime > 0 && Date.now() - mtime >= 2000;
	if (cacheEligible && personaCache.key === key && personaCache.value) return personaCache.value;
	const lines = text ? text.split(/\r?\n/).length : 0;
	const value = {
		path: wanted,
		kind: wanted === EMBEDDED ? "embedded" : "file",
		label: wanted === EMBEDDED ? "内嵌示例（persona/embedded.md）" : wanted,
		exists: wanted === EMBEDDED ? text.length > 0 : !error,
		chars: text.length,
		charsTruncated: truncated,
		lines,
		bytes,
		oversized: truncated,
		preview: text.slice(0, PREVIEW_CHARS),
		previewTruncated: text.length > PREVIEW_CHARS,
		warnings,
		error,
	};
	personaCache = { key, value };
	return value;
}

/* --- snapshots -------------------------------------------------------------- */

function snapshot() {
	const { config, exists, error } = readConfig();
	const statusRead = readJsonFile(statusFile());
	// `error` is the "the file is there but unreadable" case: the panel must show it and
	// refuse to save over it, instead of displaying defaults that came from nowhere.
	return {
		plugin: {
			id: PLUGIN_ID,
			version: VERSION,
			// Empty when neither candidate accepts a write: the panel then says so instead of
			// naming a directory nobody is actually using.
			stateDir: resolveStateDir(),
			configFile: configFile(),
			configCandidates: stateDirCandidates(),
			configExists: exists,
			statusReadError: statusRead.error,
			configError: error,
		},
		config,
		status: statusRead.value,
		persona: describeSource(config.source),
		modes: MODES_INFO,
		hints: {
			envSource: Boolean(process.env.PI_PURGE_SOURCE),
		},
	};
}

/* --- lifecycle -------------------------------------------------------------- */

async function onLoad() {
	// Ask the host where this plugin's data belongs. A development plugin's own directory is
	// watched recursively, so the state must live outside it or every write reloads the plugin.
	try {
		const resolved = await pi.plugin?.getDataPath?.();
		if (typeof resolved === "string" && resolved.trim()) hostDataDir = path.resolve(resolved.trim());
	} catch {
		/* keep the default layout */
	}
	writeStatePointer();
	resolveStateDir();
	await pi.commands.register({
		id: COMMAND_OPEN,
		title: "PI Purge: 打开控制面板",
		keywords: ["purge", "破限", "人设", "系统提示词", "persona", "system prompt", "strict"],
		category: "PI Purge",
		run: async () => {
			await pi.ui.openPanel({ title: "PI Purge 控制面板" });
		},
	});
	await pi.commands.register({
		id: COMMAND_TOGGLE,
		title: "PI Purge: 开/关当前会话",
		keywords: ["purge", "toggle", "开关", "破限"],
		category: "PI Purge",
		run: async () => {
			try {
				const config = updateConfig({ enabled: !readConfig().config.enabled }, "command");
				await pi.ui.showToast(
					config.enabled ? `PI Purge 已开启（${config.mode}），下一条消息生效` : "PI Purge 已关闭，恢复宿主原始提示词",
					"info",
				);
			} catch (error) {
				await pi.ui.showToast(`PI Purge 无法切换：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

async function onUnload() {
	for (const id of [COMMAND_OPEN, COMMAND_TOGGLE]) {
		try {
			await pi.commands.unregister(id);
		} catch {
			/* already gone */
		}
	}
	// A development plugin is reloaded in place: forget the probe results so a changed
	// state directory is picked up instead of being masked by the previous process.
	stateDir = "";
	personaCache = { key: "", value: null };
}

/** Panel RPC: `window.pluginBridge.invoke("<channel>", payload)`. */
async function onPanelInvoke(channel, payload) {
	switch (channel) {
		case "purge.state":
			return { ok: true, ...snapshot() };
		case "purge.setConfig": {
			const patch = {};
			if (typeof payload?.enabled === "boolean") patch.enabled = payload.enabled;
			if (typeof payload?.mode === "string" && MODES.includes(payload.mode)) patch.mode = payload.mode;
			if (typeof payload?.source === "string") patch.source = normalizeSource(payload.source);
			const config = updateConfig(patch, "panel");
			return { ok: true, config, persona: describeSource(config.source) };
		}
		case "purge.reloadPersona":
			personaCache = { key: "", value: null };
			return { ok: true, persona: describeSource(readConfig().config.source) };
		default:
			throw new Error(`[${PLUGIN_ID}] unknown panel channel: ${channel}`);
	}
}

module.exports = { onLoad, onUnload, onPanelInvoke };