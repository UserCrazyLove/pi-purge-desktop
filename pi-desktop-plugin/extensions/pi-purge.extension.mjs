/**
 * pi-purge for PI-Desktop — agent-extension entry.
 *
 * Ported from `extensions/pi-purge.ts` (pi-purge 0.2.4, pi CLI). Mechanism is
 * unchanged: the harness identity sentence is not drowned out, it is **removed**.
 *
 *   strict  — only the persona plus `Current working directory: …`
 *   replace — persona, then the host prompt with its identity line and bundled
 *             documentation section stripped
 *   append  — persona prepended to the untouched host prompt
 *
 * PI-Desktop compatibility notes
 * ------------------------------
 * The host resolves `before_agent_start` handlers that return `{ systemPrompt }`
 * into `systemPromptOptions.forceSystemPrompt`, and its own prompt template uses the
 * same preamble sentence and the same documentation markers as the pi CLI, so the cut
 * anchors below match without a per-host variant.
 *
 * Differences from the CLI extension, both additive:
 *   1. a config file written by the plugin's control panel (`main.cjs`) supplies the
 *      default enabled/mode/source and is re-read whenever it changes on disk, so the
 *      panel and `/purge` stay in sync instead of fighting each other;
 *   2. every turn writes `status.json`, which the panel renders as live feedback.
 *
 * With no config file on disk this behaves exactly like the CLI extension: disabled,
 * `strict`, bundled persona. No network, nothing outside the plugin's own state dir.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Last-resort copy of the bundled persona, used only when `persona/embedded.md` cannot be
 * read. The shipped default lives in that file and both the panel and this extension read
 * it from there, so this list must stay a plain fallback rather than a second source of
 * truth: if you edit the file, mirror the change here or the two surfaces can disagree.
 */
const EMBEDDED_PERSONA = [
	"# Persona (example)",
	"",
	"You are a helpful assistant running inside pi. Answer the user's request directly",
	"and keep responses concise.",
	"",
	"This text is only a placeholder bundled with pi-purge, so that a fresh install",
	"works immediately: /purge swaps the system prompt for this text plus the working",
	"directory, and /purge off restores pi's own prompt.",
	"",
	"To run your own instructions instead:",
	"",
	"    /purge source C:/path/to/your-prompt.md",
	"",
	"and /purge source embedded comes back to this example.",
].join("\n");

/** Identifier of the bundled source; `/purge source embedded` returns to it. */
const EMBEDDED = "embedded";
/** Common external persona locations, only used as a hint in messages. */
const HINT_SOURCE = join(homedir(), ".dsh", "prompt-inject.md");

/** Initial source from the environment; the config file and `/purge source` override it. */
const ENV_SOURCE = process.env.PI_PURGE_SOURCE?.trim() || "";

const MODES = ["strict", "replace", "append"];
const PLUGIN_ID = "local.pi-purge";
const VERSION = "0.2.4";

/** Host identity sentence (PI-Desktop and pi CLI share this template first line). */
const HOST_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness.";
/** Documentation section markers; if either is missing the section is left untouched. */
const HOST_DOCS_START = "Pi documentation (read only when the user asks about pi itself";
const HOST_DOCS_END = "(e.g., tui.md for TUI API details)";

/** Directory of this module, used to locate the plugin's own state directory. */
const MODULE_FILE = (() => {
	try {
		return fileURLToPath(import.meta.url);
	} catch {
		return "";
	}
})();
const EXTENSIONS_DIR = MODULE_FILE ? dirname(MODULE_FILE) : "";
const PLUGIN_DIR = EXTENSIONS_DIR ? dirname(EXTENSIONS_DIR) : "";
/**
 * Where the shared state lives.
 *
 * First choice is the host's own per-plugin data directory
 * (`<pi-desktop>/plugins/data/<plugin id>`, the path `pi.plugin.getDataPath()` returns),
 * *not* a folder inside the plugin directory. PI-Desktop watches a development plugin's
 * directory recursively, so every state write inside it would look like a source change and
 * reload the plugin — which writes state again. The plugin's own `state/` directory stays as
 * a fallback for the case where the data directory is not writable, and as the last resort
 * the layout `<plugins root>/data/<plugin id>` is derived from the plugin's own path.
 *
 * `main.cjs` resolves the same list in the same order, and leaves a `state-location.json`
 * next to the manifest only when the directory the host hands it differs from the default
 * layout — so the two sides agree without the plugin directory being written on every load.
 */
