/**
 * PI Purge — agent-extension test suite.
 *
 * Runs the shipped extension against a mock of the pi ExtensionAPI (`on`,
 * `registerCommand`, `ctx.ui.notify` / `ctx.ui.setStatus`) and the real PI-Desktop
 * system-prompt shape, taken from the host's own template: the preamble sentence, the
 * `<tools>` / `<rules>` / `<docs>` sections, and the two cut anchors.
 *
 * The plugin directory is copied into a temporary directory per test, because the
 * extension derives its state directory from `import.meta.url`: the test therefore never
 * touches the state of a plugin installed in PI-Desktop, and each import gets a private
 * module instance (cache-busted through the URL query).
 *
 *   node pi-desktop-plugin/test/pi-purge.extension.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The preamble sentence PI-Desktop and the pi CLI both emit. */
const IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const DOCS_START = "Pi documentation (read only when the user asks about pi itself";

/** A system prompt shaped exactly like the host's, with both anchors present. */
const HOST_PROMPT = [
	`${IDENTITY} You help users by reading files, executing commands, editing code, and writing new files.`,
	"",
	"<tools>",
	"- read: Read a file from the local filesystem",
	"- bash: Execute a shell command",
	"</tools>",
	"",
	"<rules>",
	"Be concise in your responses",
	"Show file paths clearly when working with files",
	"</rules>",
	"",
	"<docs>",
	`${DOCS_START}, its SDK, extensions, themes, skills, or TUI):`,
	"- Main documentation: C:/pi/docs",
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	"</docs>",
	"",
	"<cwd>C:/work/demo</cwd>",
].join("\n");

const CWD = "C:/work/demo";

let unique = 0;

/**
 * Copy the plugin into a scratch directory and import its extension fresh.
 *
 * The copy mirrors the real install layout `<root>/installed/local.pi-purge`, and the
 * process home is pointed at the scratch root for the duration of the test: the extension's
 * first state-directory candidate is `<home>/.pi-desktop/plugins/data/<id>`, so the real
 * resolution rule is exercised without ever touching the machine's own plugin data.
 */
const envStack = [];

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-purge-test-"));
	const dir = join(root, "installed", "local.pi-purge");
	mkdirSync(dir, { recursive: true });
	for (const part of ["extensions", "persona"]) {
		cpSync(join(PLUGIN_SOURCE, part), join(dir, part), { recursive: true });
	}
	mkdirSync(join(dir, "state"), { recursive: true });
	envStack.push({ USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME });
	process.env.USERPROFILE = root;
	process.env.HOME = root;
	return dir;
}

/** The host data directory both sides resolve first, inside the scratch tree. */
function dataDir(dir) {
	return join(dirname(dirname(dir)), ".pi-desktop", "plugins", "data", "local.pi-purge");
}

/** Remove the copied plugin, the scratch root, and restore the process home. */
function cleanup(dir) {
	const saved = envStack.pop();
	if (saved) {
		if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = saved.USERPROFILE;
		if (saved.HOME === undefined) delete process.env.HOME;
		else process.env.HOME = saved.HOME;
	}
	rmSync(dirname(dirname(dir)), { recursive: true, force: true });
}

async function loadExtension(dir) {
	unique += 1;
	const url = pathToFileURL(join(dir, "extensions", "pi-purge.extension.mjs")).href;
	const module = await import(`${url}?case=${unique}`);
	return module.default;
}

