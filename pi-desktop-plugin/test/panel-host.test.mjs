/**
 * PI Purge — host-side plugin and panel wiring tests.
 *
 * Runs `main.cjs` the way the plugin host process does (a global `pi`, then `onLoad`,
 * then `onPanelInvoke`) against a temporary copy, so the repository never gains a
 * `state/` directory. It also checks that every DOM id `panel.js` looks up really exists
 * in `renderer/index.html`, which is the one wiring mistake a panel cannot survive.
 *
 *   node pi-desktop-plugin/test/panel-host.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * A copy of the plugin at `<root>/installed/local.pi-purge`, mirroring a real install, and
 * the process home pointed at the scratch root: the plugin's first state-directory
 * candidate is then `<home>/.pi-desktop/plugins/data/local.pi-purge`, inside the scratch
 * tree instead of the machine's own plugin data.
 *
 * `blockDataDir` puts a file where the data directory belongs, so the first candidate is
 * unusable and the plugin has to fall back to its own `state/`.
 */
function fakePlugin(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-purge-host-"));
	const dir = join(root, "installed", "local.pi-purge");
	mkdirSync(dir, { recursive: true });
	cpSync(join(PLUGIN_SOURCE, "main.cjs"), join(dir, "main.cjs"));
	cpSync(join(PLUGIN_SOURCE, "persona"), join(dir, "persona"), { recursive: true });
	envStack.push({ USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME });
	process.env.USERPROFILE = root;
	process.env.HOME = root;
	if (options.blockDataDir) {
		mkdirSync(dirname(dataDir(dir)), { recursive: true });
		writeFileSync(dataDir(dir), "not a directory\n", "utf8");
	}
	return dir;
}

const envStack = [];

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

/** Minimal host plugin API, recording what the plugin registers and toasts. */
function fakeHost(dir, options = {}) {
	const toasts = [];
	const panels = [];
	const commands = new Map();
	const pi = {
		commands: {
			register: async (command) => commands.set(command.id, command),
			unregister: async (id) => commands.delete(id),
		},
		ui: {
			openPanel: async (options2) => panels.push(options2 ?? {}),
			showToast: async (message, level) => toasts.push({ message, level }),
		},
		// The host's own answer for where plugin data belongs. `dataPath` in the test options
		// makes it differ from the default layout, which is what the pointer file is for.
		plugin: { getDataPath: async () => options.dataPath ?? dataDir(dir) },
	};
	return { pi, commands, toasts, panels };
}

async function boot(options = {}) {
	const dir = fakePlugin(options);
	const host = fakeHost(dir, options);
	const saved = globalThis.pi;
	globalThis.pi = host.pi;
	const entry = require(join(dir, "main.cjs"));
	await entry.onLoad();
	return { dir, entry, host, restore: () => { globalThis.pi = saved; } };
}

const readConfig = (dir) => JSON.parse(readFileSync(join(dataDir(dir), "config.json"), "utf8"));