const HOST_DATA_DIR = join(homedir(), ".pi-desktop", "plugins", "data", PLUGIN_ID);
const POINTER_FILE = PLUGIN_DIR ? join(PLUGIN_DIR, "state-location.json") : "";

/** The host's correction, when its data directory is not where the default layout says. */
function pointeeDir() {
	if (!POINTER_FILE) return "";
	try {
		const parsed = JSON.parse(readFileSync(POINTER_FILE, "utf8"));
		const dir = parsed && typeof parsed.stateDir === "string" ? parsed.stateDir.trim() : "";
		return dir;
	} catch {
		return "";
	}
}

const STATE_DIRS = (() => {
	const dirs = [];
	const override = pointeeDir();
	if (override) dirs.push(override);
	dirs.push(HOST_DATA_DIR);
	if (PLUGIN_DIR) {
		dirs.push(join(PLUGIN_DIR, "state"));
		dirs.push(join(dirname(dirname(PLUGIN_DIR)), "data", PLUGIN_ID));
	}
	return dirs;
})();

/** Session state: memory only, except for the shared config/status files below. */
let enabled = false;
let mode = "strict";
let source = ENV_SOURCE || EMBEDDED;
let body = "";
let loadError = "";
/** What the previous turn actually cut, so `/purge status` answers "did it work". */
let lastCut = { identity: false, docs: false, at: 0 };
/** Last configuration stamp observed on disk; a change means another writer spoke. */
let configStamp = null;
/** Directory the current configuration was read from — the preferred status target. */
let configDir = null;
/** Last working directory seen, reported to the panel. */
let lastCwd = "";
/** Last synopsis of the most recent turn, reported to the panel. */
let lastTurn = null;

/** pi's `before_agent_start` gives a string, omp gives string[]; one text block either way. */
function systemText(value) {
	if (Array.isArray(value)) return value.filter((block) => typeof block === "string").join("\n\n");
	return typeof value === "string" ? value : "";
}

/**
 * Remove the harness identity sentence and the bundled documentation section.
 * Both are located by exact wording; an unmatched anchor leaves the text alone, so a
 * host that rewords its prompt degrades to `append` instead of cutting the wrong text.
 */
function stripHostPersona(systemPrompt) {
	let text = systemPrompt;
	let identity = false;
	let docs = false;

	const identityAt = text.indexOf(HOST_IDENTITY);
	if (identityAt !== -1) {
		const lineEnd = text.indexOf("\n", identityAt);
		const cutEnd = lineEnd === -1 ? text.length : lineEnd + 1;
		text = text.slice(0, identityAt) + text.slice(cutEnd);
		identity = true;
	}

	const docsAt = text.indexOf(HOST_DOCS_START);
	if (docsAt !== -1) {
		const docsEndAt = text.indexOf(HOST_DOCS_END, docsAt + HOST_DOCS_START.length);
		if (docsEndAt !== -1) {
			let start = docsAt;
			while (start > 0 && text[start - 1] === "\n") start -= 1;
			const lineEnd = text.indexOf("\n", docsEndAt);
			const end = lineEnd === -1 ? text.length : lineEnd + 1;
			text = text.slice(0, start) + text.slice(end);
			docs = true;
		}
	}

	return { text, identity, docs };
}

function fileStamp(file) {
	try {
		const info = statSync(file);
		return `${info.mtimeMs}:${info.size}`;
	} catch {
		return "";
	}
}

/**
 * Write through a temporary name and rename, so a reader on the other side of the
 * plugin/extension boundary never sees a half-written file.
 */
function writeAtomic(file, text) {
	const temp = `${file}.tmp-${process.pid}`;
	writeFileSync(temp, text, "utf8");
	renameSync(temp, file);
}

/**
 * The bundled persona, read from `persona/embedded.md` when present.
 * Falls back to the inline copy above if the plugin was installed without that file.
 */