/** Minimal pi ExtensionAPI: capture handlers, commands, notifications and status pills. */
function createHost() {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	const api = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, definition) => commands.set(name, definition),
	};
	const ctx = {
		ui: {
			notify: (text, level = "info") => notifications.push({ text, level }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
	};
	return { api, commands, notifications, statuses, ctx, emit: (name, event) => handlers.get(name)?.(event, ctx) };
}

async function boot(dir) {
	const host = createHost();
	const extension = await loadExtension(dir);
	extension(host.api);
	await host.emit("session_start", { type: "session_start" });
	return host;
}

/** Read one of the extension's state files (`status` / `config`) from a state directory. */
function readState(dir, name, stateDir = dataDir(dir)) {
	const file = join(stateDir, name.endsWith(".json") ? name : `${name}.json`);
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function writeConfig(dir, config) {
	mkdirSync(dataDir(dir), { recursive: true });
	writeFileSync(join(dataDir(dir), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const turn = (host) =>
	host.emit("before_agent_start", { type: "before_agent_start", systemPrompt: HOST_PROMPT, systemPromptOptions: { cwd: CWD } });

test("stays disabled, and rewrites nothing, when no config exists", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		assert.equal(await turn(host), undefined, "a disabled extension must not return a systemPrompt");

		const status = readState(dir, "status");
		assert.equal(status.enabled, false);
		assert.equal(status.mode, "strict");
		assert.equal(status.source, "embedded");
		assert.equal(status.lastTurn.applied, false);
		assert.equal(status.chars > 0, true, "the bundled persona is loaded even while disabled");
	} finally {
		cleanup(dir);
	}
});

test("/purge on replaces the prompt with the persona plus the working directory (strict)", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		const purge = host.commands.get("purge");
		assert.ok(purge, "the /purge command is registered");

		await purge.handler("on", host.ctx);
		const result = await turn(host);
		assert.ok(result?.systemPrompt, "strict mode returns a rewritten prompt");

		const prompt = result.systemPrompt;
		const persona = readFileSync(join(dir, "persona", "embedded.md"), "utf8").trim();
		assert.equal(prompt, `${persona}\n\nCurrent working directory: ${CWD}`);
		assert.ok(!prompt.includes(IDENTITY), "the harness identity sentence is gone");
		assert.ok(!prompt.includes("Be concise"), "host rules are gone in strict mode");
		assert.ok(!prompt.includes("Main documentation"), "the docs section is gone");

		const status = readState(dir, "status");
		assert.equal(status.enabled, true);
		assert.equal(status.lastCut.identity, true, "the identity anchor matched");
		assert.equal(status.lastCut.docs, true, "the docs anchor matched");
		assert.equal(status.lastTurn.applied, true);
		assert.equal(status.lastTurn.promptChars, prompt.length);

		const config = readState(dir, "config");
		assert.equal(config.enabled, true, "/purge mirrors its state into config.json for the panel");
		assert.equal(config.updatedBy, "command");
	} finally {
		cleanup(dir);
	}
});

test("replace mode cuts the identity line and docs, and keeps tools, rules and cwd", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		await host.commands.get("purge").handler("mode replace", host.ctx);
		await host.commands.get("purge").handler("on", host.ctx);

		const prompt = (await turn(host)).systemPrompt;
		const persona = readFileSync(join(dir, "persona", "embedded.md"), "utf8").trim();
		assert.ok(prompt.startsWith(`${persona}\n\n`), "the persona stays at the head");
		assert.ok(!prompt.includes(IDENTITY), "identity line removed");
		assert.ok(!prompt.includes(DOCS_START), "docs section removed");
		assert.ok(prompt.includes("<tools>") && prompt.includes("bash: Execute a shell command"), "tools survive");
		assert.ok(prompt.includes("Be concise in your responses"), "rules survive");
		assert.ok(prompt.includes("<cwd>C:/work/demo</cwd>"), "project context survives");

		const status = readState(dir, "status");
		assert.equal(status.mode, "replace");
		assert.equal(status.lastCut.identity, true);
		assert.equal(status.lastCut.docs, true);
	} finally {
		cleanup(dir);
	}
});

test("append mode only prepends the persona", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		await host.commands.get("purge").handler("mode append", host.ctx);
		await host.commands.get("purge").handler("on", host.ctx);

		const prompt = (await turn(host)).systemPrompt;
		const persona = readFileSync(join(dir, "persona", "embedded.md"), "utf8").trim();
		assert.equal(prompt, `${persona}\n\n${HOST_PROMPT}`, "the host prompt is untouched");

		const status = readState(dir, "status");
		assert.equal(status.lastCut.identity, false);
		assert.equal(status.lastCut.docs, false);
	} finally {
		cleanup(dir);
	}
});

test("a config file written by the panel is adopted, including an external persona file", async () => {
	const dir = workspace();
	try {
		const personaFile = join(dir, "my-persona.md");
		writeFileSync(personaFile, "You are a terse assistant. Answer in one sentence.\n", "utf8");
		writeConfig(dir, { enabled: true, mode: "replace", source: personaFile });

		const host = await boot(dir);
		const prompt = (await turn(host)).systemPrompt;
		assert.ok(prompt.startsWith("You are a terse assistant."), "the file persona is used");
		assert.ok(!prompt.includes(IDENTITY));

		const status = readState(dir, "status");
		assert.equal(status.sourceKind, "file");
		assert.equal(status.source, personaFile);

		// The panel turning it off is picked up on the next turn, without a command.
		writeConfig(dir, { enabled: false, mode: "replace", source: personaFile });
		assert.equal(await turn(host), undefined, "a disabled config stops the rewrite");
		assert.equal(readState(dir, "status").lastTurn.applied, false);
	} finally {
		cleanup(dir);
	}
});

