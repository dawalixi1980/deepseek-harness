/**
 * dsh-skill-url —— client 半（浏览器）。
 *
 * 手写 bundle（非构建产物）：
 *   - 由 host 在 /plugins/dsh-skill-url/client.js 提供
 *   - 只能 require shell 的 seed 词（react / react/jsx-runtime）
 *   - 在设置页注册"从网址装技能"分区（settings.section slot）
 *
 * 交互模型：粘贴网址 → 点"查找技能" → 得到技能清单 → 每个技能可单独
 * 安装 / 卸载。
 */
window.__ModuleLoader__.load({
	id: "dsh-skill-url",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx, Fragment } = react_jsx_runtime;

		// ── 样式（手写，前缀 SU_ 避免冲突）────────────────────────────────
		const css = [
			".SU_section{width:100%;max-width:860px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}",
			".SU_hint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
			".SU_row{align-items:center;gap:8px;display:flex}",
			".SU_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:1;min-width:0;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 12px;font-size:13px;box-sizing:border-box}",
			".SU_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".SU_input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}",
			".SU_btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;padding:0 14px;height:36px;font-size:13px;white-space:nowrap;flex:none;transition:background-color .15s ease}",
			".SU_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}",
			".SU_btn:disabled{opacity:.5;cursor:default}",
			".SU_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
			".SU_btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}",
			".SU_msg{margin:0;font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px}",
			".SU_msg[data-kind=err]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}",
			".SU_msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}",
			".SU_meta{align-items:center;gap:8px;display:flex;flex-wrap:wrap;padding:0 2px}",
			".SU_tag{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:5px;align-items:center;padding:1px 6px;font-size:11px;line-height:16px;display:inline-flex}",
			".SU_tag[data-kind=src]{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}",
			".SU_groupHead{align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 16px;display:flex;margin-top:4px}",
			".SU_groupLabel{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:20px}",
			".SU_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}",
			".SU_cards{grid-template-columns:minmax(0,1fr);gap:10px;margin:0;padding:0;list-style:none;display:grid}",
			".SU_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;padding:14px 16px;box-sizing:border-box;display:flex;gap:14px;align-items:flex-start}",
			".SU_cardMain{min-width:0;flex:1;flex-direction:column;gap:5px;display:flex}",
			".SU_cardTitle{align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
			".SU_name{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".SU_path{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
			".SU_desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
			".SU_side{flex:none;flex-direction:column;align-items:flex-end;gap:8px;display:flex}",
			".SU_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:18px 2px;margin:0}",
			".SU_spin{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:10px 2px;margin:0}",
			".SU_busy{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".SU_savedRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap;margin-top:-4px}",
			".SU_savedLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}",
			".SU_chip{align-items:center;gap:6px;display:inline-flex;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:3px 6px 3px 10px;max-width:100%}",
			".SU_chipText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:0;padding:0;font-family:inherit;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".SU_chipText:hover{color:var(--dsw-alias-state-business-primary)}",
			".SU_chipDel{color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:16px;cursor:pointer;background:0 0;border:0;padding:0 2px;font-family:inherit}",
			".SU_chipDel:hover{color:var(--dsw-alias-state-error-primary)}"
		].join("");

		const styleId = "dsh-skill-url-style";
		if (typeof document !== "undefined" && document.getElementById(styleId) === null) {
			const el = document.createElement("style");
			el.id = styleId;
			el.textContent = css;
			document.head.appendChild(el);
		}
		const c = {
			section: "SU_section", hint: "SU_hint", row: "SU_row", input: "SU_input", btn: "SU_btn",
			msg: "SU_msg", meta: "SU_meta", tag: "SU_tag", groupHead: "SU_groupHead",
			groupLabel: "SU_groupLabel", count: "SU_count", cards: "SU_cards", card: "SU_card",
			cardMain: "SU_cardMain", cardTitle: "SU_cardTitle", name: "SU_name", path: "SU_path",
			desc: "SU_desc", side: "SU_side", empty: "SU_empty", spin: "SU_spin", busy: "SU_busy",
			savedRow: "SU_savedRow", savedLabel: "SU_savedLabel", chip: "SU_chip",
			chipText: "SU_chipText", chipDel: "SU_chipDel"
		};

		// ── 文案 ──────────────────────────────────────────────────────────
		const NS = "settings.skillUrl";
		const zh = {
			nav: "从网址装技能",
			title: "粘贴网址，发现并安装技能",
			hint: "支持 GitHub 仓库首页、仓库内任意子目录、blob / raw 链接、skills.sh，或直接写 owner/repo。粘贴后会自动找出里面所有 SKILL.md。",
			placeholder: "https://github.com/anthropics/skills",
			find: "查找技能",
			finding: "正在下载并扫描仓库…",
			found: "共发现 {n} 个技能",
			ref: "分支",
			path: "路径",
			cached: "缓存命中",
			install: "安装",
			installing: "安装中…",
			reinstall: "重新安装",
			uninstall: "卸载",
			uninstalling: "卸载中…",
			installed: "已安装",
			disabled: "已停用",
			notInstalled: "未安装",
			installedTitle: "本地已安装的技能",
			installedCount: "{n} 个",
			installedEmpty: "用户技能目录里还没有技能。",
			fromRepo: "来自 {owner}/{repo}",
			local: "本地",
			ok: "完成",
			opFailed: "操作失败",
			needUrl: "请先填写网址",
			noSkills: "这个网址下没有找到任何 SKILL.md。",
			refresh: "刷新已装列表",
			loading: "加载中…",
			savedTitle: "已保存的仓库网址",
			savedEmpty: "（还没有保存过网址，成功查找一次就会自动记住）",
			save: "保存当前网址",
			savedOk: "已保存",
			remove: "移除",
			useIt: "填入",
			lastUsed: "上次"
		};
		const en = {
			nav: "Install from URL",
			title: "Paste a URL, discover and install skills",
			hint: "Supports a GitHub repo homepage, any subdirectory, blob / raw links, skills.sh, or a bare owner/repo. Every SKILL.md inside is discovered automatically.",
			placeholder: "https://github.com/anthropics/skills",
			find: "Find skills",
			finding: "Downloading and scanning the repository…",
			found: "Found {n} skills",
			ref: "branch",
			path: "path",
			cached: "cached",
			install: "Install",
			installing: "Installing…",
			reinstall: "Reinstall",
			uninstall: "Uninstall",
			uninstalling: "Uninstalling…",
			installed: "Installed",
			disabled: "Disabled",
			notInstalled: "Not installed",
			installedTitle: "Installed skills",
			installedCount: "{n}",
			installedEmpty: "No skills in the user skills directory yet.",
			fromRepo: "from {owner}/{repo}",
			local: "local",
			ok: "Done",
			opFailed: "Operation failed",
			needUrl: "Enter a URL first",
			noSkills: "No SKILL.md found under this URL.",
			refresh: "Refresh",
			loading: "Loading…",
			savedTitle: "Saved repository URLs",
			savedEmpty: "(none yet — a successful search remembers the URL automatically)",
			save: "Save this URL",
			savedOk: "Saved",
			remove: "Remove",
			useIt: "Use",
			lastUsed: "last"
		};

		/**
		 * 远程 schema codec 工厂。
		 *
		 * 必须声明在 CONTRIBUTION 之前：CONTRIBUTION 在**模块求值阶段**就会
		 * 调用 codec()，而 codec 引用 identity。若 identity 用 const 声明在其
		 * 后方，模块求值会立即抛 "Cannot access 'identity' before
		 * initialization"（暂时性死区），导致 web boot 该项无法激活、整个应用
		 * 「无法启动或已意外停止」。
		 *
		 * 注意 `node --check` 查不出这个问题 —— 它是运行时求值顺序错误，
		 * 语法完全合法。test/load-client.mjs 会真实执行本文件来兜住它。
		 *
		 * 形状必须与 host 半一致：strict codec 要带 `create()` 工厂，客户端
		 * 注册表按 `codec.create().parse(value)` 校验（曾写成 `schema: {...}`
		 * 而缺 create，host 侧注册即失败）。test/validate-typert-contract.mjs
		 * 会用 DSH 里真实的校验源码检查这份 CONTRIBUTION。
		 */
		const identity = (v) => v;
		function codec(typeSymbol) {
			return { mode: "strict", typeSymbol, create: () => ({ parse: identity }) };
		}

		/** 远程描述符（client 侧声明，用于 $mount）。 */
		const CONTRIBUTION = {
			package: "dsh-skill-url",
			descriptors: [
				{
					id: "dsh-skill-url#skillUrl/inspect",
					service: "skillUrl", namespace: "skillUrl", method: "inspect",
					invocation: { kind: "direct" },
					parameters: [{ name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText") }],
					result: codec("dsh-skill-url#InspectResult")
				},
				{
					id: "dsh-skill-url#skillUrl/listInstalled",
					service: "skillUrl", namespace: "skillUrl", method: "listInstalled",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-url#SessionId") }],
					result: codec("dsh-skill-url#ListInstalledResult")
				},
				{
					// 方法名不能叫 install：客户端 RemoteNamespaceService 原型上已有
					// install()，挂载时会抛 “method "skillUrl/install" conflicts with
					// its namespace service”。故线名为 installSkill。
					id: "dsh-skill-url#skillUrl/installSkill",
					service: "skillUrl", namespace: "skillUrl", method: "installSkill",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText") },
						{ name: "subpath", wire: "subpath", source: "json", codec: codec("dsh-skill-url#Subpath") }
					],
					result: codec("dsh-skill-url#InstallResult")
				},
				{
					id: "dsh-skill-url#skillUrl/uninstall",
					service: "skillUrl", namespace: "skillUrl", method: "uninstall",
					invocation: { kind: "direct" },
					parameters: [{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-url#SkillName") }],
					result: codec("dsh-skill-url#UninstallResult")
				},
				{
					// 已保存的仓库网址（记住上次用过的地址）
					id: "dsh-skill-url#skillUrl/rememberUrl",
					service: "skillUrl", namespace: "skillUrl", method: "rememberUrl",
					invocation: { kind: "direct" },
					parameters: [{ name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText") }],
					result: codec("dsh-skill-url#SavedSitesResult")
				},
				{
					id: "dsh-skill-url#skillUrl/recentUrls",
					service: "skillUrl", namespace: "skillUrl", method: "recentUrls",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-skill-url#SavedSitesResult")
				},
				{
					id: "dsh-skill-url#skillUrl/forgetUrl",
					service: "skillUrl", namespace: "skillUrl", method: "forgetUrl",
					invocation: { kind: "direct" },
					parameters: [{ name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText") }],
					result: codec("dsh-skill-url#SavedSitesResult")
				}
			]
		};

		// ── 主面板 ────────────────────────────────────────────────────────
		/**
		 * 设置分区主面板。
		 *
		 * 事故记录（第三次）：这里曾写成 `const face = props.face;`。DSH 的 slot
		 * 宿主把 `inject()` 的返回值**摊平成 props**（内置组件就是这么写的：
		 * `function AgentPresetSection({ load, view, makeDefault, t })`），根本
		 * 不存在 `props.face` —— 全 app.asar 里 `props.face` 命中 0 次。
		 * 于是 face === undefined，挂载 effect 里 `face.listInstalled()` 同步抛
		 * TypeError，React 直接把这个 slot 渲染成**空白**（DSH 文档原话：
		 * "a throwing component blanks your slot entry"），而左边导航项是宿主
		 * 画的，所以还在。现在两种形态都兼容，并且缺 API 时给出提示而不是白屏。
		 */
		function SkillUrlSection(props) {
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
			/** 已保存的仓库网址（host 侧 ~/.dsh/dsh-skill-url.json 持久化）。 */
			const [sites, setSites] = react.useState([]);

			const applySites = (list) => setSites(Array.isArray(list) ? list : []);

			const refreshSites = react.useCallback(() => {
				try {
					if (typeof face?.recentUrls !== "function") return;
					Promise.resolve(face.recentUrls()).then((r) => applySites(r?.sites)).catch(() => {});
				} catch { /* 读不到就当没有 */ }
			}, [face]);

			/** 记住当前网址；成功查找后自动调用，也可以点「保存当前网址」手动调用。 */
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
				// 挂载即调用：任何**同步**抛错都会被 SlotErrorBoundary 变成
				// <div data-slot-error>（整个分区一片空白），所以这里全包住，
				// 并把原因显示成红字，绝不白屏。
				try {
					if (typeof face?.listInstalled !== "function") {
						setError("skillUrl 服务不可用：远程贡献没有注入到面板。");
						setLocal([]);
						return;
					}
					Promise.resolve(face.listInstalled())
						.then((r) => setLocal(r?.skills ?? []))
						.catch((e) => { setError(t("opFailed") + "：" + String(e?.message ?? e)); setLocal([]); });
				} catch (err) {
					setError(String(err?.message ?? err));
					setLocal([]);
				}
			}, [face, t]);

			react.useEffect(() => { refreshLocal(); }, [refreshLocal]);

			// 挂载时读已保存的网址，并把**上次用过的**填进输入框（省得每次重贴）
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
				if (typeof face?.inspect !== "function") { setError("skillUrl 服务不可用（host 半可能未加载）"); return; }
				setBusy(true); setError(""); setNotice(""); setResult(null);
				Promise.resolve(face.inspect(text))
					.then((r) => { setResult(r); refreshLocal(); saveSite(text, true); })
					.catch((e) => setError(String(e?.message ?? e)))
					.finally(() => setBusy(false));
			};

			const doInstall = (skill) => {
				setPending((p) => ({ ...p, [skill.name]: "install" }));
				setError(""); setNotice("");
				Promise.resolve(face.install(url.trim(), skill.subpath))
					.then((r) => {
						setNotice(skill.name + " — " + t("ok") + " (" + r.fileCount + " files)");
						refreshLocal();
					})
					.catch((e) => setError(t("opFailed") + "：" + String(e?.message ?? e)))
					.finally(() => setPending((p) => { const n = { ...p }; delete n[skill.name]; return n; }));
			};

			const doUninstall = (name) => {
				setPending((p) => ({ ...p, [name]: "uninstall" }));
				setError(""); setNotice("");
				Promise.resolve(face.uninstall(name))
					.then(() => { setNotice(name + " — " + t("uninstall")); refreshLocal(); })
					.catch((e) => setError(t("opFailed") + "：" + String(e?.message ?? e)))
					.finally(() => setPending((p) => { const n = { ...p }; delete n[name]; return n; }));
			};

			// 安装状态映射：优先用本地列表（最新事实），退回扫描结果
			const localMap = new Map((local ?? []).map((s) => [s.name, s]));

			const found = result === null ? [] : result.skills;

			const cards = found.map((skill) => {
				const hit = localMap.get(skill.name);
				const isInstalled = hit !== undefined || skill.installed;
				const mark = pending[skill.name];
				return jsx("li", { key: skill.subpath, className: c.card, children: [
					jsx("div", { className: c.cardMain, children: [
						jsx("div", { className: c.cardTitle, children: [
							jsx("span", { className: c.name, children: skill.name }),
							isInstalled
								? jsx("span", { className: c.tag, "data-kind": "src", children: t("installed") })
								: jsx("span", { className: c.tag, children: t("notInstalled") })
						] }),
						jsx("div", { className: c.path, children: skill.subpath }),
						skill.description.length > 0 ? jsx("p", { className: c.desc, children: skill.description }) : null
					] }),
					jsx("div", { className: c.side, children: [
						jsx("button", {
							className: c.btn,
							"data-kind": "primary",
							disabled: mark !== undefined,
							onClick: () => doInstall(skill),
							children: mark === "install" ? t("installing") : (isInstalled ? t("reinstall") : t("install"))
						}),
						isInstalled
							? jsx("button", {
								className: c.btn,
								"data-kind": "danger",
								disabled: mark !== undefined,
								onClick: () => doUninstall(skill.name),
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
					? jsx("p", { className: c.msg, "data-kind": "err", children: "skillUrl 服务不可用：远程贡献没有注入到面板（host 半未加载或 slot props 形态变化）。" })
					: null,
				jsx("p", { className: c.hint, children: t("hint") }),

				// 网址输入行
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

				// 已保存的仓库网址：点文本填入输入框，点 × 移除
				//
				// ⚠️ 坑 7：react/jsx-runtime 的 jsx(type, props, key) **第三个参数是 key**，
				// 不是 children。曾写成 `jsx("button", {...}, site.label)`，于是标签文字
				// 被当成 key 吞掉，渲染出一个**空胶囊**（数据是好的，只是没显示）。
				// 文本必须写成 props.children。
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

				// 扫描结果
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
							? jsx("p", { className: c.empty, children: t("noSkills") })
							: jsx("ul", { className: c.cards, children: cards })
					] })
					: null,

				// 已安装列表
				jsx("div", { className: c.groupHead, children: [
					jsx("span", { className: c.groupLabel, children: t("installedTitle") }),
					jsx("span", { className: c.count, children: t("installedCount").replace("{n}", String(installedList.length)) }),
					jsx("button", { className: c.btn, style: { height: "28px", padding: "0 10px", fontSize: "12px" }, onClick: refreshLocal, children: t("refresh") })
				] }),
				local === null
					? jsx("p", { className: c.spin, children: t("loading") })
					: installedList.length === 0
						? jsx("p", { className: c.empty, children: t("installedEmpty") })
						: jsx("ul", { className: c.cards, children: installedList.map((skill) => {
							const mark = pending[skill.name];
							return jsx("li", { key: "local-" + skill.name, className: c.card, children: [
								jsx("div", { className: c.cardMain, children: [
									jsx("div", { className: c.cardTitle, children: [
										jsx("span", { className: c.name, children: skill.name }),
										skill.enabled ? null : jsx("span", { className: c.tag, children: t("disabled") }),
										skill.owner !== undefined
											? jsx("span", { className: c.tag, "data-kind": "src", children: t("fromRepo").replace("{owner}", skill.owner).replace("{repo}", skill.repo) })
											: jsx("span", { className: c.tag, children: t("local") })
									] }),
									jsx("div", { className: c.path, children: skill.path }),
									skill.description.length > 0 ? jsx("p", { className: c.desc, children: skill.description }) : null
								] }),
								jsx("div", { className: c.side, children: jsx("button", {
									className: c.btn, "data-kind": "danger", disabled: mark !== undefined,
									onClick: () => doUninstall(skill.name),
									children: mark === "uninstall" ? t("uninstalling") : t("uninstall")
								}) })
							] });
						}) })
			] });
		}

		// ── cordis 插件体 ─────────────────────────────────────────────────
		const inject = ["slots", "locale", "remote", "sessions"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-url: dictionaries");
			const t = ctx.locale.bind(NS);

			// 挂载远程贡献；所有远程调用等待挂载完成后再取命名空间服务。
			const mount = ctx.remote.$mount(CONTRIBUTION);
			/**
			 * 当前会话 id。host 半的 listInstalled(sessionId) 其实**不使用**这个参数
			 * （它只扫 <dsh home>/skills），所以这里绝不能因为取不到就在挂载阶段抛错：
			 * 设置弹窗里 sessions 服务可能还没有 currentProvideInfo，
			 * 一抛就会被 SlotErrorBoundary 变成空白分区。取不到就返回 undefined
			 * （描述符声明了 acceptsUndefined）。
			 */
			const currentSessionId = () => {
				try {
					return ctx.get("sessions")?.currentProvideInfo?.getSnapshot?.()?.sessionId;
				} catch {
					return undefined;
				}
			};
			const callRemote = async (method, ...args) => {
				await mount;
				const remote = ctx.get("remote.skillUrl");
				if (remote === undefined) {
					throw new Error("skillUrl 服务不可用（host 半可能未加载）");
				}
				const result = await remote[method](...args);
				if (!result.ok) {
					throw new Error(result.error.code + ": " + result.error.message);
				}
				return result.value;
			};
			const face = () => ({
				currentSessionId,
				inspect: (url) => callRemote("inspect", url),
				listInstalled: () => callRemote("listInstalled", currentSessionId()),
				// 面板 API 仍叫 install，但**远程线名**必须避开 install（见 CONTRIBUTION 注释）
				install: (url, subpath) => callRemote("installSkill", url, subpath),
				uninstall: (name) => callRemote("uninstall", name),
				rememberUrl: (url) => callRemote("rememberUrl", url),
				recentUrls: () => callRemote("recentUrls"),
				forgetUrl: (url) => callRemote("forgetUrl", url)
			});

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skill-url",
				order: 18,
				label: () => t("nav"),
				locale: NS,
				inject: face
			}, SkillUrlSection));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.SkillUrlSection = SkillUrlSection;
		return module.exports;
	}
});
