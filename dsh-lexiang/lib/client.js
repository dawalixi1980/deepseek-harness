/**
 * dsh-lexiang —— client 半（浏览器）。
 *
 * 手写 bundle（非构建产物）：由 host 在 /plugins/dsh-lexiang/client.js 提供，
 * 只能 require shell 的 seed 词（react / react/jsx-runtime）。
 *
 * 在设置页注册「乐享知识库」分区，提供：
 *   · 凭证配置（COMPANY_FROM + LEXIANG_TOKEN，填一次即可，刷新/重启后仍在）
 *   · 知识库选择 + 目录树浏览（懒加载子节点）
 *   · 条目正文预览
 *   · 关键词 / 语义检索（显示正文片段与相似度）
 *   · 新建页面 / 文件夹、重命名、删除
 *   · 文件上传（本地文件 → 三步上传到乐享）
 *
 * 踩坑记录（都在这份文件里被真实踩过）：
 *   1. codec/identity 必须声明在 CONTRIBUTION 之前 —— 否则模块求值期 TDZ。
 *   2. strict codec 必须带 `create()` 工厂，否则 client 注册表拒绝。
 *   3. slot 组件的 props 是「注入器返回值被摊平」的结果，没有 props.face，
 *      要用 `props.face ?? props`。
 *   4. 挂载期的同步远程调用必须包 try/catch —— 一抛就被 SlotErrorBoundary
 *      变成空白分区。
 *   5. 远程线名不能撞 RemoteNamespaceService 原型上的保留名。
 *   6. jsx() 的第三个参数是 React key，不是 children —— 文字必须写进
 *      props.children，否则渲染出空元素。
 */