test("an unreadable persona keeps the switch on, reports why, and recovers by itself", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		const personaFile = join(dir, "later.md");
		writeConfig(dir, { enabled: true, mode: "strict", source: personaFile });

		assert.equal(await turn(host), undefined, "nothing is rewritten while the file is missing");
		const broken = readState(dir, "status");
		assert.equal(broken.enabled, true, "the operator's intent survives: no silent clamp to off");
		assert.equal(broken.loadError.includes("文件不存在"), true);
		assert.equal(broken.lastTurn.applied, false);

		// No toggle, no reload command: fixing the file is enough for the next turn.
		writeFileSync(personaFile, "You are back.\n", "utf8");
		const prompt = (await turn(host)).systemPrompt;
		assert.ok(prompt.startsWith("You are back."), "the rewrite resumes once the file exists again");
		assert.equal(readState(dir, "status").loadError, "");
	} finally {
		cleanup(dir);
	}
});

test("a refused /purge source writes no config and keeps the previous persona", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		const missing = join(dir, "nope.md");
		await host.commands.get("purge").handler(`source ${missing}`, host.ctx);

		const last = host.notifications.at(-1);
		assert.equal(last.level, "error");
		assert.match(last.text, /切换失败/);
		assert.equal(readState(dir, "config"), null, "a refused switch writes no config");
		assert.equal(readState(dir, "status").source, "embedded");

		// The rollback left a usable persona, so an explicit enable succeeds on it.
		await host.commands.get("purge").handler(`source ${missing}`, host.ctx);
		await host.commands.get("purge").handler("on", host.ctx);
		assert.match(host.notifications.at(-1).text, /已开启/);
		assert.equal(readState(dir, "config").source, "embedded");

		// But a stored config naming an unreadable file still refuses an explicit enable.
		writeConfig(dir, { enabled: false, mode: "strict", source: missing });
		await host.commands.get("purge").handler("off", host.ctx);
		await host.commands.get("purge").handler("on", host.ctx);
		assert.match(host.notifications.at(-1).text, /无法开启/, "an explicit enable refuses an unreadable persona");
		assert.equal(readState(dir, "status").enabled, false);
	} finally {
		cleanup(dir);
	}
});

test("/purge does not undo a change the panel made while the session was busy", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		writeConfig(dir, { enabled: false, mode: "append", source: "embedded", note: "written by the panel" });

		await host.commands.get("purge").handler("on", host.ctx);
		const config = readState(dir, "config");
		assert.equal(config.enabled, true, "the command turned the switch on");
		assert.equal(config.mode, "append", "the panel's mode survived the command's write");
		assert.equal(config.note, "written by the panel", "unknown fields are preserved");
	} finally {
		cleanup(dir);
	}
});

test("a corrupt config.json is ignored instead of crashing the extension", async () => {
	const dir = workspace();
	try {
		mkdirSync(dataDir(dir), { recursive: true });
		writeFileSync(join(dataDir(dir), "config.json"), "{ this is not json", "utf8");
		const host = await boot(dir);

		assert.equal(
			readFileSync(join(dataDir(dir), "config.json"), "utf8"),
			"{ this is not json",
			"the corrupt file is left exactly as it was",
		);
		assert.equal(await turn(host), undefined);
		const status = readState(dir, "status");
		assert.equal(status.enabled, false);
		assert.equal(status.mode, "strict");

		// A command must not "fix" the file by overwriting it with a fresh snapshot either.
		await host.commands.get("purge").handler("on", host.ctx);
		assert.match(host.notifications.at(-1).text, /警告：配置未写入磁盘/);
		assert.equal(readFileSync(join(dataDir(dir), "config.json"), "utf8"), "{ this is not json");

		// Once the file is gone the command can write one again.
		rmSync(join(dataDir(dir), "config.json"));
		await host.commands.get("purge").handler("on", host.ctx);
		assert.equal(readState(dir, "config").enabled, true);
	} finally {
		cleanup(dir);
	}
});

test("state lives outside the plugin directory, so a write cannot reload the plugin", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		await host.commands.get("purge").handler("on", host.ctx);
		await turn(host);

		// The dev-plugin watcher watches the plugin directory recursively; a state file in
		// there would look like a source edit, and the reload would write state again.
		assert.equal(existsSync(join(dataDir(dir), "status.json")), true, "status lands in the host data directory");
		assert.equal(existsSync(join(dataDir(dir), "config.json")), true, "the command's config lands there too");
		assert.deepEqual(readdirSync(join(dir, "state")), [], "the plugin's own state/ stays untouched");
		assert.equal(existsSync(join(dir, "state-location.json")), false, "no pointer is needed for the default layout");
		assert.equal(readdirSync(dir).sort().join(","), "extensions,persona,state", "nothing else is written into the plugin directory");
	} finally {
		cleanup(dir);
	}
});

