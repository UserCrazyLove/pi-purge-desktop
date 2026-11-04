"use strict";
/**
 * PI Purge control panel logic.
 *
 * The panel never rewrites a prompt: it writes `config.json` through the plugin's
 * `purge.setConfig` channel and reads back `status.json` (published by the agent
 * extension) with `purge.state`. Everything user-supplied is rendered with textContent,
 * so a persona file cannot inject markup into this window.
 *
 * Two details keep the panel honest while it polls every 1.5s:
 *   - every write bumps `generation`, and a poll response older than the current
 *     generation is discarded, so a slow response can never repaint a stale switch;
 *   - a write renders its own answer immediately instead of waiting for the next poll.
 */
(function () {
	const bridge = window.pluginBridge;
	const POLL_MS = 1500;

	const el = (id) => document.getElementById(id);
	const nodes = {
		pill: el("state-pill"),
		powerNote: el("power-note"),
		toggle: el("toggle-button"),
		modes: el("modes"),
		tabs: el("source-tabs"),
		sourceFile: el("source-file"),
		sourceInput: el("source-input"),
		sourcePick: el("source-pick"),
		sourcePickButton: el("source-pick-button"),
		sourceSave: el("source-save"),
		sourceReload: el("source-reload"),
		previewMeta: el("preview-meta"),
		preview: el("preview"),
		dirBlock: el("dir-block"),
		dirPick: el("dir-pick"),
		dirPickButton: el("dir-pick-button"),
		dirRefresh: el("dir-refresh"),
		dirPath: el("dir-path"),
		fileList: el("file-list"),
		dirHint: el("dir-hint"),
		facts: el("facts"),
		footNote: el("foot-note"),
	};

	/** Last state delivered by the host plugin. */
	let latest = null;
	/** Bumped on every write; polls that started earlier are dropped. */
	let generation = 0;
	let polling = false;
	/** Set when a refresh was skipped because another one was in flight. */
	let refreshAgain = false;
	/** True once the user typed in the path box, so a poll cannot overwrite it. */
	let sourceDirty = false;
	/** Where the switch is heading between a click and its answer, so a double click is honest. */
	let pendingEnabled = null;
	/**
	 * The persona directory listing. Kept beside `latest` on purpose: the panel polls the
	 * switch every 1.5 s, and the file list must not be refetched (or lost) on every poll.
	 */
	let dirState = { dir: "", entries: [], error: "", truncated: false };
	/** True once the remembered directory has been listed for this window. */
	let dirPrimed = false;

	async function invoke(channel, payload) {
		if (!bridge || typeof bridge.invoke !== "function") {
			throw new Error("pluginBridge 不可用：请从 PI-Desktop 的面板打开本页");
		}
		return bridge.invoke(channel, payload ?? {});
	}

	async function toast(message, level = "info") {
		try {
			await invoke("ui.showToast", { message, level });
		} catch {
			/* a toast is a courtesy, not a requirement */
		}
	}

	/** Human-readable "x ago" for an ISO timestamp. */
	function ago(iso) {
		if (!iso) return "";
		const then = Date.parse(iso);
		if (Number.isNaN(then)) return "";
		const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
		if (seconds < 5) return "刚刚";
		if (seconds < 60) return `${seconds} 秒前`;
		if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
		return `${Math.round(seconds / 3600)} 小时前`;
	}

	function buildModes(modes) {
		nodes.modes.replaceChildren(
			...modes.map((mode) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "mode";
				button.dataset.mode = mode.id;
				button.setAttribute("aria-pressed", "false");

				const title = document.createElement("span");
				title.className = "mode-title";
				title.textContent = mode.title;

				const summary = document.createElement("span");
				summary.className = "mode-summary";
				summary.textContent = mode.summary;

				const detail = document.createElement("span");
				detail.className = "mode-detail";
				detail.textContent = mode.detail;

				button.append(title, summary, detail);
				button.addEventListener("click", () => apply({ mode: mode.id }, `模式已切换为 ${mode.id}：下一条消息生效`));
				return button;
			}),
		);
	}

	function renderFacts(state, load = {}) {
		const { config, status, plugin, persona } = state;
		const rows = [];
		const add = (label, value, tone = "") => rows.push({ label, value, tone });

		add("插件", `${plugin.id} · v${plugin.version}`);
		add(
			"配置文件",
			plugin.configError
				? `损坏，无法读写：${plugin.configError}`
				: plugin.configExists
					? `${config.enabled ? "开启" : "关闭"} · ${config.mode}${config.updatedBy ? ` · 由${config.updatedBy === "command" ? "命令" : "面板"}写入（${ago(config.updatedAt)}）` : ""}`
					: "还没写过（扩展默认：关闭 · strict · 内嵌示例）",
			plugin.configError ? "bad" : plugin.configExists ? "" : "muted",
		);
		if (plugin.statusReadError) add("状态文件", `读取失败：${plugin.statusReadError}`, "bad");

		if (!status) {
			add("扩展状态", "本会话还没跑过一轮：发一条消息后这里会显示实际切除结果", "muted");
		} else {
			const expected = config.enabled && !status.enabled;
			add(
				"会话开关",
				expected ? "插件想要开启，扩展仍报告关闭（还没跑过一轮）" : status.enabled ? "开启" : "关闭",
				status.enabled ? "ok" : "muted",
			);
			add("生效模式", String(status.mode ?? "—"));
			add(
				"生效人设",
				status.sourceKind === "embedded"
					? `内嵌示例 · ${status.chars ?? 0} 字符`
					: `${status.source ?? "—"} · ${status.chars ?? 0} 字符`,
				"",
			);
			if (load.liveLoadError) {
				add("人设读取错误", `${load.liveLoadError}（修好后下一条消息自动生效，不必重新开关）`, "bad");
			}
			if (load.staleLoadError) {
				add(
					"上一轮的错误",
					`${load.staleLoadError} —— 那是切换前那份人设留下的；下一条消息起按新设置重算`,
					"muted",
				);
			}
			const cut = status.lastCut ?? {};
			add(
				"上轮切除",
				cut.at
					? `宿主身份段 ${cut.identity ? "已切除" : "未匹配"} · pi 文档段 ${cut.docs ? "已切除" : "未匹配"}`
					: "尚未运行",
				cut.at ? (cut.identity || cut.docs ? "ok" : "muted") : "muted",
			);
			const turn = status.lastTurn ?? {};
			add(
				"最近一轮",
				turn.applied
					? `已改写提示词 · 宿主 ${turn.hostChars ?? 0} 字符 → 送出 ${turn.promptChars ?? 0} 字符（${ago(status.updatedAt)}）`
					: `未改写（开关关闭或人设未加载）· ${ago(status.updatedAt)}`,
				turn.applied ? "ok" : "muted",
			);
			if (status.cwd) add("工作目录", String(status.cwd));
		}
		for (const warning of persona.warnings ?? []) add("提示", warning, "muted");

		nodes.facts.replaceChildren(
			...rows.flatMap((row) => {
				const dt = document.createElement("dt");
				dt.textContent = row.label;
				const dd = document.createElement("dd");
				dd.textContent = row.value;
				if (row.tone) dd.dataset.tone = row.tone;
				return [dt, dd];
			}),
		);
	}

	function render(state) {
		latest = state;
		const { config, persona, status, plugin } = state;

		// `status.json` is written by the extension at the end of a turn, so it describes the
		// persona configured *then*. Once the panel switches persona, an old load error must
		// stop painting the panel red — it would claim the new file is broken.
		const statusMatches = Boolean(status) && String(status.source ?? "") === String(config.source ?? "");
		const staleLoadError = status && !statusMatches ? String(status.loadError ?? "") : "";
		const liveLoadError = statusMatches ? String(status.loadError ?? "") : "";

		const blocked = Boolean(persona.error) || Boolean(liveLoadError) || Boolean(plugin.configError);
		nodes.pill.dataset.state = blocked ? "error" : config.enabled ? "on" : "off";
		nodes.pill.textContent = plugin.configError ? "配置损坏" : blocked ? "需要处理" : config.enabled ? "已开启" : "已关闭";

		const personaError = persona.error || liveLoadError;
		nodes.powerNote.textContent = plugin.configError
			? plugin.configError
			: config.enabled
				? personaError
					? `已开启 · 模式 ${config.mode} · 但人设读不到：${personaError}`
					: `已开启 · 模式 ${config.mode} · 每轮注入 ${status?.chars ?? persona.chars} 字符，下一条消息生效`
				: `已关闭 · 模式 ${config.mode}（保存中）· 宿主系统提示词原样发送`;

		// The answer just arrived, so the clicked direction is no longer "pending".
		pendingEnabled = config.enabled;
		nodes.toggle.disabled = Boolean(plugin.configError);
		nodes.toggle.textContent = config.enabled ? "关闭" : "开启";
		nodes.toggle.dataset.on = config.enabled ? "true" : "false";

		if (!nodes.modes.childElementCount) buildModes(state.modes ?? []);
		for (const button of nodes.modes.querySelectorAll(".mode")) {
			button.setAttribute("aria-pressed", button.dataset.mode === config.mode ? "true" : "false");
		}

		for (const tab of nodes.tabs.querySelectorAll(".tab")) {
			const active = tab.dataset.kind === persona.kind || (tab.dataset.kind === "file" && sourceDirty);
			tab.setAttribute("aria-pressed", active ? "true" : "false");
		}
		if (!sourceDirty && persona.kind === "file" && document.activeElement !== nodes.sourceInput) {
			nodes.sourceInput.value = persona.path;
		}
		// The whole file block only makes sense for a local persona: with the bundled example
		// selected it is noise, so it disappears instead of sitting there disabled.
		nodes.sourceFile.hidden = persona.kind === "embedded" && !sourceDirty;

		if (persona.error) {
			nodes.previewMeta.dataset.tone = "bad";
			nodes.previewMeta.textContent = `读不到人设：${persona.error}`;
			nodes.previewMeta.title = persona.label ?? "";
			nodes.preview.textContent = "";
		} else {
			nodes.previewMeta.dataset.tone = "";
			// The path is already in the field above; here the file name is what identifies it.
			// The bundled persona keeps its own label, which is not a path.
			const label = String(persona.label ?? "");
			const parts = label.split(/[\\/]/);
			const shortLabel =
				persona.kind === "embedded" || parts.length === 1 ? label : parts[parts.length - 1];
			const chars = persona.charsTruncated ? `≥ ${persona.chars}` : `${persona.chars}`;
			const size = persona.bytes ? ` · ${formatBytes(persona.bytes)}` : "";
			nodes.previewMeta.textContent = `${shortLabel} · ${chars} 字符 · ${persona.lines} 行${size}${persona.previewTruncated ? "（预览前 4000 字符）" : ""}`;
			nodes.previewMeta.title = label;
			nodes.preview.textContent = persona.preview || "(空)";
		}

		renderFacts(state, { liveLoadError, staleLoadError });
		nodes.footNote.textContent = plugin.stateDir
			? `状态目录 ${plugin.stateDir}`
			: `状态目录不可用（候选都不可写）：${(plugin.configCandidates ?? []).join(" / ")}`;

		// Keep the file list's "current" mark in step with the persona the panel just showed.
		renderDir();
		if (!dirPrimed && config.sourceDir) {
			// First paint of this window: list the directory the user browsed last time.
			dirPrimed = true;
			chooseDir(config.sourceDir);
		}
	}

	function showFailure(message) {
		nodes.pill.dataset.state = "error";
		nodes.pill.textContent = "读取失败";
		nodes.powerNote.textContent = message;
	}

	async function refresh(force = false) {
		if (!force && document.hidden) return;
		if (polling) {
			// A refresh that arrived while another was in flight must still happen: it may be
			// the one that repaints the switch the user just clicked.
			refreshAgain = true;
			return;
		}
		polling = true;
		const seen = generation;
		try {
			const state = await invoke("purge.state");
			if (!state?.ok) throw new Error("插件没有返回状态");
			// A write that happened while this poll was in flight wins; drop the stale answer.
			if (seen === generation) render(state);
		} catch (error) {
			showFailure(error instanceof Error ? error.message : String(error));
		} finally {
			polling = false;
			if (refreshAgain) {
				refreshAgain = false;
				await refresh(true);
			}
		}
	}

	async function apply(patch, message) {
		generation += 1;
		try {
			const result = await invoke("purge.setConfig", patch);
			if (result?.config) {
				latest = { ...(latest ?? {}), config: result.config, persona: result.persona ?? latest?.persona };
				if (latest.plugin && latest.modes) render(latest);
			}
			if (message) await toast(message, result?.persona?.error ? "error" : "info");
			if (result?.persona?.error) await toast(`人设读取失败：${result.persona.error}`, "error");
			await refresh(true);
		} catch (error) {
			// The write did not land, so the path box is still the user's edit, not the disk's.
			if (patch && typeof patch.source === "string") sourceDirty = true;
			await toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
			await refresh(true);
		}
	}

	/**
	 * Absolute path of a real `File` — from a drop or from the file picker. The host preload
	 * returns a string today; tolerate a promise in case that changes.
	 */
	async function filePathOf(file) {
		if (!bridge || typeof bridge.getDroppedFilePath !== "function") return "";
		try {
			const raw = bridge.getDroppedFilePath(file);
			const value = raw && typeof raw.then === "function" ? await raw : raw;
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	}

	function formatBytes(bytes) {
		const value = Number(bytes) || 0;
		if (value < 1024) return `${value} B`;
		if (value < 1024 * 10) return `${(value / 1024).toFixed(1)} KB`;
		return `${Math.round(value / 1024)} KB`;
	}

	/**
	 * The directory a `webkitdirectory` File came from. The preload hands out absolute paths
	 * only, so Chromium's relative path is what says how many segments to strip.
	 */
	async function pickedDirectory(file) {
		const absolute = await filePathOf(file);
		if (!absolute) return "";
		const relative = String(file.webkitRelativePath || file.name || "");
		const depth = Math.max(1, relative.split("/").length - 1);
		let dir = absolute;
		for (let step = 0; step < depth; step += 1) {
			const cut = Math.max(dir.lastIndexOf("\\"), dir.lastIndexOf("/"));
			if (cut <= 0) break;
			dir = dir.slice(0, cut);
		}
		return dir;
	}

	/** Ask the host to list a directory. `null` when the path is not a readable directory. */
	async function listDir(dir) {
		try {
			const result = await invoke("purge.listDir", { dir });
			if (!result || result.error) return null;
			return result;
		} catch {
			return null;
		}
	}

	/** Remember the directory and list it. The host owns the path, so it normalises it. */
	async function chooseDir(dir) {
		const listing = await listDir(dir);
		dirState = {
			dir: String(listing?.dir || dir || ""),
			entries: Array.isArray(listing?.entries) ? listing.entries : [],
			error: listing ? "" : "读不到这个目录（不存在、没有权限，或者它其实是个文件）",
			truncated: Boolean(listing?.truncated),
		};
		renderDir();
		const remembered = String(latest?.config?.sourceDir ?? "");
		if (listing && dirState.dir && dirState.dir !== remembered) {
			// Remembered so the list is one click away next time; no toast, this is not a
			// persona switch yet.
			await apply({ sourceDir: dirState.dir }, "");
		}
	}

	function renderDir() {
		const dir = dirState.dir || String(latest?.config?.sourceDir ?? "");
		// A long path ellipsized at the end hides the one part that matters — the folder
		// name. Keep the tail and leave the full path in the tooltip.
		const parts = dir.split(/[\\/]/).filter(Boolean);
		const short = dir && dir.length > 48 && parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : dir;
		nodes.dirPath.textContent = short || "还没选目录";
		nodes.dirPath.title = dir;

		const currentPath = String(latest?.persona?.path ?? "");
		const same = (a, b) => Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
		const items = dirState.entries.map((entry) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "file-item";
			const isCurrent = Boolean(entry.current) || same(entry.path, currentPath);
			if (isCurrent) button.dataset.current = "true";
			const name = document.createElement("span");
			name.className = "file-name";
			name.textContent = entry.name;
			name.title = entry.path;
			const meta = document.createElement("span");
			meta.className = "file-meta";
			meta.textContent = `${formatBytes(entry.bytes)}${isCurrent ? " · 当前" : ""}`;
			button.append(name, meta);
			button.addEventListener("click", () => {
				nodes.sourceInput.value = entry.path;
				sourceDirty = false;
				apply({ source: entry.path, sourceDir: dirState.dir }, `人设已切换为 ${entry.name}`);
			});
			const li = document.createElement("li");
			li.append(button);
			return li;
		});

		nodes.fileList.replaceChildren(...items);
		nodes.fileList.hidden = items.length === 0;
		// The directory block (path + refresh + list) only exists once a directory is known.
		nodes.dirBlock.hidden = !dir;
		nodes.dirHint.dataset.tone = "";
		if (dirState.error) {
			nodes.dirHint.dataset.tone = "bad";
			nodes.dirHint.textContent = `目录读取失败：${dirState.error}`;
		} else if (!dir) {
			nodes.dirHint.textContent =
				"选一个文件，或者选一个目录后在列表里点选；也能把文件、整个文件夹拖进窗口。";
		} else if (!items.length) {
			nodes.dirHint.textContent = "这个目录里没有 .md / .markdown / .txt 文件。";
		} else if (dirState.truncated) {
			nodes.dirHint.textContent = `文件太多，只列出前 ${items.length} 个；点一下即刻切换。`;
		} else {
			nodes.dirHint.textContent = `${items.length} 个文件 · 点一下即刻切换（下一条消息生效）`;
		}
	}

	function wireAppearance() {
		const apply2 = (appearance) => {
			const base = appearance?.base;
			document.documentElement.dataset.base =
				base === "light" || base === "dark"
					? base
					: window.matchMedia("(prefers-color-scheme: light)").matches
						? "light"
						: "dark";
			if (typeof appearance?.locale === "string" && appearance.locale) {
				document.documentElement.lang = appearance.locale;
			}
		};
		try {
			bridge?.on?.("appearance:changed", apply2);
		} catch {
			/* older hosts do not broadcast appearance */
		}
		invoke("app.getAppearance").then(apply2).catch(() => apply2(null));
	}

	function wireActions() {
		nodes.toggle.addEventListener("click", () => {
			// The intended state drives the request. `pendingEnabled` keeps a second click that
			// lands during the first round-trip from computing the same direction twice.
			const enabled = !(pendingEnabled ?? latest?.config?.enabled ?? false);
			pendingEnabled = enabled;
			apply({ enabled }, enabled ? "PI Purge 已开启：下一条消息起系统提示词被改写" : "PI Purge 已关闭：恢复宿主原始提示词");
		});

		nodes.tabs.addEventListener("click", (event) => {
			const tab = event.target.closest(".tab");
			if (!tab) return;
			if (tab.dataset.kind === "embedded") {
				sourceDirty = false;
				apply({ source: "embedded" }, "已切回内嵌示例人设");
				return;
			}
			// Switching to the local-file tab reveals the block the previous render hid, so the
			// focus below has something to land in.
			sourceDirty = true;
			nodes.sourceFile.hidden = false;
			nodes.sourceInput.focus();
			nodes.sourceInput.select();
		});

		nodes.sourceInput.addEventListener("input", () => {
			sourceDirty = true;
		});

		nodes.sourceSave.addEventListener("click", () => {
			const value = nodes.sourceInput.value.trim();
			if (!value) {
				toast("先选一个人设文件，或者把它的绝对路径填进来", "error");
				return;
			}
			sourceDirty = false;
			apply({ source: value }, `人设已切换为 ${value}`);
		});

		nodes.sourcePickButton.addEventListener("click", () => {
			// A hidden <input type="file"> is the only web API that opens the OS file picker;
			// the preload turns the chosen File back into an absolute path for us.
			nodes.sourcePick.click();
		});

		nodes.sourcePick.addEventListener("change", async () => {
			const file = nodes.sourcePick.files?.[0];
			// Clearing the value lets the same file be picked twice in a row: without it the
			// picker stays silent when the selection did not change.
			nodes.sourcePick.value = "";
			if (!file) return;
			const path2 = await filePathOf(file);
			if (!path2) {
				await toast("拿不到这个文件的本地路径，手动粘贴绝对路径试试", "error");
				return;
			}
			nodes.sourceInput.value = path2;
			sourceDirty = false;
			await apply({ source: path2 }, `人设已切换为 ${path2}`);
		});

		nodes.sourceInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") nodes.sourceSave.click();
		});

		nodes.sourceReload.addEventListener("click", async () => {
			try {
				const result = await invoke("purge.reloadPersona");
				if (result?.persona?.error) await toast(`预览读取失败：${result.persona.error}`, "error");
				else await toast(`预览已刷新（${result?.persona?.chars ?? 0} 字符）；正文在下一轮生效`);
				await refresh(true);
			} catch (error) {
				await toast(`预览读取失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		});

		nodes.dirPickButton.addEventListener("click", () => nodes.dirPick.click());

		nodes.dirPick.addEventListener("change", async () => {
			const file = nodes.dirPick.files?.[0];
			nodes.dirPick.value = "";
			if (!file) return;
			const dir = await pickedDirectory(file);
			if (!dir) {
				await toast("拿不到这个目录的本地路径，试着把文件夹直接拖进窗口", "error");
				return;
			}
			await chooseDir(dir);
		});

		nodes.dirRefresh.addEventListener("click", async () => {
			await chooseDir(dirState.dir || String(latest?.config?.sourceDir ?? ""));
		});

		for (const type of ["dragenter", "dragover"]) {
			document.addEventListener(type, (event) => {
				event.preventDefault();
				document.body.dataset.dropping = "true";
			});
		}
		for (const type of ["dragleave", "dragend", "drop"]) {
			document.addEventListener(type, (event) => {
				event.preventDefault();
				delete document.body.dataset.dropping;
			});
		}
		document.addEventListener("drop", async (event) => {
			const file = event.dataTransfer?.files?.[0];
			if (!file) return;
			const path2 = await filePathOf(file);
			if (!path2) {
				toast("拿不到这个文件的本地路径", "error");
				return;
			}
			// A dropped folder is a persona *directory*: only the host can tell a directory
			// from a file, so ask it before treating the drop as a persona file.
			const listing = await listDir(path2);
			if (listing) {
				await chooseDir(path2);
				return;
			}
			nodes.sourceInput.value = path2;
			sourceDirty = false;
			apply({ source: path2 }, `人设已切换为 ${path2}`);
		});
	}

	wireAppearance();
	wireActions();
	refresh(true);
	window.setInterval(() => refresh(false), POLL_MS);
})();