function embeddedPersona() {
	const file = PLUGIN_DIR ? join(PLUGIN_DIR, "persona", "embedded.md") : "";
	if (file) {
		try {
			const text = readFileSync(file, "utf8").trim();
			if (text) return text;
		} catch {
			/* fall through to the inline copy */
		}
	}
	return EMBEDDED_PERSONA;
}

/**
 * State directories that really accept a write, decided once per process.
 *
 * `main.cjs` probes the same candidates in the same order with a pid-suffixed marker
 * name, so two processes probing at the same moment cannot delete each other's marker
 * and split the two sides onto different directories.
 */
const writableCache = new Map();
let fallbackDir = "";
function stateDirWritable(dir) {
	if (writableCache.has(dir)) return writableCache.get(dir);
	let writable = false;
	try {
		mkdirSync(dir, { recursive: true });
		const probe = join(dir, `.pi-purge-probe-${process.pid}`);
		writeFileSync(probe, "", "utf8");
		unlinkSync(probe);
		writable = true;
	} catch {
		writable = false;
	}
	writableCache.set(dir, writable);
	return writable;
}

/**
 * The one state directory this process uses: the first candidate that really accepts a
 * write, decided once. Both sides resolve the same list with the same rule, so the panel,
 * the extension and the host's data directory never drift apart.
 */
function stateDir() {
	if (fallbackDir) return fallbackDir;
	for (const dir of STATE_DIRS) {
		if (!stateDirWritable(dir)) continue;
		fallbackDir = dir;
		return dir;
	}
	return "";
}

/**
 * Read the control panel's configuration from the shared state directory.
 * A file that exists but cannot be parsed is reported as "no configuration" rather than
 * crashing a turn; the panel is the one that refuses to overwrite such a file.
 */
function readConfigFile() {
	const dir = stateDir();
	if (!dir) return null;
	const file = join(dir, "config.json");
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let config;
	try {
		config = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) return null;
	return { dir, file, stamp: fileStamp(file), config };
}

function stateTarget() {
	const dir = configDir || stateDir();
	return dir ? join(dir, "status.json") : "";
}

/** Publish what the panel should display. Skips an identical payload. */
function publishStatus() {
	const file = stateTarget();
	if (!file) return;
	const payload = {
		plugin: PLUGIN_ID,
		version: VERSION,
		enabled,
		mode,
		source,
		sourceKind: source === EMBEDDED ? "embedded" : "file",
		sourceLabel: source === EMBEDDED ? "内嵌示例" : source,
		chars: body.length,
		loadError,
		lastCut,
		cwd: lastCwd,
		lastTurn,
		updatedAt: new Date().toISOString(),
	};
	// Written on every turn on purpose: the panel reads this file as live feedback, and a
	// failed write is swallowed so a read-only state directory can never break a turn.
	try {
		writeAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
	} catch {
		/* nothing to do: the rewrite itself already happened */
	}
}

/**
 * Mirror the in-memory state back to the config file so the panel follows `/purge`.
 *
 * The write merges onto the file as it is on disk (never onto defaults) and only touches
 * the fields this side owns, so a simultaneous panel edit survives except for the field
 * the command really changed. A config file that exists but cannot be parsed is never
 * replaced: the same refusal `main.cjs` applies, so `/purge` cannot quietly destroy a
 * file the panel is telling the user to fix.
 *
 * Returns false when nothing was written; callers surface that to the operator.
 */