test("a state-location.json from the host overrides the default layout", async () => {
	const dir = workspace();
	try {
		const elsewhere = join(dirname(dirname(dir)), "host-data", "local.pi-purge");
		writeFileSync(
			join(dir, "state-location.json"),
			`${JSON.stringify({ stateDir: elsewhere, note: "host keeps data elsewhere" })}\n`,
			"utf8",
		);

		const host = await boot(dir);
		await host.commands.get("purge").handler("on", host.ctx);
		await turn(host);

		assert.equal(existsSync(join(elsewhere, "status.json")), true, "status follows the pointer");
		assert.equal(existsSync(join(elsewhere, "config.json")), true);
		assert.equal(existsSync(join(dataDir(dir), "status.json")), false, "the default layout is not used");
	} finally {
		cleanup(dir);
	}
});

test("when the data directory is unusable both sides fall back to the plugin's own state/", async () => {
	const dir = workspace();
	try {
		// A file where the data directory belongs: the first candidate cannot be created, so the
		// second one has to take over — the same rule main.cjs applies.
		mkdirSync(dirname(dataDir(dir)), { recursive: true });
		writeFileSync(dataDir(dir), "not a directory\n", "utf8");

		const host = await boot(dir);
		await host.commands.get("purge").handler("on", host.ctx);
		await turn(host);

		assert.equal(existsSync(join(dir, "state", "status.json")), true, "status lands in the fallback directory");
		assert.equal(existsSync(join(dir, "state", "config.json")), true, "the command's config lands there too");
		assert.equal(readState(dir, "status", join(dir, "state")).enabled, true);
	} finally {
		cleanup(dir);
	}
});

test("status and completions answer the operator", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		const purge = host.commands.get("purge");

		assert.deepEqual(
			purge.getArgumentCompletions("s").map((entry) => entry.value),
			["status", "source"],
		);
		assert.equal(purge.getArgumentCompletions("").length, 7);

		await purge.handler("on", host.ctx);
		await turn(host);
		host.notifications.length = 0;
		await purge.handler("status", host.ctx);
		const status = host.notifications.at(-1).text;
		assert.match(status, /状态: 开启/);
		assert.match(status, /strict（只留人设\+工作目录）/);
		assert.match(status, /身份段 已切除/);

		host.notifications.length = 0;
		await purge.handler("mode nonsense", host.ctx);
		assert.equal(host.notifications.at(-1).level, "error");

		host.notifications.length = 0;
		await purge.handler("reload", host.ctx);
		assert.match(host.notifications.at(-1).text, /已重载/);
	} finally {
		cleanup(dir);
	}
});

test("a host prompt without the anchors degrades instead of cutting the wrong text", async () => {
	const dir = workspace();
	try {
		const host = await boot(dir);
		await host.commands.get("purge").handler("mode replace", host.ctx);
		await host.commands.get("purge").handler("on", host.ctx);

		const foreign = "<preamble>\nA different harness.\n</preamble>\n<cwd>C:/x</cwd>";
		const prompt = (await host.emit("before_agent_start", { systemPrompt: foreign, systemPromptOptions: { cwd: CWD } })).systemPrompt;
		assert.ok(prompt.endsWith(foreign), "an unmatched host prompt is left intact");

		const status = readState(dir, "status");
		assert.equal(status.lastCut.identity, false);
		assert.equal(status.lastCut.docs, false);
	} finally {
		cleanup(dir);
	}
});

test("a relative /purge source is stored as an absolute path", async () => {
	const dir = workspace();
	const sessionCwd = process.cwd();
	try {
		const host = await boot(dir);
		const relative = "relative-persona.md";
		writeFileSync(join(dir, relative), "relative works.\n", "utf8");

		// A relative path typed in a session means "relative to the session's working
		// directory"; resolving it here is what keeps both processes on one file.
		process.chdir(dir);
		await host.commands.get("purge").handler(`source ${relative}`, host.ctx);
		process.chdir(sessionCwd);

		const expected = join(dir, relative);
		assert.equal(readState(dir, "config").source, expected, "the stored source is absolute");
		assert.equal(readState(dir, "status").sourceKind, "file");
		assert.equal(readState(dir, "status").source, expected);
	} finally {
		process.chdir(sessionCwd);
		cleanup(dir);
	}
});