window.__ModuleLoader__.load({
	id: "dsh-lexiang",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx, Fragment } = react_jsx_runtime;

		// ── 样式（前缀 LX_ 避免冲突）────────────────────────────────────
		const css = [
			".LX_section{width:100%;max-width:980px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}",
			".LX_hint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
			".LX_row{align-items:center;gap:8px;display:flex}",
			".LX_rowWrap{align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
			".LX_field{flex-direction:column;gap:5px;display:flex;flex:1;min-width:0}",
			".LX_label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".LX_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;min-width:0;height:34px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 10px;font-size:13px;box-sizing:border-box}",
			".LX_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".LX_input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}",
			".LX_btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;padding:0 12px;height:34px;font-size:13px;white-space:nowrap;flex:none;transition:background-color .15s ease}",
			".LX_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}",
			".LX_btn:disabled{opacity:.5;cursor:default}",
			".LX_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
			".LX_btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}",
			".LX_btn[data-size=sm]{height:26px;font-size:12px;padding:0 8px;border-radius:6px}",
			".LX_msg{margin:0;font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px}",
			".LX_msg[data-kind=err]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}",
			".LX_msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}",
			".LX_msg[data-kind=info]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}",
			".LX_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:12px 14px;box-sizing:border-box;flex-direction:column;gap:10px;display:flex}",
			".LX_cardHead{align-items:center;gap:8px;display:flex;justify-content:space-between}",
			".LX_cardTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".LX_tag{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:5px;align-items:center;padding:1px 6px;font-size:11px;line-height:16px;display:inline-flex}",
			".LX_tag[data-kind=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}",
			".LX_tag[data-kind=warn]{color:var(--dsw-alias-state-warning-primary,#b8860b);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary,#b8860b) 12%, transparent)}",
			".LX_split{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:12px;align-items:start}",
			".LX_pane{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;box-sizing:border-box;padding:10px;min-width:0}",
			".LX_paneHead{align-items:center;gap:6px;display:flex;margin-bottom:8px;justify-content:space-between}",
			".LX_paneTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);line-height:18px}",
			".LX_tree{max-height:380px;overflow:auto;flex-direction:column;gap:1px;display:flex}",
			".LX_node{align-items:center;gap:6px;display:flex;border-radius:6px;padding:4px 6px;cursor:pointer;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);border:0;background:0 0;font-family:inherit;text-align:left;width:100%;box-sizing:border-box}",
			".LX_node:hover{background:var(--dsw-alias-bg-layer-1)}",
			".LX_node[data-active=true]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)}",
			".LX_nodeName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".LX_caret{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px;background:0 0;border:0;cursor:pointer;font-family:inherit;padding:0}",
			".LX_icon{flex:none;font-size:12px}",
			".LX_body{max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".LX_hit{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;flex-direction:column;gap:6px;display:flex;margin-bottom:8px}",
			".LX_hitHead{align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
			".LX_hitTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:18px;flex:1;min-width:0}",
			".LX_snippet{margin:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}",
			".LX_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:14px 2px;margin:0}",
			".LX_busy{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".LX_radio{align-items:center;gap:5px;display:inline-flex;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".LX_sep{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}",
			".LX_kv{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}"
		].join("");

		const styleId = "dsh-lexiang-style";
		if (typeof document !== "undefined" && document.getElementById(styleId) === null) {
			const el = document.createElement("style");
			el.id = styleId;
			el.textContent = css;
			document.head.appendChild(el);
		}
		const c = {
			section: "LX_section", hint: "LX_hint", row: "LX_row", rowWrap: "LX_rowWrap",
			field: "LX_field", label: "LX_label", input: "LX_input", btn: "LX_btn", msg: "LX_msg",
			card: "LX_card", cardHead: "LX_cardHead", cardTitle: "LX_cardTitle", tag: "LX_tag",
			split: "LX_split", pane: "LX_pane", paneHead: "LX_paneHead", paneTitle: "LX_paneTitle",
			tree: "LX_tree", node: "LX_node", nodeName: "LX_nodeName", caret: "LX_caret",
			icon: "LX_icon", body: "LX_body", hit: "LX_hit", hitHead: "LX_hitHead",
			hitTitle: "LX_hitTitle", snippet: "LX_snippet", empty: "LX_empty", busy: "LX_busy",
			radio: "LX_radio", sep: "LX_sep", kv: "LX_kv"
		};

		const NS = "dsh-lexiang";
		const zh = {
			nav: "乐享知识库",
			credTitle: "凭证配置",
			credHint: "填写你在乐享获取的 COMPANY_FROM 与 LEXIANG_TOKEN。凭证只保存在本机 ~/.dsh/dsh-lexiang.json，不会上传，也不会进入任何仓库。",
			companyFrom: "COMPANY_FROM（企业标识）",
			token: "LEXIANG_TOKEN（访问令牌）",
			endpoint: "MCP 端点（留空用默认）",
			save: "保存",
			test: "测试连接",
			clear: "清除凭证",
			saved: "已保存",
			tokenSaved: "已保存（留空则不修改）",
			configured: "已配置",
			notConfigured: "未配置",
			browse: "浏览",
			space: "知识库",
			selectSpace: "请选择知识库",
			personal: "个人知识库",
			refresh: "刷新",
			tree: "目录",
			content: "内容",
			search: "搜索",
			keyword: "关键词",
			semantic: "语义",
			searchPlaceholder: "输入关键词后回车",
			newPage: "新建页面",
			newFolder: "新建文件夹",
			rename: "重命名",
			remove: "删除",
			upload: "上传文件",
			open: "打开",
			noCred: "尚未配置凭证，请先在上方填写并保存。",
			loading: "加载中…",
			emptyDir: "（空目录）",
			selectNode: "在左侧选择一个条目查看内容。",
			confirmRemove: "确定要删除这个条目吗？（乐享中会标记为失效）",
			namePrompt: "请输入名称",
			uploaded: "上传完成",
			tooBig: "文件过大（上限 64 MB）"
		};
		const en = {
			nav: "Lexiang",
			credTitle: "Credentials",
			credHint: "Enter the COMPANY_FROM and LEXIANG_TOKEN from Lexiang. They are stored locally in ~/.dsh/dsh-lexiang.json only.",
			companyFrom: "COMPANY_FROM",
			token: "LEXIANG_TOKEN",
			endpoint: "MCP endpoint (optional)",
			save: "Save",
			test: "Test",
			clear: "Clear",
			saved: "Saved",
			tokenSaved: "Saved (leave blank to keep)",
			configured: "Configured",
			notConfigured: "Not configured",
			browse: "Browse",
			space: "Knowledge base",
			selectSpace: "Select a knowledge base",
			personal: "Personal space",
			refresh: "Refresh",
			tree: "Entries",
			content: "Content",
			search: "Search",
			keyword: "Keyword",
			semantic: "Semantic",
			searchPlaceholder: "Type a query and press Enter",
			newPage: "New page",
			newFolder: "New folder",
			rename: "Rename",
			remove: "Delete",
			upload: "Upload",
			open: "Open",
			noCred: "No credentials yet — fill the form above and save.",
			loading: "Loading…",
			emptyDir: "(empty)",
			selectNode: "Pick an entry on the left to read it.",
			confirmRemove: "Delete this entry? (it will be invalidated in Lexiang)",
			namePrompt: "Enter a name",
			uploaded: "Upload complete",
			tooBig: "File too large (64 MB max)"
		};

		// ── 远程 schema codec ─────────────────────────────────────────────
		// 必须声明在 CONTRIBUTION 之前（见文件头踩坑 1/2）。
		const identity = (v) => v;
		function codec(typeSymbol) {
			return { mode: "strict", typeSymbol, create: () => ({ parse: identity }) };
		}
		const json = (typeSymbol) => codec(typeSymbol);

		/** 构造一个「单 JSON 参数」描述符。 */
		function desc(method, typeSymbol) {
			return {
				id: `dsh-lexiang#lexiang/${method}`,
				service: "lexiang",
				namespace: "lexiang",
				method,
				invocation: { kind: "direct" },
				parameters: [
					{ name: "args", wire: "args", source: "json", acceptsUndefined: true, codec: json(`dsh-lexiang#${method}Args`) }
				],
				result: json(`dsh-lexiang#${method}Result`)
			};
		}

		const METHODS = [
			"getSettings", "saveSettings", "clearSettings", "testConnection",
			"listTeams", "listSpaces", "describeSpace", "listChildren", "readEntry",
			"search", "createEntry", "renameEntry", "moveEntry", "removeEntry", "uploadFile",
			"debugLog"
		];

		const CONTRIBUTION = {
			package: "dsh-lexiang",
			descriptors: METHODS.map((m) => desc(m))
		};

		// ── 小工具 ────────────────────────────────────────────────────────
		const fmtTime = (sec) => {
			const n = Number(sec);
			if (!Number.isFinite(n) || n <= 0) return "";
			try {
				const d = new Date(n * 1000);
				const p = (x) => String(x).padStart(2, "0");
				return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
			} catch {
				return "";
			}
		};
		const iconOf = (e) => {
			if (e.type === "folder") return "📁";
			if (e.type === "file") return "📎";
			if (e.extension === "md" || e.type === "page") return "📄";
			return "📄";
		};

		// ── 目录树节点 ────────────────────────────────────────────────────
		/**
		 * 递归渲染一个条目。子节点懒加载：只有展开过才请求。
		 * 注意 props 摊平问题（踩坑 3）：本组件由父级显式传 face。
		 */
		function TreeNode({ entry, depth, face, activeId, onPick, onError }) {
			const [open, setOpen] = react.useState(false);
			const [kids, setKids] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			const toggle = react.useCallback(async (ev) => {
				if (ev) ev.stopPropagation();
				if (!entry.hasChildren && entry.type !== "folder") return;
				if (open) { setOpen(false); return; }
				setOpen(true);
				if (kids !== null) return;
				setBusy(true);
				try {
					const r = await face.listChildren({ parentId: entry.id });
					setKids(r.entries || []);
				} catch (err) {
					onError?.(err);
					setKids([]);
				} finally {
					setBusy(false);
				}
			}, [entry, open, kids, face, onError]);

			const expandable = entry.hasChildren || entry.type === "folder";
			return jsx(Fragment, {
				children: [
					jsx("button", {
						key: "n",
						type: "button",
						className: c.node,
						"data-active": activeId === entry.id ? "true" : "false",
						style: { paddingLeft: `${6 + depth * 14}px` },
						onClick: () => onPick(entry),
						children: [
							expandable
								? jsx("span", {
										key: "c",
										className: c.caret,
										onClick: toggle,
										children: busy ? "…" : open ? "▼" : "▶"
									})
								: jsx("span", { key: "c", className: c.caret, children: "" }),
							jsx("span", { key: "i", className: c.icon, children: iconOf(entry) }),
							jsx("span", { key: "t", className: c.nodeName, children: entry.name }),
							entry.validity && entry.validity !== "none"
								? jsx("span", { key: "v", className: c.tag, "data-kind": "warn", children: "失效" })
								: null
						]
					}),
					open && kids
						? kids.map((k) =>
								jsx(TreeNode, {
									key: k.id,
									entry: k,
									depth: depth + 1,
									face,
									activeId,
									onPick,
									onError
								})
							)
						: null
				]
			});
		}

		// ── 主面板 ────────────────────────────────────────────────────────
		/**
		 * 事故记录：这里曾写成 `const face = props.face`，导致整片空白。
		 * DSH 的 slot 注入器返回值会被**摊平**进 props，所以 face 的方法直接
		 * 挂在 props 上；props.face 并不存在。用 `props.face ?? props` 兼容两种。
		 */
		function LexiangSection(props) {
			const face = props.face ?? props;
			const t = props.t || ((k) => zh[k] || k);

			const [settings, setSettings] = react.useState(null);
			const [form, setForm] = react.useState({ companyFrom: "", token: "", endpoint: "" });
			const [msg, setMsg] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [teams, setTeams] = react.useState([]);
			const [spaces, setSpaces] = react.useState([]);
			const [spaceId, setSpaceId] = react.useState("");
			const [rootId, setRootId] = react.useState("");
			const [tree, setTree] = react.useState([]);
			const [picked, setPicked] = react.useState(null);
			const [body, setBody] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [mode, setMode] = react.useState("keyword");
			const [hits, setHits] = react.useState(null);
			const [fatal, setFatal] = react.useState("");
			const fileRef = react.useRef(null);

			const say = (kind, text) => setMsg({ kind, text });
			const guard = react.useCallback(
				async (label, fn) => {
					setBusy(label);
					try {
						return await fn();
					} catch (err) {
						const m = err && err.message ? err.message : String(err);
						setMsg({ kind: "err", text: m });
						return null;
					} finally {
						setBusy("");
					}
				},
				[]
			);

			// 首次挂载：读凭证。任何异常都要吞掉并显示红字，绝不抛出（踩坑 4）。
			react.useEffect(() => {
				let alive = true;
				(async () => {
					// 诊断：把 DSH 实际传入的 props 结构报给 host 落盘。
					// 面板空白时这是唯一能拿到真相的途径（renderer 没有 fs 权限）。
					try {
						if (typeof face.debugLog === "function") {
							const keys = Object.keys(props);
							const snapshot = {};
							for (const k of keys) {
								const v = props[k];
								if (typeof v === "function") snapshot[k] = "[function]";
								else if (v === null || v === undefined) snapshot[k] = String(v);
								else if (typeof v === "object") {
									try { snapshot[k] = "[object keys=" + Object.keys(v).slice(0, 25).join(",") + "]"; }
									catch { snapshot[k] = "[object]"; }
								} else snapshot[k] = String(v).slice(0, 120);
							}
							await face.debugLog({
								propKeys: keys,
								snapshot,
								hasT: typeof props.t,
								hasFace: typeof props.face,
								hasGetSettings: typeof face.getSettings,
								faceIsProps: face === props,
								ns: NS
							});
						}
					} catch { /* 诊断失败不影响主流程 */ }

					try {
						if (typeof face.getSettings !== "function") {
							if (alive) setFatal("远程服务未就绪：face.getSettings 不可用（host 半可能未加载或线名不匹配）");
							return;
						}
						const s = await face.getSettings();
						if (!alive) return;
						setSettings(s);
						setForm((f) => ({ ...f, companyFrom: s.companyFrom || "", endpoint: s.endpoint || "" }));
					} catch (err) {
						if (alive) setFatal(`初始化失败：${err && err.message ? err.message : err}`);
					}
				})();
				return () => { alive = false; };
			}, [face]);

			// 已配置时自动拉团队与知识库。
			const loadSpaces = react.useCallback(async () => {
				if (!settings?.configured) return;
				const ts = await face.listTeams();
				setTeams(ts.teams || []);
				const teamId = ts.teams && ts.teams[0] ? ts.teams[0].id : undefined;
				const ps = await face.listSpaces({ teamId });
				setSpaces(ps.spaces || []);
				// 个人库也放进来，方便一键切换。
				try {
					const personal = await face.describeSpace({});
					if (personal && personal.id) {
						setSpaces((prev) =>
							prev.some((s) => s.id === personal.id)
								? prev
								: [{ id: personal.id, name: `${personal.name}（个人）`, rootEntryId: personal.rootEntryId }, ...prev]
						);
						setSpaceId((cur) => cur || personal.id);
						setRootId((cur) => cur || personal.rootEntryId);
					}
				} catch { /* 个人库不可用时忽略 */ }
			}, [face, settings]);

			react.useEffect(() => {
				if (!settings?.configured) return;
				guard("加载知识库", loadSpaces);
			}, [settings?.configured, loadSpaces, guard]);

			const loadTree = react.useCallback(
				async (parentId) => {
					if (!parentId) return;
					const r = await face.listChildren({ parentId });
					setTree(r.entries || []);
				},
				[face]
			);

			const onPickSpace = async (id) => {
				setSpaceId(id);
				setPicked(null);
				setBody("");
				setHits(null);
				const known = spaces.find((s) => s.id === id);
				let root = known && known.rootEntryId;
				if (!root) {
					const d = await guard("加载知识库", () => face.describeSpace({ spaceId: id }));
					root = d && d.rootEntryId;
				}
				setRootId(root || "");
				if (root) await guard("加载目录", () => loadTree(root));
			};

			const onPickEntry = async (entry) => {
				setPicked(entry);
				setBody("");
				const r = await guard("读取内容", () => face.readEntry({ entryId: entry.id }));
				if (r) setBody(r.body || "（此条目没有正文，可能是文件夹或文件）");
			};

			const doSearch = async () => {
				const q = query.trim();
				if (!q) return;
				const r = await guard("搜索", () => face.search({ query: q, mode, spaceId: spaceId || undefined, limit: 20 }));
				if (r) setHits(r);
			};

			const doSave = async () => {
				const r = await guard("保存凭证", () =>
					face.saveSettings({
						companyFrom: form.companyFrom,
						token: form.token,
						endpoint: form.endpoint
					})
				);
				if (r) {
					setSettings(r);
					setForm((f) => ({ ...f, token: "" }));
					say("ok", t("saved"));
				}
			};

			const doTest = async () => {
				const r = await guard("测试连接", () => face.testConnection());
				if (r) say("ok", `${r.staffName} @ ${r.companyName}`);
			};

			const doClear = async () => {
				const r = await guard("清除凭证", () => face.clearSettings());
				if (r) {
					setSettings(r);
					setSpaces([]);
					setTree([]);
					setPicked(null);
					setBody("");
					setHits(null);
					say("info", t("notConfigured"));
				}
			};

			const doCreate = async (type) => {
				const parentId = picked && picked.type === "folder" ? picked.id : rootId;
				if (!parentId) { say("err", "请先选择知识库或文件夹"); return; }
				const name = window.prompt(t("namePrompt"));
				if (!name) return;
				const r = await guard("创建", () => face.createEntry({ parentId, name, type }));
				if (r) {
					say("ok", `${r.name} ✓`);
					if (picked && picked.type === "folder") await guard("刷新", () => onPickEntry(picked));
					else await guard("刷新", () => loadTree(rootId));
				}
			};

			const doRename = async () => {
				if (!picked) return;
				const name = window.prompt(t("namePrompt"), picked.name);
				if (!name || name === picked.name) return;
				const r = await guard("重命名", () => face.renameEntry({ entryId: picked.id, name }));
				if (r) {
					say("ok", `${r.name} ✓`);
					await guard("刷新", () => loadTree(rootId));
					setPicked((p) => (p ? { ...p, name: r.name } : p));
				}
			};

			const doRemove = async () => {
				if (!picked) return;
				if (!window.confirm(t("confirmRemove"))) return;
				const r = await guard("删除", () => face.removeEntry({ entryId: picked.id }));
				if (r) {
					say("ok", `${picked.name} 已删除`);
					setPicked(null);
					setBody("");
					await guard("刷新", () => loadTree(rootId));
				}
			};

			const doUpload = async (ev) => {
				const file = ev.target.files && ev.target.files[0];
				ev.target.value = "";
				if (!file) return;
				if (file.size > 64 * 1024 * 1024) { say("err", t("tooBig")); return; }
				const parentId = picked && picked.type === "folder" ? picked.id : rootId;
				if (!parentId) { say("err", "请先选择知识库或文件夹"); return; }
				const b64 = await new Promise((resolve, reject) => {
					const fr = new FileReader();
					fr.onload = () => {
						const s = String(fr.result || "");
						resolve(s.slice(s.indexOf(",") + 1));
					};
					fr.onerror = () => reject(new Error("读取本地文件失败"));
					fr.readAsDataURL(file);
				});
				const r = await guard("上传", () =>
					face.uploadFile({
						parentId,
						fileName: file.name,
						contentBase64: b64,
						mimeType: file.type || "application/octet-stream"
					})
				);
				if (r) {
					say("ok", `${t("uploaded")}：${r.name}`);
					if (picked && picked.type === "folder") await guard("刷新", () => onPickEntry(picked));
					else await guard("刷新", () => loadTree(rootId));
				}
			};

			// 渲染状态信标：每次渲染后把组件内部状态报给 host 落盘。面板空白时，
			// 这是唯一能看出「组件到底渲染到哪一步」的办法。
			react.useEffect(() => {
				try {
					if (typeof face.debugLog === "function") {
						const keys = settings && typeof settings === "object" ? Object.keys(settings) : [];
						face.debugLog({
							phase: "render",
							settingsIsObject: !!(settings && typeof settings === "object"),
							settingsKeys: keys,
							configured: !!(settings && settings.configured),
							fatal: fatal || "",
							busy: busy || ""
						}).catch(() => {});
					}
				} catch { /* ignore */ }
			});

			// 致命错误：显示红字而不是空白（踩坑 4）。
			if (fatal) {
				return jsx("div", { className: c.section, children: jsx("p", { className: c.msg, "data-kind": "err", children: fatal }) });
			}
			if (!settings || typeof settings !== "object") {
				// 硬编码兜底：即使 t() 因 locale 未就绪而返回空，也必须显示可见文字，
				// 否则「面板空白」会被误判成组件崩溃。
				// 用 `!settings` 而不是 `=== null`：getSettings 若解析成 undefined，
				// 下面 settings.configured 会在 try 之外抛错 → 整块变空白。
				return jsx("div", {
					className: c.section,
					children: jsx("p", { className: c.busy, children: `${t("loading") || "加载中…"}（正在读取凭证…）` })
				});
			}

			// 渲染护栏：所有 hook 都已在上方调用完毕，所以这里能用 try/catch 包住整段
			// JSX 构建。否则组件一抛错就被 SlotErrorBoundary 变成**完全空白**，排查时
			// 什么都看不到（这次就吃了这个亏）。宁可显示一行红字。
			// `configured` 必须在 try 之内求值，否则它抛错时护栏也救不了。
			try {
				const configured = Boolean(settings.configured);
				return jsx("div", {
					className: c.section,
				children: [
					// ── 凭证 ──────────────────────────────────────────────
					jsx("div", {
						key: "cred",
						className: c.card,
						children: [
							jsx("div", {
								key: "h",
								className: c.cardHead,
								children: [
									jsx("span", { key: "t", className: c.cardTitle, children: t("credTitle") }),
									jsx("span", {
										key: "s",
										className: c.tag,
										"data-kind": configured ? "ok" : "warn",
										children: configured ? t("configured") : t("notConfigured")
									})
								]
							}),
							jsx("p", { key: "hint", className: c.hint, children: t("credHint") }),
							jsx("div", {
								key: "f",
								className: c.rowWrap,
								children: [
									jsx("div", {
										key: "cf",
										className: c.field,
										children: [
											jsx("label", { key: "l", className: c.label, children: t("companyFrom") }),
											jsx("input", {
												key: "i",
												className: c.input,
												value: form.companyFrom,
												placeholder: "32 位十六进制企业标识",
												onChange: (e) => setForm((f) => ({ ...f, companyFrom: e.target.value }))
											})
										]
									}),
									jsx("div", {
										key: "tk",
										className: c.field,
										children: [
											jsx("label", { key: "l", className: c.label, children: t("token") }),
											jsx("input", {
												key: "i",
												className: c.input,
												type: "password",
												value: form.token,
												placeholder: settings.hasToken ? settings.tokenMasked : "lxmcp_…",
												onChange: (e) => setForm((f) => ({ ...f, token: e.target.value }))
											})
										]
									}),
									jsx("div", {
										key: "ep",
										className: c.field,
										children: [
											jsx("label", { key: "l", className: c.label, children: t("endpoint") }),
											jsx("input", {
												key: "i",
												className: c.input,
												value: form.endpoint,
												placeholder: "https://mcp.lexiang-app.com/mcp",
												onChange: (e) => setForm((f) => ({ ...f, endpoint: e.target.value }))
											})
										]
									})
								]
							}),
							jsx("div", {
								key: "btn",
								className: c.rowWrap,
								children: [
									jsx("button", {
										key: "s", type: "button", className: c.btn, "data-kind": "primary",
										disabled: busy !== "", onClick: doSave, children: t("save")
									}),
									jsx("button", {
										key: "t", type: "button", className: c.btn,
										disabled: busy !== "" || !configured, onClick: doTest, children: t("test")
									}),
									jsx("button", {
										key: "c", type: "button", className: c.btn, "data-kind": "danger",
										disabled: busy !== "", onClick: doClear, children: t("clear")
									}),
									busy ? jsx("span", { key: "b", className: c.busy, children: `${busy}…` }) : null
								]
							}),
							jsx("div", { key: "kv", className: c.kv, children: `state: ${settings.stateFile || "~/.dsh/dsh-lexiang.json"}` }),
							msg ? jsx("p", { key: "m", className: c.msg, "data-kind": msg.kind, children: msg.text }) : null
						]
					}),

					// ── 未配置提示 ────────────────────────────────────────
					configured
						? null
						: jsx("p", { key: "nocred", className: c.msg, "data-kind": "info", children: t("noCred") }),

					// ── 浏览 ──────────────────────────────────────────────
					configured
						? jsx("div", {
								key: "browse",
								className: c.card,
								children: [
									jsx("div", {
										key: "h",
										className: c.cardHead,
										children: [
											jsx("span", { key: "t", className: c.cardTitle, children: t("browse") }),
											jsx("div", {
												key: "a",
												className: c.row,
												children: [
													jsx("button", {
														key: "np", type: "button", className: c.btn, "data-size": "sm",
														disabled: busy !== "", onClick: () => doCreate("page"), children: t("newPage")
													}),
													jsx("button", {
														key: "nf", type: "button", className: c.btn, "data-size": "sm",
														disabled: busy !== "", onClick: () => doCreate("folder"), children: t("newFolder")
													}),
													jsx("button", {
														key: "up", type: "button", className: c.btn, "data-size": "sm",
														disabled: busy !== "", onClick: () => fileRef.current && fileRef.current.click(),
														children: t("upload")
													}),
													jsx("input", {
														key: "fi", ref: fileRef, type: "file", style: { display: "none" }, onChange: doUpload
													})
												]
											})
										]
									}),
									jsx("div", {
										key: "sel",
										className: c.rowWrap,
										children: [
											jsx("label", { key: "l", className: c.label, children: t("space") }),
											jsx("select", {
												key: "s",
												className: c.input,
												style: { maxWidth: "340px" },
												value: spaceId,
												onChange: (e) => onPickSpace(e.target.value),
												children: [
													jsx("option", { key: "0", value: "", children: t("selectSpace") }),
													...spaces.map((s) => jsx("option", { key: s.id, value: s.id, children: s.name }))
												]
											}),
											jsx("button", {
												key: "r", type: "button", className: c.btn, "data-size": "sm",
												disabled: busy !== "" || !rootId, onClick: () => guard("刷新", () => loadTree(rootId)),
												children: t("refresh")
											})
										]
									}),
									jsx("div", {
										key: "split",
										className: c.split,
										children: [
											jsx("div", {
												key: "tree",
												className: c.pane,
												children: [
													jsx("div", { key: "h", className: c.paneHead, children: jsx("span", { key: "t", className: c.paneTitle, children: t("tree") }) }),
													jsx("div", {
														key: "b",
														className: c.tree,
														children:
															tree.length === 0
																? jsx("p", { className: c.empty, children: rootId ? t("emptyDir") : t("selectSpace") })
																: tree.map((e) =>
																		jsx(TreeNode, {
																			key: e.id,
																			entry: e,
																			depth: 0,
																			face,
																			activeId: picked && picked.id,
																			onPick: onPickEntry,
																			onError: (err) => say("err", err && err.message ? err.message : String(err))
																		})
																	)
													})
												]
											}),
											jsx("div", {
												key: "content",
												className: c.pane,
												children: [
													jsx("div", {
														key: "h",
														className: c.paneHead,
														children: [
															jsx("span", { key: "t", className: c.paneTitle, children: picked ? picked.name : t("content") }),
															jsx("div", {
																key: "a",
																className: c.row,
																children: [
																	picked
																		? jsx("button", {
																				key: "rn", type: "button", className: c.btn, "data-size": "sm",
																				disabled: busy !== "", onClick: doRename, children: t("rename")
																			})
																		: null,
																	picked
																		? jsx("button", {
																				key: "rm", type: "button", className: c.btn, "data-size": "sm", "data-kind": "danger",
																				disabled: busy !== "", onClick: doRemove, children: t("remove")
																			})
																		: null
																]
															})
														]
													}),
													picked
														? jsx(Fragment, {
																children: [
																	jsx("div", {
																		key: "meta",
																		className: c.rowWrap,
																		children: [
																			jsx("span", { key: "ty", className: c.tag, children: picked.type }),
																			picked.extension ? jsx("span", { key: "ex", className: c.tag, children: picked.extension }) : null,
																			picked.editedAt ? jsx("span", { key: "ed", className: c.tag, children: fmtTime(picked.editedAt) }) : null,
																			jsx("span", { key: "id", className: c.tag, children: picked.id.slice(0, 10) + "…" })
																		]
																	}),
																	jsx("pre", { key: "body", className: c.body, children: body || t("loading") })
																]
															})
														: jsx("p", { key: "e", className: c.empty, children: t("selectNode") })
												]
											})
										]
									})
								]
							})
						: null,

					// ── 搜索 ──────────────────────────────────────────────
					configured
						? jsx("div", {
								key: "search",
								className: c.card,
								children: [
									jsx("div", { key: "h", className: c.cardHead, children: jsx("span", { key: "t", className: c.cardTitle, children: t("search") }) }),
									jsx("div", {
										key: "row",
										className: c.rowWrap,
										children: [
											jsx("input", {
												key: "q",
												className: c.input,
												style: { flex: 1, minWidth: "220px" },
												value: query,
												placeholder: t("searchPlaceholder"),
												onChange: (e) => setQuery(e.target.value),
												onKeyDown: (e) => { if (e.key === "Enter") doSearch(); }
											}),
											jsx("label", {
												key: "kw",
												className: c.radio,
												children: [
													jsx("input", {
														key: "i", type: "radio", name: "lx-mode", checked: mode === "keyword",
														onChange: () => setMode("keyword")
													}),
													t("keyword")
												]
											}),
											jsx("label", {
												key: "sm",
												className: c.radio,
												children: [
													jsx("input", {
														key: "i", type: "radio", name: "lx-mode", checked: mode === "semantic",
														onChange: () => setMode("semantic")
													}),
													t("semantic")
												]
											}),
											jsx("button", {
												key: "go", type: "button", className: c.btn, "data-kind": "primary",
												disabled: busy !== "", onClick: doSearch, children: t("search")
											})
										]
									}),
									hits === null
										? null
										: hits.hits.length === 0
											? jsx("p", { key: "none", className: c.empty, children: "没有匹配结果" })
											: jsx("div", {
													key: "list",
													children: [
														jsx("p", {
															key: "sum",
															className: c.kv,
															children: `${hits.mode === "semantic" ? "语义" : "关键词"}检索 · 命中 ${hits.hits.length} 条${hits.total ? ` / 共 ${hits.total}` : ""}`
														}),
														...hits.hits.map((h, i) =>
															jsx("div", {
																key: `${h.id}-${i}`,
																className: c.hit,
																children: [
																	jsx("div", {
																		key: "h",
																		className: c.hitHead,
																		children: [
																			jsx("span", { key: "t", className: c.hitTitle, children: h.title }),
																			h.fileType ? jsx("span", { key: "f", className: c.tag, children: h.fileType }) : null,
																			h.score !== null ? jsx("span", { key: "s", className: c.tag, children: `score ${h.score}` }) : null
																		]
																	}),
																	h.snippet ? jsx("p", { key: "p", className: c.snippet, children: h.snippet }) : null
																]
															})
														)
													]
												})
								]
							})
						: null
				]
			});
			} catch (err) {
				const m = err && err.message ? err.message : String(err);
				return jsx("div", {
					className: c.section,
					children: [
						jsx("p", { key: "e", className: c.msg, "data-kind": "err", children: `渲染失败：${m}` }),
						jsx("pre", {
							key: "s",
							className: c.kv,
							children: err && err.stack ? String(err.stack).split("\n").slice(0, 6).join("\n") : ""
						})
					]
				});
			}
		}

		// ── cordis 插件体 ─────────────────────────────────────────────────
		const inject = ["slots", "locale", "remote"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-lexiang: dictionaries");
			const t = ctx.locale.bind(NS);

			const mount = ctx.remote.$mount(CONTRIBUTION);

			/**
			 * 调远程方法。host 半返回 `{ok, data|error}`，这里解包成 data 或抛错。
			 * 绝不在挂载阶段同步调用（踩坑 4）。
			 */
			const callRemote = async (method, args) => {
				await mount;
				const remote = ctx.get("remote.lexiang");
				if (remote === undefined) {
					throw new Error("lexiang 服务不可用（host 半可能未加载）");
				}
				const result = await remote[method](args);
				if (!result || result.ok !== true) {
					const e = (result && result.error) || {};
					throw new Error(`${e.code || "ERROR"}: ${e.message || "远程调用失败"}`);
				}
				return result.data;
			};

			const face = () => ({
				getSettings: () => callRemote("getSettings"),
				saveSettings: (args) => callRemote("saveSettings", args),
				clearSettings: () => callRemote("clearSettings"),
				testConnection: () => callRemote("testConnection"),
				listTeams: () => callRemote("listTeams"),
				listSpaces: (args) => callRemote("listSpaces", args),
				describeSpace: (args) => callRemote("describeSpace", args),
				listChildren: (args) => callRemote("listChildren", args),
				readEntry: (args) => callRemote("readEntry", args),
				search: (args) => callRemote("search", args),
				createEntry: (args) => callRemote("createEntry", args),
				renameEntry: (args) => callRemote("renameEntry", args),
				moveEntry: (args) => callRemote("moveEntry", args),
				removeEntry: (args) => callRemote("removeEntry", args),
				uploadFile: (args) => callRemote("uploadFile", args),
				debugLog: (args) => callRemote("debugLog", args)
			});

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "lexiang",
						order: 19,
						label: () => t("nav"),
						locale: NS,
						inject: face
					},
					LexiangSection
				)
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.LexiangSection = LexiangSection;
		exports.CONTRIBUTION = CONTRIBUTION;
		exports.METHODS = METHODS;
		return module.exports;
	}
});
