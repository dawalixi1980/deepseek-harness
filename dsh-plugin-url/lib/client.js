/**
 * dsh-plugin-url —— client 半（浏览器）。
 *
 * 手写 bundle（非构建产物）：
 *   - 由 host 在 /plugins/dsh-plugin-url/client.js 提供
 *   - 只能 require shell 的 seed 词（react / react/jsx-runtime）
 *   - 在设置页注册「从网址装插件」分区（settings.section slot）
 *
 * 交互模型：粘贴网址 → 点「查找插件」→ 列出仓库里所有 dsh.bundle 包 → 逐个安装。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-url",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx, Fragment } = react_jsx_runtime;

		// ── 样式（手写，前缀 PU_ 避免冲突）────────────────────────────────
		const css = [
			".PU_section{width:100%;max-width:860px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}",
			".PU_hint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
			".PU_row{align-items:center;gap:8px;display:flex}",
			".PU_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:1;min-width:0;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 12px;font-size:13px;box-sizing:border-box}",
			".PU_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".PU_input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}",
			".PU_btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;padding:0 14px;height:36px;font-size:13px;white-space:nowrap;flex:none;transition:background-color .15s ease}",
			".PU_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}",
			".PU_btn:disabled{opacity:.5;cursor:default}",
			".PU_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
			".PU_btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}",
			".PU_msg{margin:0;font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px}",
			".PU_msg[data-kind=err]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}",
			".PU_msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}",
			".PU_meta{align-items:center;gap:8px;display:flex;flex-wrap:wrap;padding:0 2px}",
			".PU_tag{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:5px;align-items:center;padding:1px 6px;font-size:11px;line-height:16px;display:inline-flex}",
			".PU_tag[data-kind=src]{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}",
			".PU_tag[data-kind=warn]{color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent)}",
			".PU_groupHead{align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 16px;display:flex;margin-top:4px}",
			".PU_groupLabel{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:20px}",
			".PU_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}",
			".PU_cards{grid-template-columns:minmax(0,1fr);gap:10px;margin:0;padding:0;list-style:none;display:grid}",
			".PU_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;padding:14px 16px;box-sizing:border-box;display:flex;gap:14px;align-items:flex-start}",
			".PU_cardMain{min-width:0;flex:1;flex-direction:column;gap:5px;display:flex}",
			".PU_cardTitle{align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
			".PU_name{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".PU_ver{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".PU_path{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
			".PU_desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
			".PU_side{flex:none;flex-direction:column;align-items:flex-end;gap:8px;display:flex}",
			".PU_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:18px 2px;margin:0}",
			".PU_spin{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:10px 2px;margin:0}",
			".PU_savedRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap;margin-top:-4px}",
			".PU_savedLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}",
			".PU_chip{align-items:center;gap:6px;display:inline-flex;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:3px 6px 3px 10px;max-width:100%}",
			".PU_chipText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:0;padding:0;font-family:inherit;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".PU_chipText:hover{color:var(--dsw-alias-state-business-primary)}",
			".PU_chipDel{color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:16px;cursor:pointer;background:0 0;border:0;padding:0 2px;font-family:inherit}",
			".PU_chipDel:hover{color:var(--dsw-alias-state-error-primary)}"
		].join("");

		const styleId = "dsh-plugin-url-style";
		if (typeof document !== "undefined" && document.getElementById(styleId) === null) {
			const el = document.createElement("style");
			el.id = styleId;
			el.textContent = css;
			document.head.appendChild(el);
		}
		const c = {
			section: "PU_section", hint: "PU_hint", row: "PU_row", input: "PU_input", btn: "PU_btn",
			msg: "PU_msg", meta: "PU_meta", tag: "PU_tag", groupHead: "PU_groupHead",
			groupLabel: "PU_groupLabel", count: "PU_count", cards: "PU_cards", card: "PU_card",
			cardMain: "PU_cardMain", cardTitle: "PU_cardTitle", name: "PU_name", ver: "PU_ver",
			path: "PU_path", desc: "PU_desc", side: "PU_side", empty: "PU_empty", spin: "PU_spin",
			savedRow: "PU_savedRow", savedLabel: "PU_savedLabel", chip: "PU_chip",
			chipText: "PU_chipText", chipDel: "PU_chipDel"
		};

		// ── 文案 ──────────────────────────────────────────────────────────
		const NS = "settings.pluginUrl";
		const zh = {
			nav: "从网址装插件",
			title: "粘贴网址，发现并安装插件",
			hint: "支持 GitHub 仓库首页、任意子目录、blob / raw 链接，或直接写 owner/repo。会自动递归找出仓库里所有声明了 dsh.bundle 的插件包。安装会把插件目录打成 npm tarball 交给插件管理器装入当前 profile。",
			placeholder: "https://github.com/dawalixi1980/deepseek-harness",
			find: "查找插件",
			finding: "正在下载并扫描仓库…",
			found: "共发现 {n} 个插件",
			ref: "分支",
			path: "路径",
			cached: "缓存命中",
			install: "安装",
			installing: "安装中…",
			reinstall: "重新安装",
			uninstall: "卸载",
			uninstalling: "卸载中…",
			installed: "已安装",
			notInstalled: "未安装",
			disabled: "已停用",
			installedTitle: "已安装的插件",
			installedCount: "{n} 个",
			installedEmpty: "这个 profile 里还没有装过第三方插件。",
			fromRepo: "来自 {owner}/{repo}",
			local: "本地",
			ok: "完成",
			opFailed: "操作失败",
			needUrl: "请先填写网址",
			noPlugins: "这个网址下没有找到任何声明 dsh.bundle 的插件包。",
			refresh: "刷新已装列表",
			loading: "加载中…",
			savedTitle: "已保存的仓库网址",
			savedEmpty: "（还没有保存过网址，成功查找一次就会自动记住）",
			save: "保存当前网址",
			savedOk: "已保存",
			remove: "移除",
			useIt: "填入",
			ready: "可直接装",
			needsBuild: "需要构建",
			missingEntry: "缺入口产物",
			webHalf: "含界面",
			deps: "{n} 个依赖",
			notRemovable: "受管理保护，不能从面板卸载",
			reloadHint: "安装会重载 profile：面板若闪一下属正常，插件已经生效。",
			afterInstall: "{name} — 已安装，如刚生效请刷新页面查看。"
		};
		const en = {
			nav: "Install plugins from URL",
			title: "Paste a URL, discover and install plugins",
			hint: "Supports a GitHub repo homepage, any subdirectory, blob / raw links, or a bare owner/repo. Every package declaring dsh.bundle is discovered recursively. Installation packs the plugin directory into an npm tarball and hands it to the plugin manager for this profile.",
			placeholder: "https://github.com/dawalixi1980/deepseek-harness",
			find: "Find plugins",
			finding: "Downloading and scanning the repository…",
			found: "Found {n} plugins",
			ref: "branch",
			path: "path",
			cached: "cached",
			install: "Install",
			installing: "Installing…",
			reinstall: "Reinstall",
			uninstall: "Uninstall",
			uninstalling: "Uninstalling…",
			installed: "Installed",
			notInstalled: "Not installed",
			disabled: "Disabled",
			installedTitle: "Installed plugins",
			installedCount: "{n}",
			installedEmpty: "No third-party plugin installed in this profile yet.",
			fromRepo: "from {owner}/{repo}",
			local: "local",
			ok: "Done",
			opFailed: "Operation failed",
			needUrl: "Enter a URL first",
			noPlugins: "No package declaring dsh.bundle found under this URL.",
			refresh: "Refresh",
			loading: "Loading…",
			savedTitle: "Saved repository URLs",
			savedEmpty: "(none yet — a successful search remembers the URL automatically)",
			save: "Save this URL",
			savedOk: "Saved",
			remove: "Remove",
			useIt: "Use",
			ready: "Ready",
			needsBuild: "Needs build",
			missingEntry: "No build output",
			webHalf: "Web UI",
			deps: "{n} deps",
			notRemovable: "Protected, cannot be removed from the panel",
			reloadHint: "Installing reloads the profile: a brief flicker is normal and the plugin is live.",
			afterInstall: "{name} — installed; refresh the page if it just took effect."
		};

		/**
		 * 远程 schema codec 工厂。
		 *
		 * 必须声明在 CONTRIBUTION **之前**：CONTRIBUTION 在模块求值阶段就会调用
		 * codec()，而 codec 引用 identity。若 identity 用 const 声明在其后方，
		 * 模块求值会立即抛 "Cannot access 'identity' before initialization"
		 * （暂时性死区），web boot 该项无法激活，整个应用报「无法启动或已意外停止」。
		 * `node --check` 查不出——这是求值顺序错误，语法完全合法。
		 *
		 * 形状必须与 host 半一致：strict codec 要带 `create()` 工厂。
		 */
		const identity = (v) => v;
		function codec(typeSymbol) {
			return { mode: "strict", typeSymbol, create: () => ({ parse: identity }) };
		}

		/** 远程描述符（client 侧声明，用于 $mount）。 */
		const CONTRIBUTION = {
			package: "dsh-plugin-url",
			descriptors: [
				{
					id: "dsh-plugin-url#pluginUrl/inspect",
					service: "pluginUrl", namespace: "pluginUrl", method: "inspect",
					invocation: { kind: "direct" },
					parameters: [{ name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText") }],
					result: codec("dsh-plugin-url#InspectPluginsResult")
				},
				{
					// 线名不能叫 install：RemoteNamespaceService 原型上已有 install()，
					// 挂载时会抛 'method "pluginUrl/install" conflicts with its namespace service'。
					id: "dsh-plugin-url#pluginUrl/installPlugin",
					service: "pluginUrl", namespace: "pluginUrl", method: "installPlugin",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText") },
						{ name: "subpath", wire: "subpath", source: "json", codec: codec("dsh-plugin-url#Subpath") }
					],
					result: codec("dsh-plugin-url#InstallPluginResult")
				},
				{
					id: "dsh-plugin-url#pluginUrl/uninstallPlugin",
					service: "pluginUrl", namespace: "pluginUrl", method: "uninstallPlugin",
					invocation: { kind: "direct" },
					parameters: [{ name: "name", wire: "name", source: "json", codec: codec("dsh-plugin-url#PackageName") }],
					result: codec("dsh-plugin-url#UninstallPluginResult")
				},
				{
					id: "dsh-plugin-url#pluginUrl/listInstalled",
					service: "pluginUrl", namespace: "pluginUrl", method: "listInstalled",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-plugin-url#ListInstalledPluginsResult")
				},
				{
					id: "dsh-plugin-url#pluginUrl/rememberUrl",
					service: "pluginUrl", namespace: "pluginUrl", method: "rememberUrl",
					invocation: { kind: "direct" },
					parameters: [{ name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText") }],
					result: codec("dsh-plugin-url#SavedSitesResult")
				},
				{
					id: "dsh-plugin-url#pluginUrl/recentUrls",
					service: "pluginUrl", namespace: "pluginUrl", method: "recentUrls",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-plugin-url#SavedSitesResult")
				},
				{
					id: "dsh-plugin-url#pluginUrl/forgetUrl",
					service: "pluginUrl", namespace: "pluginUrl", method: "forgetUrl",
					invocation: { kind: "direct" },
					parameters: [{ name: "url", wire: "url", source: "json", codec: codec("dsh-plugin-url#UrlText") }],
					result: codec("dsh-plugin-url#SavedSitesResult")
				}
			]
		};

		// ── 主面板 ────────────────────────────────────────────────────────
		/**
		 * 设置分区主面板。
		 *
		 * DSH 的 slot 宿主把 `inject()` 的返回值**摊平成 props**（内置组件就是
		 * `function AgentPresetSection({ load, view, ... })`），不存在 props.face。
		 * 两种形态都兼容；同时挂载期任何同步抛错都会被 SlotErrorBoundary 变成
		 * 空白分区，所以所有远程调用都包在 try/catch 里，失败就显示红字。
		 */
		function PluginUrlSection(props) {
			const face = props.face ?? props;
			const t = props.t ?? ((k) => k);
			const apiMissing = typeof face?.inspect !== "function" || typeof face?.listInstalled !== "function";
			const [url, setUrl] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [result, setResult] = react.useState(null);
			const [error, setError] = react.useState("");
			const [notice, setNotice] = react.useState("");
			const [pending, setPending] = react.useState({});
			const [local, setLocal] = react.useState(null);
			const [sites, setSites] = react.useState([]);

			const applySites = (list) => setSites(Array.isArray(list) ? list : []);

			const saveSite = (raw, quiet) => {
				const text = String(raw ?? "").trim();
				if (text.length === 0) { if (!quiet) setError(t("needUrl")); return; }
				try {
					if (typeof face?.rememberUrl !== "function") return;
					Promise.resolve(face.rememberUrl(text))
						.then((r) => { applySites(r?.sites); if (quiet !== true) setNotice(t("savedOk") + "：" + text); })
						.catch((e) => { if (quiet !== true) setError(t("opFailed") + "：" + String(e?.message ?? e)); });
				} catch { /* 忽略 */ }
			};

			const forgetSite = (target) => {
				try {
					if (typeof face?.forgetUrl !== "function") return;
					Promise.resolve(face.forgetUrl(target)).then((r) => applySites(r?.sites)).catch(() => {});
				} catch { /* 忽略 */ }
			};

			const refreshLocal = react.useCallback(() => {
				// 挂载即调用：任何同步抛错都会把整个分区打成空白，所以全包住。
				try {
					if (typeof face?.listInstalled !== "function") {
						setError("pluginUrl 服务不可用：远程贡献没有注入到面板。");
						setLocal([]);
						return;
					}
					Promise.resolve(face.listInstalled())
						.then((r) => setLocal(r?.plugins ?? []))
						.catch((e) => { setError(t("opFailed") + "：" + String(e?.message ?? e)); setLocal([]); });
				} catch (err) {
					setError(String(err?.message ?? err));
					setLocal([]);
				}
			}, [face, t]);

			react.useEffect(() => { refreshLocal(); }, [refreshLocal]);

			// 挂载时读已保存的网址，并把上次用过的填进输入框
			react.useEffect(() => {
				try {
					if (typeof face?.recentUrls !== "function") return;
					Promise.resolve(face.recentUrls())
						.then((r) => {
							const list = Array.isArray(r?.sites) ? r.sites : [];
							applySites(list);
							const last = list[0];
							if (last !== undefined && String(last.url ?? "").length > 0) {
								setUrl((current) => (String(current ?? "").length === 0 ? String(last.url) : current));
							}
						})
						.catch(() => {});
				} catch { /* 忽略 */ }
			}, [face]);

			const find = () => {
				const text = url.trim();
				if (text.length === 0) { setError(t("needUrl")); return; }
				if (typeof face?.inspect !== "function") { setError("pluginUrl 服务不可用（host 半可能未加载）"); return; }
				setBusy(true); setError(""); setNotice(""); setResult(null);
				Promise.resolve(face.inspect(text))
					.then((r) => { setResult(r); refreshLocal(); saveSite(text, true); })
					.catch((e) => setError(String(e?.message ?? e)))
					.finally(() => setBusy(false));
			};

			const doInstall = (plugin) => {
				setPending((p) => ({ ...p, [plugin.name]: "install" }));
				setError(""); setNotice("");
				Promise.resolve(face.installPlugin(url.trim(), plugin.subpath))
					.then((r) => {
						setNotice(t("afterInstall").replace("{name}", plugin.name + "@" + r.version));
						refreshLocal();
					})
					.catch((e) => setError(t("opFailed") + "：" + String(e?.message ?? e)))
					.finally(() => setPending((p) => { const n = { ...p }; delete n[plugin.name]; return n; }));
			};

			const doUninstall = (name) => {
				setPending((p) => ({ ...p, [name]: "uninstall" }));
				setError(""); setNotice("");
				Promise.resolve(face.uninstallPlugin(name))
					.then(() => { setNotice(name + " — " + t("uninstall")); refreshLocal(); })
					.catch((e) => setError(t("opFailed") + "：" + String(e?.message ?? e)))
					.finally(() => setPending((p) => { const n = { ...p }; delete n[name]; return n; }));
			};

			const localMap = new Map((local ?? []).map((item) => [item.name, item]));
			const found = result === null ? [] : result.plugins;

			/** 打包就绪度 → 一个标签。 */
			const readinessTag = (plugin) => {
				if (plugin.readiness === "ready") return jsx("span", { className: c.tag, children: t("ready") });
				if (plugin.readiness === "needs-build") {
					return jsx("span", { className: c.tag, "data-kind": "warn", children: t("needsBuild") + " · " + plugin.buildScripts.join(",") });
				}
				return jsx("span", { className: c.tag, "data-kind": "warn", children: t("missingEntry") });
			};

			const cards = found.map((plugin) => {
				const hit = localMap.get(plugin.name);
				const isInstalled = hit !== undefined || plugin.installed;
				const mark = pending[plugin.name];
				return jsx("li", { key: plugin.subpath, className: c.card, children: [
					jsx("div", { className: c.cardMain, children: [
						jsx("div", { className: c.cardTitle, children: [
							jsx("span", { className: c.name, children: plugin.name }),
							jsx("span", { className: c.ver, children: "v" + plugin.version }),
							isInstalled
								? jsx("span", { className: c.tag, "data-kind": "src", children: t("installed") })
								: jsx("span", { className: c.tag, children: t("notInstalled") }),
							readinessTag(plugin),
							plugin.web ? jsx("span", { className: c.tag, children: t("webHalf") }) : null,
							plugin.dependencies.length > 0
								? jsx("span", { className: c.tag, children: t("deps").replace("{n}", String(plugin.dependencies.length)) })
								: null
						] }),
						jsx("div", { className: c.path, children: plugin.subpath }),
						plugin.description.length > 0 ? jsx("p", { className: c.desc, children: plugin.description }) : null
					] }),
					jsx("div", { className: c.side, children: [
						jsx("button", {
							className: c.btn,
							"data-kind": "primary",
							disabled: mark !== undefined,
							onClick: () => doInstall(plugin),
							children: mark === "install" ? t("installing") : (isInstalled ? t("reinstall") : t("install"))
						}),
						isInstalled
							? jsx("button", {
								className: c.btn,
								"data-kind": "danger",
								disabled: mark !== undefined,
								onClick: () => doUninstall(plugin.name),
								children: mark === "uninstall" ? t("uninstalling") : t("uninstall")
							})
							: null
					] })
				] });
			});

			const installedList = local ?? [];

			return jsx("div", { className: c.section, children: [
				jsx("h3", { style: { margin: 0, fontSize: "15px", lineHeight: "22px" }, children: t("title") }),
				apiMissing
					? jsx("p", { className: c.msg, "data-kind": "err", children: "pluginUrl 服务不可用：远程贡献没有注入到面板（host 半未加载或 slot props 形态变化）。" })
					: null,
				jsx("p", { className: c.hint, children: t("hint") }),
				jsx("p", { className: c.hint, children: t("reloadHint") }),

				jsx("div", { className: c.row, children: [
					jsx("input", {
						className: c.input,
						type: "text",
						value: url,
						placeholder: t("placeholder"),
						spellCheck: false,
						onChange: (e) => setUrl(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter" && !busy) find(); }
					}),
					jsx("button", { className: c.btn, "data-kind": "primary", disabled: busy, onClick: find, children: busy ? t("finding") : t("find") })
				] }),

				// 已保存的仓库网址：点文本填入输入框，点 × 移除。
				// ⚠️ react/jsx-runtime 的 jsx(type, props, key) 第三个参数是 key，不是 children。
				// 文本必须写成 props.children，否则会被当 key 吞掉，渲染成空胶囊。
				jsx("div", { className: c.savedRow, children: [
					jsx("span", { className: c.savedLabel, children: t("savedTitle") + "：" }),
					sites.length === 0
						? jsx("span", { className: c.savedLabel, children: t("savedEmpty") })
						: sites.map((site) => jsx("span", { key: site.url, className: c.chip, children: [
							jsx("button", {
								type: "button",
								className: c.chipText,
								title: site.url + "  —— " + t("useIt"),
								onClick: () => { setUrl(site.url); setError(""); setNotice(""); },
								children: site.label.length > 0 ? site.label : site.url
							}),
							jsx("button", {
								type: "button",
								className: c.chipDel,
								title: t("remove"),
								onClick: () => forgetSite(site.url),
								children: "×"
							})
						] })),
					url.trim().length > 0 && !sites.some((site) => site.url === url.trim())
						? jsx("button", { className: c.btn, style: { height: "24px", padding: "0 10px", fontSize: "12px" }, onClick: () => saveSite(url), children: t("save") })
						: null
				] }),

				error.length > 0 ? jsx("p", { className: c.msg, "data-kind": "err", children: error }) : null,
				notice.length > 0 ? jsx("p", { className: c.msg, "data-kind": "ok", children: notice }) : null,
				busy ? jsx("p", { className: c.spin, children: t("finding") }) : null,

				result !== null
					? jsx(Fragment, { children: [
						jsx("div", { className: c.meta, children: [
							jsx("span", { className: c.tag, "data-kind": "src", children: result.owner + "/" + result.repo }),
							jsx("span", { className: c.tag, children: t("ref") + " " + result.ref }),
							result.subpath.length > 0 ? jsx("span", { className: c.tag, children: t("path") + " " + result.subpath }) : null,
							result.cached ? jsx("span", { className: c.tag, children: t("cached") }) : null,
							jsx("span", { className: c.count, children: t("found").replace("{n}", String(found.length)) })
						] }),
						found.length === 0
							? jsx("p", { className: c.empty, children: t("noPlugins") })
							: jsx("ul", { className: c.cards, children: cards })
					] })
					: null,

				jsx("div", { className: c.groupHead, children: [
					jsx("span", { className: c.groupLabel, children: t("installedTitle") }),
					jsx("span", { className: c.count, children: t("installedCount").replace("{n}", String(installedList.length)) }),
					jsx("button", { className: c.btn, style: { height: "28px", padding: "0 10px", fontSize: "12px" }, onClick: refreshLocal, children: t("refresh") })
				] }),
				local === null
					? jsx("p", { className: c.spin, children: t("loading") })
					: installedList.length === 0
						? jsx("p", { className: c.empty, children: t("installedEmpty") })
						: jsx("ul", { className: c.cards, children: installedList.map((plugin) => {
							const mark = pending[plugin.name];
							return jsx("li", { key: "local-" + plugin.name, className: c.card, children: [
								jsx("div", { className: c.cardMain, children: [
									jsx("div", { className: c.cardTitle, children: [
										jsx("span", { className: c.name, children: plugin.name }),
										plugin.version.length > 0 ? jsx("span", { className: c.ver, children: "v" + plugin.version }) : null,
										plugin.enabled ? null : jsx("span", { className: c.tag, children: t("disabled") }),
										plugin.owner !== undefined
											? jsx("span", { className: c.tag, "data-kind": "src", children: t("fromRepo").replace("{owner}", plugin.owner).replace("{repo}", plugin.repo) })
											: jsx("span", { className: c.tag, children: t("local") }),
										plugin.errorCode.length > 0
											? jsx("span", { className: c.tag, "data-kind": "warn", children: plugin.errorCode })
											: null
									] }),
									plugin.subpath !== undefined && plugin.subpath.length > 0
										? jsx("div", { className: c.path, children: plugin.subpath })
										: null,
									plugin.description.length > 0 ? jsx("p", { className: c.desc, children: plugin.description }) : null
								] }),
								jsx("div", { className: c.side, children: jsx("button", {
									className: c.btn,
									"data-kind": "danger",
									disabled: mark !== undefined || plugin.removable !== true,
									title: plugin.removable === true ? t("uninstall") : t("notRemovable"),
									onClick: () => doUninstall(plugin.name),
									children: mark === "uninstall" ? t("uninstalling") : t("uninstall")
								}) })
							] });
						}) })
			] });
		}

		// ── cordis 插件体 ─────────────────────────────────────────────────
		const inject = ["slots", "locale", "remote", "sessions"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-url: dictionaries");
			const t = ctx.locale.bind(NS);

			// 挂载远程贡献；所有远程调用等待挂载完成后再取命名空间服务。
			const mount = ctx.remote.$mount(CONTRIBUTION);
			const callRemote = async (method, ...args) => {
				await mount;
				const remote = ctx.get("remote.pluginUrl");
				if (remote === undefined) {
					throw new Error("pluginUrl 服务不可用（host 半可能未加载）");
				}
				const result = await remote[method](...args);
				if (!result.ok) {
					throw new Error(result.error.code + ": " + result.error.message);
				}
				return result.value;
			};
			const face = () => ({
				inspect: (url) => callRemote("inspect", url),
				installPlugin: (url, subpath) => callRemote("installPlugin", url, subpath),
				uninstallPlugin: (name) => callRemote("uninstallPlugin", name),
				listInstalled: () => callRemote("listInstalled"),
				rememberUrl: (url) => callRemote("rememberUrl", url),
				recentUrls: () => callRemote("recentUrls"),
				forgetUrl: (url) => callRemote("forgetUrl", url)
			});

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "plugin-url",
				order: 19,
				label: () => t("nav"),
				locale: NS,
				inject: face
			}, PluginUrlSection));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.PluginUrlSection = PluginUrlSection;
		return module.exports;
	}
});