test("onLoad registers both commands and unregisters them again", async () => {
	const it = await boot();
	try {
		assert.deepEqual([...it.host.commands.keys()].sort(), ["pi-purge.openPanel", "pi-purge.toggle"]);

		await it.host.commands.get("pi-purge.openPanel").run();
		assert.deepEqual(it.host.panels, [{ title: "PI Purge 控制面板" }]);

		await it.host.commands.get("pi-purge.toggle").run();
		assert.match(it.host.toasts.at(-1).message, /已开启/);
		assert.equal(readConfig(it.dir).enabled, true, "the toggle writes the shared config");
		assert.equal(readConfig(it.dir).updatedBy, "command", "the writer is recorded, not assumed");
		assert.equal(existsSync(dataDir(it.dir)), true, "the shared state directory is created up front, outside the plugin directory");
		await it.entry.onUnload();
		assert.equal(it.host.commands.size, 0, "onUnload releases both commands");
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("purge.state reports panel defaults and the bundled persona", async () => {
	const it = await boot();
	try {
		const state = await it.entry.onPanelInvoke("purge.state", {});
		assert.equal(state.ok, true);
		assert.equal(state.config.enabled, false);
		assert.equal(state.config.mode, "strict");
		assert.equal(state.config.source, "embedded");
		assert.equal(state.plugin.configExists, false, "no config file has been written yet");
		assert.equal(state.plugin.configError, "", "an absent file is not an error");
		assert.equal(state.persona.kind, "embedded");
		assert.ok(state.persona.chars > 100, "the bundled persona is read for the preview");
		assert.match(state.persona.preview, /Persona \(example\)/);
		assert.deepEqual(state.modes.map((mode) => mode.id), ["strict", "replace", "append"]);
		assert.equal(state.status, null, "no turn has run yet");
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("purge.setConfig writes the shared config and reports the persona it names", async () => {
	const it = await boot();
	try {
		const personaFile = join(it.dir, "persona.md");
		writeFileSync(personaFile, "You are a terse assistant.\n", "utf8");

		const result = await it.entry.onPanelInvoke("purge.setConfig", { enabled: true, mode: "replace", source: personaFile });
		assert.equal(result.config.enabled, true);
		assert.equal(result.config.mode, "replace");
		assert.equal(result.persona.kind, "file");
		assert.equal(result.persona.error, "");
		assert.equal(result.persona.chars, "You are a terse assistant.".length);

		const stored = readConfig(it.dir);
		assert.deepEqual(
			{ enabled: stored.enabled, mode: stored.mode, source: stored.source, updatedBy: stored.updatedBy },
			{ enabled: true, mode: "replace", source: personaFile, updatedBy: "panel" },
		);
		assert.deepEqual(Object.keys(stored).sort(), ["enabled", "mode", "source", "updatedAt", "updatedBy"], "no derived fields leak into the file");

		// Only the fields the panel actually sent are merged.
		const back = await it.entry.onPanelInvoke("purge.setConfig", { source: "embedded" });
		assert.equal(back.config.source, "embedded");
		assert.equal(back.config.mode, "replace", "mode is untouched by a source-only patch");
		assert.equal(back.config.enabled, true);

		// An unknown mode is refused rather than stored.
		const bad = await it.entry.onPanelInvoke("purge.setConfig", { mode: "nonsense" });
		assert.equal(bad.config.mode, "replace");

		// A source that cannot be read is stored but reported, so the panel shows why.
		const missing = join(it.dir, "missing.md");
		const broken = await it.entry.onPanelInvoke("purge.setConfig", { source: missing });
		assert.equal(broken.config.source, missing);
		assert.match(broken.persona.error, /文件不存在/);
		assert.equal(broken.persona.exists, false);
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("a panel-typed relative path is stored as an absolute one", async () => {
	const it = await boot();
	try {
		const result = await it.entry.onPanelInvoke("purge.setConfig", { source: "persona.md" });
		assert.equal(result.config.source, resolve("persona.md"), "both processes must resolve the same file");
		assert.equal(result.config.source, readConfig(it.dir).source);
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("a corrupt config.json is reported and never silently overwritten", async () => {
	const it = await boot();
	try {
		mkdirSync(dataDir(it.dir), { recursive: true });
		writeFileSync(join(dataDir(it.dir), "config.json"), "{ half a file", "utf8");

		const state = await it.entry.onPanelInvoke("purge.state", {});
		assert.equal(state.plugin.configExists, true);
		assert.match(state.plugin.configError, /JSON 解析失败/);
		assert.equal(state.config.mode, "strict", "defaults are shown, never claimed to come from the file");

		await assert.rejects(
			() => it.entry.onPanelInvoke("purge.setConfig", { enabled: true }),
			/config\.json 已损坏/,
			"a corrupt file must not be replaced by defaults plus one field",
		);
		assert.equal(readFileSync(join(dataDir(it.dir), "config.json"), "utf8"), "{ half a file", "the file is left untouched");
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("an unusable data directory falls back to the plugin's own state/ on both sides", async () => {
	const it = await boot({ blockDataDir: true });
	try {
		const fallback = join(it.dir, "state");
		const state = await it.entry.onPanelInvoke("purge.state", {});
		assert.equal(state.plugin.stateDir, fallback, "the panel picks the same candidate the extension computes");
		assert.deepEqual(state.plugin.configCandidates, [dataDir(it.dir), fallback, join(dirname(dirname(it.dir)), "data", "local.pi-purge")]);

		const written = await it.entry.onPanelInvoke("purge.setConfig", { enabled: true });
		assert.equal(written.config.enabled, true);
		assert.equal(existsSync(join(fallback, "config.json")), true);
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("an oversized persona is previewed partially and flagged", async () => {
	const it = await boot();
	try {
		const big = join(it.dir, "big.md");
		writeFileSync(big, "x".repeat(600 * 1024), "utf8");

		const state = await it.entry.onPanelInvoke("purge.setConfig", { source: big });
		assert.equal(state.persona.oversized, true);
		assert.equal(state.persona.bytes > 512 * 1024, true);
		assert.equal(state.persona.preview.length, 4000, "the preview stays bounded");
		assert.equal(state.persona.previewTruncated, true);
		assert.equal(
			state.persona.warnings.some((line) => /超过 512 KB/.test(line)),
			true,
			"the panel warns that the extension still reads the whole file",
		);
		assert.equal(statSync(big).size, 600 * 1024, "the persona file itself is untouched");
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("a directory or an unknown channel is refused", async () => {
	const it = await boot();
	try {
		const asDirectory = await it.entry.onPanelInvoke("purge.setConfig", { source: it.dir });
		assert.match(asDirectory.persona.error, /目录/);
		await assert.rejects(() => it.entry.onPanelInvoke("purge.nope", {}), /unknown panel channel/);
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("every element the panel looks up exists in the panel document", async () => {
	const html = readFileSync(join(PLUGIN_SOURCE, "renderer", "index.html"), "utf8");
	const script = readFileSync(join(PLUGIN_SOURCE, "renderer", "panel.js"), "utf8");

	const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
	const looked = [...script.matchAll(/el\("([^"]+)"\)/g)].map((match) => match[1]);

	assert.ok(looked.length > 8, "the panel script should look up its controls by id");
	for (const id of looked) {
		assert.ok(ids.has(id), `renderer/index.html has no element with id "${id}"`);
	}
	assert.match(html, /src="panel\.js"/, "the panel document loads the script");
	assert.match(html, /href="panel\.css"/, "the panel document loads the stylesheet");
	assert.match(html, /pi-plugin-chrome/, "the panel tells the host it owns its titlebar spacing");
	assert.match(script, /generation/, "the panel drops poll answers that a write has outdated");
	assert.match(script, /sourceDirty/, "the panel does not overwrite what the user is typing");
});

test("a small persona is re-read even when its size and timestamp did not change", async () => {
	const it = await boot();
	try {
		const file = join(it.dir, "persona.md");
		const old = new Date(Date.now() - 3600_000);

		writeFileSync(file, "AAAA\n", "utf8");
		utimesSync(file, old, old);
		const set = await it.entry.onPanelInvoke("purge.setConfig", { source: file });
		assert.equal(set.persona.preview, "AAAA");

		// Same byte length, same timestamp: only a fresh read can notice the swap, and the
		// panel polls this every 1.5s, so it must not be served the cached preview.
		writeFileSync(file, "BBBB\n", "utf8");
		utimesSync(file, old, old);
		const polled = await it.entry.onPanelInvoke("purge.state", {});
		assert.equal(polled.persona.preview, "BBBB", "polling sees the new content");
		assert.equal(polled.persona.chars, 4);
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("nothing is written into the plugin directory, so a dev load cannot reload itself", async () => {
	const it = await boot();
	try {
		const before = [...readdirSync(it.dir)].sort();
		await it.entry.onPanelInvoke("purge.setConfig", { enabled: true });
		await it.host.commands.get("pi-purge.toggle").run();

		assert.deepEqual([...readdirSync(it.dir)].sort(), before, "the plugin directory is untouched by a write");
		assert.equal(existsSync(join(it.dir, "state-location.json")), false, "the default layout needs no pointer");
		assert.equal(existsSync(join(dataDir(it.dir), "config.json")), true, "the config lives in the data directory");
	} finally {
		it.restore();
		cleanup(it.dir);
	}
});

test("a host data path outside the default layout is handed to the extension by pointer", async () => {
	// A host that answers `pi.plugin.getDataPath()` with something other than the default
	// layout: the pointer next to the manifest is the one file written there, and only then.
	const scratch = mkdtempSync(join(tmpdir(), "pi-purge-custom-"));
	const custom = join(scratch, "plugin-data");
	const second = await boot({ dataPath: custom });
	try {
		const pointer = JSON.parse(readFileSync(join(second.dir, "state-location.json"), "utf8"));
		assert.equal(pointer.stateDir, custom, "the pointer names the host's own directory");

		const state = await second.entry.onPanelInvoke("purge.state", {});
		assert.equal(state.plugin.stateDir, custom, "the panel uses the host's directory");
		const written = await second.entry.onPanelInvoke("purge.setConfig", { enabled: true });
		assert.equal(written.config.enabled, true);
		assert.equal(existsSync(join(custom, "config.json")), true);
		assert.equal(existsSync(join(dataDir(second.dir), "config.json")), false, "the default layout stays empty");
	} finally {
		second.restore();
		cleanup(second.dir);
		rmSync(scratch, { recursive: true, force: true });
	}
});