function persistConfig(writer) {
	const dir = configDir || stateDir();
	if (!dir) return false;
	const file = join(dir, "config.json");
	let previous = {};
	try {
		const raw = readFileSync(file, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return false;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		previous = parsed;
	} catch (error) {
		// ENOENT means "no config yet, start one"; anything else means "leave it alone".
		if (!error || error.code !== "ENOENT") return false;
	}
	const payload = { ...previous, enabled, mode, source, updatedBy: writer, updatedAt: new Date().toISOString() };
	try {
		mkdirSync(dir, { recursive: true });
		writeAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
		configDir = dir;
		configStamp = fileStamp(file);
		return true;
	} catch {
		return false;
	}
}

/** Suffix appended whenever a command cannot write the shared config file. */
const PERSIST_FAILED = "\n（警告：配置未写入磁盘——config.json 已损坏或状态目录不可写，重启后本设置失效）";

/**
 * Normalise a persona source: the bundled marker, or an absolute path.
 * Resolving here means the panel and the agent sidecar open the same file instead of
 * resolving a relative path against two different working directories.
 */
function normalizeSource(value) {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return EMBEDDED;
	if (trimmed.toLowerCase() === EMBEDDED) return EMBEDDED;
	return resolve(trimmed);
}

export default function piPurge(pi) {
	/** Load the persona body: the bundled file, or the external path in `source`. */
	const reload = () => {
		if (source === EMBEDDED) {
			body = embeddedPersona();
			loadError = body.length > 0 ? "" : "内嵌人设为空";
			return body.length > 0;
		}
		try {
			if (!existsSync(source)) throw new Error(`文件不存在: ${source}`);
			const text = readFileSync(source, "utf8").trim();
			if (text.length === 0) throw new Error(`文件为空: ${source}`);
			body = text;
			loadError = "";
			return true;
		} catch (error) {
			body = "";
			loadError = error instanceof Error ? error.message : String(error);
			return false;
		}
	};

	/**
	 * Adopt the panel's configuration when it changed on disk.
	 * `force` is used on session start, where the previous stamp belongs to the old session.
	 */
	const applyConfig = (force) => {
		const read = readConfigFile();
		if (!read) return false;
		if (!force && read.stamp === configStamp && read.stamp !== "") return false;
		configStamp = read.stamp;
		configDir = read.dir;
		const config = read.config;

		if (typeof config.mode === "string" && MODES.includes(config.mode)) mode = config.mode;
		if (typeof config.source === "string" && config.source.trim()) {
			source = normalizeSource(config.source);
		}
		if (typeof config.enabled === "boolean") enabled = config.enabled;

		// A persona that cannot be read does not flip the switch off: `enabled` stays what
		// the operator asked for, the turn is simply not rewritten, and `loadError` travels
		// in the status file so the panel can say why. Fixing the file is then enough — no
		// need to toggle off and on again.
		reload();
		return true;
	};

	const paint = (ctx) => {
		try {
			ctx?.ui?.setStatus?.("pi-purge", enabled ? "PURGE ON" : undefined);
		} catch {
			/* non-interactive sessions have no footer */
		}
	};

	const notify = (ctx, text, level = "info") => {
		try {
			ctx?.ui?.notify?.(text, level);
		} catch {
			/* a host without a UI still runs the rewrite */
		}
	};

	const describe = () => {
		const cut =
			lastCut.at === 0
				? "尚未运行过一轮"
				: `身份段 ${lastCut.identity ? "已切除" : "未匹配"} / pi 文档段 ${lastCut.docs ? "已切除" : "未匹配"}`;
		const modeLabel =
			mode === "strict"
				? "strict（只留人设+工作目录）"
				: mode === "replace"
					? "replace（清宿主身份段）"
					: "append（只挂头部）";
		return [
			`状态: ${enabled ? "开启" : "关闭"}`,
			`模式: ${modeLabel}`,
			`人设: ${source === EMBEDDED ? "内嵌" : source}${body.length > 0 ? `  ${body.length} 字符` : `  未加载${loadError ? `（${loadError}）` : ""}`}`,
			`上轮切除: ${cut}`,
		].join("\n");
	};

	// Each session starts from the panel's current configuration, disabled when none exists.
	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		lastCut = { identity: false, docs: false, at: 0 };
		lastTurn = null;
		configStamp = null;
		applyConfig(true);
		reload();
		paint(ctx);
		publishStatus();
	});

	pi.on("before_agent_start", async (event) => {
		applyConfig(false);
		// Read on every enabled turn, so editing the persona file takes effect on the next
		// message. While the switch is off nothing is read unless the body is still missing,
		// which also keeps a large persona file out of a disabled session's turn.
		if (enabled || body.length === 0) reload();

		const hostText = systemText(event?.systemPrompt);
		lastCwd = String(event?.systemPromptOptions?.cwd ?? process.cwd() ?? "").replace(/\\/g, "/");

		if (!enabled || body.length === 0) {
			lastTurn = { applied: false, at: Date.now(), hostChars: hostText.length };
			publishStatus();
			return;
		}

		let host = hostText;
		if (mode === "strict") {
			// Tool schemas travel in the API `tools` parameter, not in this text.
			host = lastCwd ? `Current working directory: ${lastCwd}` : "";
			const cut = stripHostPersona(hostText);
			lastCut = { identity: cut.identity, docs: cut.docs, at: Date.now() };
		} else if (mode === "replace") {
			const cut = stripHostPersona(host);
			host = cut.text;
			lastCut = { identity: cut.identity, docs: cut.docs, at: Date.now() };
		} else {
			lastCut = { identity: false, docs: false, at: Date.now() };
		}

		const systemPrompt = host.length > 0 ? `${body}\n\n${host}` : body;
		lastTurn = { applied: true, at: Date.now(), hostChars: hostText.length, promptChars: systemPrompt.length };
		publishStatus();
		return { systemPrompt };
	});

	pi.registerCommand("purge", {
		description: "会话级破限开关：清掉宿主身份段并把人设挂到系统提示词头部",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status", "mode", "source", "reload", "help"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = (parts[0] ?? "").toLowerCase();
			const arg = parts.slice(1).join(" ").trim();

			// Adopt anything the panel wrote since the last turn first, so a command acts on
			// the current state instead of overwriting an edit made a second ago.
			applyConfig(false);
			if ((cmd === "status" || cmd === "") && body.length === 0) reload();

			const turnOn = () => {
				if (!reload()) return notify(ctx, `无法开启：${loadError}`, "error");
				enabled = true;
				const note = persistConfig("command") ? "" : PERSIST_FAILED;
				paint(ctx);
				publishStatus();
				notify(ctx, `已开启（${mode}，本会话），每轮注入 ${body.length} 字符。${note}\n${describe()}`);
			};

			const turnOff = () => {
				enabled = false;
				const note = persistConfig("command") ? "" : PERSIST_FAILED;
				paint(ctx);
				publishStatus();
				notify(ctx, `已关闭，恢复宿主原始系统提示词。${note}`);
			};

			switch (cmd) {
				case "":
					if (enabled) turnOff();
					else turnOn();
					return;
				case "on":
				case "enable":
					return turnOn();
				case "off":
				case "disable":
					return turnOff();
				case "status":
					publishStatus();
					return notify(ctx, describe());
				case "reload":
					if (!reload()) return notify(ctx, `重载失败：${loadError}`, "error");
					publishStatus();
					return notify(ctx, `已重载 ${body.length} 字符。\n${describe()}`);
				case "mode": {
					const wanted = arg.toLowerCase();
					if (!MODES.includes(wanted)) {
						return notify(
							ctx,
							`当前模式: ${mode}\n用法: /purge mode strict|replace|append\nstrict  = 只发人设 + 工作目录（最彻底）\nreplace = 清宿主身份段与文档段\nappend  = 只把人设挂头部`,
							"error",
						);
					}
					mode = wanted;
					const modeNote = persistConfig("command") ? "" : PERSIST_FAILED;
					publishStatus();
					return notify(ctx, `模式已切换为 ${wanted}（本会话）。${modeNote}\n${describe()}`);
				}
				case "source": {
					if (!arg) {
						return notify(
							ctx,
							`当前人设: ${source === EMBEDDED ? "内嵌" : source}\n用法: /purge source <绝对路径|embedded>\n提示: 常见外部位置 ${HINT_SOURCE}`,
							"error",
						);
					}
					const previous = source;
					const wanted = arg.replace(/^["']|["']$/g, "");
					source = normalizeSource(wanted);
					if (!reload()) {
						const reason = loadError;
						source = previous;
						reload();
						return notify(ctx, `切换失败：${reason}`, "error");
					}
					const sourceNote = persistConfig("command") ? "" : PERSIST_FAILED;
					publishStatus();
					return notify(ctx, `人设已切换，正文 ${body.length} 字符。${sourceNote}\n${describe()}`);
				}
				case "help":
				default:
					return notify(
						ctx,
						`用法: /purge [on|off|status|mode <strict|replace|append>|source <路径|embedded>|reload]\n控制面板: 命令面板里运行「PI Purge: 打开控制面板」`,
					);
			}
		},
	});
}