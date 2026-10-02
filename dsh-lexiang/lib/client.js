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

			// settings 的初值**必须是一个可用的空对象，而不是 null**。
			// 用 null 会让整块面板依赖一个异步门槛：只要 getSettings 的响应没回来
			// （被丢弃、超时、组件已卸载），面板就永远停在加载态 —— 而它看起来
			// 和「组件崩溃」一模一样，正是这次排查了 8 轮的元凶。
			// 现在首帧就渲染凭证表单，getSettings 回来后再填值。
			const EMPTY_SETTINGS = {
				companyFrom: "",
				hasToken: false,
				tokenMasked: "",
				endpoint: "",
				activeSpaceId: "",
				recent: [],
				configured: false,
				stateFile: ""
			};
			const [settings, setSettings] = react.useState(EMPTY_SETTINGS);
			const [loaded, setLoaded] = react.useState(false);
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
			const folderRef = react.useRef(null);
			// 根节点 ref：用来在信标里报告「到底渲染出来了什么、可不可见」。
			// 面板空白时这是唯一能区分「没渲染」和「渲染了但看不见」的办法。
			const rootRef = react.useRef(null);

			const say = (kind, text) => setMsg({ kind, text });

			/* 面板内的输入/确认浮层，代替 window.prompt / window.confirm。
			 *
			 * Electron 渲染进程里这两个原生 API 是禁用的：prompt() 恒返回 null、
			 * confirm() 恒返回 false，而且都不弹窗、不报错。插件此前用它们拿名称
			 * 与确认删除，于是「新建文件夹 / 新建页面 / 重命名 / 删除」四个功能
			 * 全部静默失效 —— 点下去毫无反应，也没有任何提示。
			 */
			const [ask, setAsk] = react.useState(null);
			const askResolveRef = react.useRef(null);
			const askName = (title, initial) =>
				new Promise((resolve) => {
					askResolveRef.current = resolve;
					setAsk({ kind: "prompt", title, value: initial || "" });
				});
			const askConfirm = (title) =>
				new Promise((resolve) => {
					askResolveRef.current = resolve;
					setAsk({ kind: "confirm", title, value: "" });
				});
			const settleAsk = (value) => {
				const fn = askResolveRef.current;
				askResolveRef.current = null;
				setAsk(null);
				if (fn) fn(value);
			};

			/* 所有远程调用都过这里，并带超时兜底。
			 *
			 * 原来只有 try/catch/finally：只要 host 端的某个调用永不 settle，
			 * finally 就永远不执行，`busy` 停在那一句上再也清不掉；而「新建/上传」
			 * 按钮的禁用条件正是 `busy !== ""`，于是整个面板变成只读。
			 */
			const CALL_TIMEOUT_MS = 30000;
			const guard = react.useCallback(
				async (label, fn) => {
					setBusy(label);
					let timer = null;
					try {
						const timeout = new Promise((_, reject) => {
							timer = setTimeout(
								() => reject(new Error(`${label} 超时（${CALL_TIMEOUT_MS / 1000}s 未响应），请点「刷新」重试`)),
								CALL_TIMEOUT_MS
							);
						});
						return await Promise.race([fn(), timeout]);
					} catch (err) {
						const m = err && err.message ? err.message : String(err);
						setMsg({ kind: "err", text: m });
						return null;
					} finally {
						if (timer) clearTimeout(timer);
						setBusy("");
					}
				},
				[]
			);

			// face 用 ref 固定：`face = props.face ?? props`，而 props 每次渲染都是
			// 新对象，所以 `[face]` 依赖**每次渲染都会变**。那会让 effect 反复重跑，
			// 清理函数把 alive 置 false，于是正在飞行的 getSettings 响应被静默丢弃
			// —— settings 永远是 null，面板永远停在加载态。dsh-skill-url 之所以没
			// 这个问题，是因为它根本不用 alive 标志。这里改用 ref + 空依赖：挂载时
			// 只跑一次，且永远拿到最新的 face。
			const faceRef = react.useRef(face);
			faceRef.current = face;

			// 首次挂载：读凭证。任何异常都要吞掉并显示红字，绝不抛出（踩坑 4）。
			react.useEffect(() => {
				let alive = true;
				(async () => {
					const f = faceRef.current;
					// 诊断：把 DSH 实际传入的 props 结构报给 host 落盘。
					// 面板空白时这是唯一能拿到真相的途径（renderer 没有 fs 权限）。
					try {
						if (typeof f.debugLog === "function") {
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
							await f.debugLog({
								propKeys: keys,
								snapshot,
								hasT: typeof props.t,
								hasFace: typeof props.face,
								hasGetSettings: typeof f.getSettings,
								faceIsProps: f === props,
								ns: NS
							});
						}
					} catch { /* 诊断失败不影响主流程 */ }

					try {
						if (typeof f.getSettings !== "function") {
							if (alive) setFatal("远程服务未就绪：face.getSettings 不可用（host 半可能未加载或线名不匹配）");
							return;
						}
						const s = await f.getSettings();
						// 不用 alive 丢弃响应：dsh-skill-url 也没有这个标志，而它正是
						// 「响应回来但被静默扔掉 → 面板停在加载态」的来源。组件卸载后
						// 再 setState 在 React 18+ 是安全的空操作。
						if (s && typeof s === "object") {
							setSettings((prev) => ({ ...prev, ...s }));
							setForm((prev) => ({ ...prev, companyFrom: s.companyFrom || "", endpoint: s.endpoint || "" }));
						}
						setLoaded(true);
					} catch (err) {
						if (alive) setFatal(`初始化失败：${err && err.message ? err.message : err}`);
					}
				})();
				return () => { alive = false; };
			}, []);

			// 已配置时自动拉团队与知识库。
			// 依赖里**不能放 face**：props 每次渲染都是新对象，face 因此每次都变，
			// 会让这个 useCallback 和下面依赖它的 effect 每帧重跑。用 faceRef 取值。
			const loadSpaces = react.useCallback(async () => {
				const f = faceRef.current;
				if (!settings?.configured) return;
				const ts = await f.listTeams();
				setTeams(ts.teams || []);
				const teamId = ts.teams && ts.teams[0] ? ts.teams[0].id : undefined;
				const ps = await f.listSpaces({ teamId });
				setSpaces(ps.spaces || []);
				/* 个人知识库兜底。
				 *
				 * 原来这段调 `describeSpace({})` 想拿个人库，但乐享 API 的 `space_id`
				 * 是必填，空参数必定返回「知识库不存在」（code 50020001）。异常被
				 * 静默吞掉后 `rootId` 永远是空串，于是 doCreate/doUpload 里
				 * `parentId` 为空 → 直接 return →「新建页面/新建文件夹/上传」
				 * 三个按钮看起来点了没反应。
				 *
				 * 改为按优先级兜底，全都只用已经拿到手的 listSpaces 结果：
				 *   1) 已选中的知识库  2) 列表第一个  3) 才退回去问 describeSpace
				 */
				const first = (ps.spaces && ps.spaces[0]) || null;
				if (first && first.id) {
					setSpaceId((cur) => cur || first.id);
					// rootEntryId 可能没随列表返回，此时按 id 补一次 describeSpace。
					let root = first.rootEntryId;
					if (!root) {
						try {
							const d = await f.describeSpace({ spaceId: first.id });
							root = d && d.rootEntryId;
						} catch { /* 单库读取失败就跳过 */ }
					}
					if (root) setRootId((cur) => cur || root);
				}
				// 个人库单独再试一次（有的部署只有个人库、不在 listSpaces 里）。
				try {
					const personal = await f.describeSpace({});
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
				/* 依赖必须是稳定值。原来是 `[settings]`，而 settings 是对象：
				 * 每次 setSettings / 任何重渲染都会生成新引用，effect 于是反复
				 * 重跑，`guard("加载知识库")` 被反复触发。只看 configured 布尔量即可。 */
			}, [settings?.configured]);

			react.useEffect(() => {
				if (!settings?.configured) return;
				guard("加载知识库", loadSpaces);
			}, [settings?.configured, loadSpaces, guard]);

			const loadTree = react.useCallback(async (parentId) => {
				if (!parentId) return;
				const r = await faceRef.current.listChildren({ parentId });
				setTree(r.entries || []);
			}, []);

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
				/* 文件夹与文件本来就没有可读正文，直接跳过 readEntry。
				 * 原来对每个节点都发一次读取，点中文件夹时会白等一次远程往返，
				 * 而这段时间里顶部的「新建/上传」按钮全被 busy 禁着。 */
				if (entry.type === "folder") {
					setBody("（文件夹）");
					await guard("加载子项", () => loadTree(entry.id));
					return;
				}
				if (entry.type === "file") {
					setBody("（文件，此面板不预览二进制内容）");
					return;
				}
				const r = await guard("读取内容", () => face.readEntry({ entryId: entry.id }));
				if (r) setBody(r.body || "（此条目没有正文）");
			};

			const doSearch = async () => {
				const q = query.trim();
				if (!q) return;
				const r = await guard("搜索", () => face.search({ query: q, mode, spaceId: spaceId || undefined, limit: 20 }));
				if (r) setHits(r);
			};

			/**
			 * 保存后**重新拉取真实状态**，而不是依赖 saveSettings 的返回值。
			 *
			 * 之前的写法是 `if (r) { setSettings(r); say(...) }`：只要返回值是假值
			 * （result.data 为 undefined、或响应被网关改形），setSettings 和成功
			 * 提示就一起被跳过 —— 界面看起来就是「点了保存没反应」，尽管 host 其实
			 * 已经落盘成功。现在不管返回值长什么样，都以 getSettings 为准。
			 */
			const refresh = async () => {
				const s = await guard("刷新凭证", () => face.getSettings());
				if (s && typeof s === "object") setSettings((prev) => ({ ...prev, ...s }));
				return s;
			};

			const doSave = async () => {
				const r = await guard("保存凭证", () =>
					face.saveSettings({
						companyFrom: form.companyFrom,
						token: form.token,
						endpoint: form.endpoint
					})
				);
				// r 只用来判断「有没有抛错」（guard 抛错时返回 null 并已 setMsg）。
				// 真正的界面状态一律以重新拉取的结果为准。
				if (r === null) return;
				setForm((f) => ({ ...f, token: "" }));
				const s = await refresh();
				if (s && s.configured) say("ok", t("saved"));
				else say("err", `保存后仍未配置：companyFrom=${JSON.stringify(s && s.companyFrom)} hasToken=${Boolean(s && s.hasToken)}`);
			};

			const doTest = async () => {
				const r = await guard("测试连接", () => face.testConnection());
				if (r && typeof r === "object") say("ok", `${r.staffName || ""} @ ${r.companyName || ""}`);
				else if (r !== null) say("err", `测试返回异常：${JSON.stringify(r)}`);
			};

			const doClear = async () => {
				const r = await guard("清除凭证", () => face.clearSettings());
				if (r === null) return;
				setSpaces([]);
				setTree([]);
				setPicked(null);
				setBody("");
				setHits(null);
				await refresh();
				say("info", t("notConfigured"));
			};

			/* 上传前的公共部分：解析父目录 + 读成 base64 + 调 host。 */
			const resolveParentId = () =>
				picked && picked.type === "folder" ? picked.id : rootId;

			const readAsBase64 = (file) =>
				new Promise((resolve, reject) => {
					const fr = new FileReader();
					fr.onload = () => {
						const s = String(fr.result || "");
						resolve(s.slice(s.indexOf(",") + 1));
					};
					fr.onerror = () => reject(new Error("读取本地文件失败"));
					fr.readAsDataURL(file);
				});

			const uploadOne = async (file, parentId, mimeOverride) => {
				const b64 = await readAsBase64(file);
				return face.uploadFile({
					parentId,
					fileName: file.name,
					contentBase64: b64,
					mimeType: mimeOverride || file.type || "application/octet-stream"
				});
			};

			/* 需要时在指定父目录下创建同名子文件夹，返回它的 entry id。
			 * 先查一遍已有子项，已存在就复用，避免重复夹。 */
			const ensureFolder = async (parentId, name, cache) => {
				const key = `${parentId}/${name}`;
				if (cache && cache.has(key)) return cache.get(key);
				let id = "";
				try {
					const kids = await face.listChildren({ parentId });
					const found = ((kids && kids.entries) || []).find(
						(e) => e.type === "folder" && e.name === name
					);
					if (found) id = found.id;
				} catch { /* 列不出来就直接尝试新建 */ }
				if (!id) {
					const r = await face.createEntry({ parentId, name, type: "folder" });
					if (r) id = r.id;
				}
				if (!id) throw new Error(`无法创建子文件夹「${name}」`);
				if (cache) cache.set(key, id);
				return id;
			};

			/* ── 文件夹上传 ────────────────────────────────────────────
			 * 浏览器的目录选择框（webkitdirectory）给出的 File 带
			 * webkitRelativePath，形如「我的资料/第一章/1.1.pdf」。按它拆出目录
			 * 层级，逐级 ensureFolder 建出同样的结构，再把文件放进最内层。
			 *
			 * 单文件大小不在这里限制：上传走 file_apply_upload 拿预签名 URL、
			 * 再用 HTTP PUT 传二进制，不经过 JSON/base64 膨胀，几十上百 MB
			 * 也能直传；真正的上限由服务端在 apply 时判定。
			 *
			 * 逐个串行上传：乐享侧对并发有配额，串行慢但不会触发限流，
			 * 且进度与失败原因都能如实报出来。
			 */
			const doUploadFolder = async (ev) => {
				const input = ev.target;
				const files = Array.from(input.files || []);
				input.value = "";
				if (!files.length) return;

				const parentId = resolveParentId();
				if (!parentId) {
					say("err", spaceId
						? "当前知识库的根目录未加载：请点「刷新」重试，或重新选择知识库"
						: "请先在上方选择一个知识库");
					return;
				}

				const relOf = (f) => String(f.webkitRelativePath || f.name || "");
				const partsOf = (f) => relOf(f).split("/").filter(Boolean);
				const topName = (partsOf(files[0])[0]) || "上传文件夹";

				let rootTarget;
				try {
					setBusy("准备目录");
					rootTarget = await ensureFolder(parentId, topName, new Map());
				} catch (e) {
					setBusy("");
					say("err", `创建「${topName}」失败：${e.message}`);
					return;
				}
				setBusy("");

				const dirCache = new Map();
				let okCount = 0;
				let failCount = 0;
				const failures = [];

				for (let i = 0; i < files.length; i += 1) {
					const f = files[i];
					const parts = partsOf(f);
					const dirs = parts.slice(1, -1);
					setBusy(`上传 ${i + 1}/${files.length}`);
					try {
						let target = rootTarget;
						for (const d of dirs) target = await ensureFolder(target, d, dirCache);
						await uploadOne(f, target);
						okCount += 1;
					} catch (e) {
						failCount += 1;
						failures.push(`${relOf(f)}：${e.message}`);
					}
				}
				setBusy("");

				if (failCount === 0) {
					say("ok", `文件夹「${topName}」上传完成：${okCount} 个文件 ✓`);
				} else {
					const head = failures.slice(0, 3).join("；");
					say("err",
						`「${topName}」：成功 ${okCount} 个，失败 ${failCount} 个。` +
						`前几个失败原因：${head}${failures.length > 3 ? " …" : ""}`);
				}

				if (picked && picked.type === "folder") await guard("刷新", () => onPickEntry(picked));
				else await guard("刷新", () => loadTree(rootId));
			};

			const doCreate = async (type) => {
				const parentId = resolveParentId();
				if (!parentId) {
					say("err", spaceId
						? "当前知识库的根目录未加载：请点右侧「刷新」重试，或重新选择知识库"
						: "请先在上方选择一个知识库");
					return;
				}
				const name = await askName(type === "folder" ? "新建文件夹" : "新建页面", "");
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
				const name = await askName("重命名", picked.name);
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
				/* window.confirm 在 Electron 里恒为 false，会让「删除」永远直接 return。 */
				if (!(await askConfirm(t("confirmRemove")))) return;
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
				/* 不再按大小拦截。
				 * 上传走 file_apply_upload 拿预签名 URL、再用 HTTP PUT 传二进制，
				 * 不经过 JSON/base64，本地没有理由设上限；真超了服务端会在 apply
				 * 阶段返回明确错误。只对超大文件提示一句，不阻断。 */
				if (file.size > 500 * 1024 * 1024) {
					say("info", `文件较大（${Math.round(file.size / 1024 / 1024)}MB），上传可能需要一段时间…`);
				}
				const parentId = resolveParentId();
				if (!parentId) {
					say("err", spaceId
						? "当前知识库的根目录未加载：请点「刷新」重试，或重新选择知识库"
						: "请先在上方选择一个知识库");
					return;
				}
				const r = await guard("上传", () => uploadOne(file, parentId));
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
						// DOM 实况：区分「没渲染出来」和「渲染了但看不见」。
						let dom = "no element";
						try {
							const el = rootRef.current;
							if (el && typeof el.getBoundingClientRect === "function") {
								const r = el.getBoundingClientRect();
								const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
								dom = {
									tag: el.tagName,
									cls: String(el.className || ""),
									w: Math.round(r.width),
									h: Math.round(r.height),
									display: cs ? cs.display : "?",
									visibility: cs ? cs.visibility : "?",
									opacity: cs ? cs.opacity : "?",
									parentCls: el.parentElement ? String(el.parentElement.className || "") : "no parent",
									parentDisplay: el.parentElement && typeof getComputedStyle === "function" ? getComputedStyle(el.parentElement).display : "?",
									text: String(el.textContent || "").slice(0, 200),
									htmlLen: String(el.innerHTML || "").length
								};
							} else if (el) {
								dom = "ref set but not a DOM node: " + String(el && el.constructor && el.constructor.name);
							}
						} catch (e) {
							dom = "dom probe failed: " + (e && e.message ? e.message : String(e));
						}
						face.debugLog({
							phase: "render",
							settingsIsObject: !!(settings && typeof settings === "object"),
							settingsKeys: keys,
							configured: !!(settings && settings.configured),
							fatal: fatal || "",
							busy: busy || "",
							msg: msg ? `${msg.kind}:${msg.text}` : "",
							dom
						}).catch(() => {});
					}
				} catch { /* ignore */ }
			});

			// 致命错误：显示红字而不是空白（踩坑 4）。
			if (fatal) {
				return jsx("div", { ref: rootRef, className: c.section, children: jsx("p", { className: c.msg, "data-kind": "err", children: fatal }) });
			}
			// 注意：这里**没有** `settings == null → 加载中` 的早返回。
			// 凭证表单首帧就渲染，异步结果只负责填值。面板不可能再空白。

			// 渲染护栏：所有 hook 都已在上方调用完毕，所以这里能用 try/catch 包住整段
			// JSX 构建。否则组件一抛错就被 SlotErrorBoundary 变成**完全空白**，排查时
			// 什么都看不到（这次就吃了这个亏）。宁可显示一行红字。
			// `configured` 必须在 try 之内求值，否则它抛错时护栏也救不了。
			try {
				const configured = Boolean(settings.configured);
				return jsx("div", {
					ref: rootRef,
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
							jsx("div", { key: "kv", className: c.kv, children: `state: ${settings.stateFile || "~/.dsh/dsh-lexiang.json"}${loaded ? "" : "（正在读取…）"}` }),
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
													/* 三个按钮原来一律 `disabled: busy !== ""`，等于把「能不能新建」
													 * 绑在「此刻有没有别的远程调用在飞」上：只要初始化阶段任意一个
													 * 调用不返回，busy 就停住，三个按钮全灰且没有任何提示。
													 * 改为只跟「有没有可写的父节点」有关。 */
													jsx("button", {
														key: "np", type: "button", className: c.btn, "data-size": "sm",
														disabled: !(picked && picked.type === "folder" ? picked.id : rootId),
														title: rootId ? "新建页面" : "请先选择知识库",
														onClick: () => doCreate("page"), children: t("newPage")
													}),
													jsx("button", {
														key: "nf", type: "button", className: c.btn, "data-size": "sm",
														disabled: !(picked && picked.type === "folder" ? picked.id : rootId),
														title: rootId ? "新建文件夹" : "请先选择知识库",
														onClick: () => doCreate("folder"), children: t("newFolder")
													}),
													jsx("button", {
														key: "up", type: "button", className: c.btn, "data-size": "sm",
														disabled: !(picked && picked.type === "folder" ? picked.id : rootId),
														title: rootId ? "上传文件到当前位置（不限大小）" : "请先选择知识库",
														onClick: () => fileRef.current && fileRef.current.click(),
														children: t("upload")
													}),
													/* 文件夹上传：整目录批量上传，保留子目录层级。
													 * 用 webkitdirectory 让浏览器给出目录选择框，
													 * 每个 File 上带 webkitRelativePath 提供相对路径。 */
													jsx("button", {
														key: "upd", type: "button", className: c.btn, "data-size": "sm",
														disabled: !(picked && picked.type === "folder" ? picked.id : rootId),
														title: rootId ? "上传整个文件夹（含子目录，文件大小不限）" : "请先选择知识库",
														onClick: () => folderRef.current && folderRef.current.click(),
														children: "上传文件夹"
													}),
													jsx("input", {
														key: "fi", ref: fileRef, type: "file", style: { display: "none" }, onChange: doUpload
													}),
													jsx("input", {
														key: "fdi",
														ref: folderRef,
														type: "file",
														style: { display: "none" },
														webkitdirectory: "",
														directory: "",
														multiple: true,
														onChange: doUploadFolder
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
												disabled: !rootId, onClick: () => guard("刷新", () => loadTree(rootId)),
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
						: null,

					// ── 输入/确认浮层（替代被 Electron 禁用的 prompt / confirm）──
					ask
						? jsx("div", {
								key: "ask",
								style: {
									position: "fixed", inset: "0", zIndex: 9999,
									background: "rgba(0,0,0,.45)",
									display: "flex", alignItems: "center", justifyContent: "center"
								},
								onClick: (e) => { if (e.target === e.currentTarget) settleAsk(null); },
								children: jsx("div", {
									style: {
										background: "var(--dsw-alias-bg-base, #fff)", color: "inherit",
										borderRadius: "10px", padding: "16px", minWidth: "300px",
										boxShadow: "0 8px 32px rgba(0,0,0,.3)"
									},
									children: [
										jsx("p", { key: "t", style: { margin: "0 0 10px", fontWeight: "600" }, children: ask.title }),
										ask.kind === "prompt"
											? jsx("input", {
													key: "i",
													autoFocus: true,
													style: { width: "100%", padding: "6px 8px", boxSizing: "border-box" },
													value: ask.value,
													onChange: (e) => setAsk((a) => (a ? { ...a, value: e.target.value } : a)),
													onKeyDown: (e) => {
														if (e.key === "Enter") settleAsk(ask.value.trim() || null);
														if (e.key === "Escape") settleAsk(null);
													}
												})
											: null,
										jsx("div", {
											key: "b",
											style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "14px" },
											children: [
												jsx("button", {
													key: "c", type: "button", className: c.btn, "data-size": "sm",
													onClick: () => settleAsk(null), children: "取消"
												}),
												jsx("button", {
													key: "o", type: "button", className: c.btn, "data-size": "sm", "data-kind": "primary",
													onClick: () => settleAsk(ask.kind === "prompt" ? (ask.value.trim() || null) : true),
													children: "确定"
												})
											]
										})
									]
								})
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
			 * 调远程方法。
			 *
			 * **信封由网关提供，不是 host 提供的。** dsh-api-gateway 的 invokeRpc()
			 * 把 host 的返回值包成 `{ ok: true, value }`，把 host 抛出的异常包成
			 * `{ ok: false, error: { code, message, details } }`。所以这里必须读
			 * `result.value`。
			 *
			 * 早先读的是 `result.data`（host 自己又套了一层信封），于是每次调用都拿到
			 * undefined —— 面板看起来像连不上 host，其实每个方法都跑成功了。
			 * dsh-skill-url 读的就是 `result.value`。
			 *
			 * 绝不在挂载阶段同步调用（踩坑 4）。
			 */
			const callRemote = async (method, args) => {
				await mount;
				const remote = ctx.get("remote.lexiang");
				if (remote === undefined) {
					throw new Error("lexiang 服务不可用（host 半可能未加载）");
				}
				const result = await remote[method](args);
				// 诊断：记录网关信封的真实形状，用来区分「读错字段」和「数据被 schema 剥掉」。
				if (method === "getSettings" || method === "saveSettings") {
					try {
						await remote.debugLog({
							phase: "rawResult",
							method,
							resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
							ok: result && result.ok,
							hasValue: Boolean(result && "value" in result),
							hasData: Boolean(result && "data" in result),
							valueKeys:
								result && result.value && typeof result.value === "object" ? Object.keys(result.value) : [],
							valueRaw: JSON.stringify(result && result.value === undefined ? "undefined" : result && result.value).slice(0, 400),
							error: result && result.error ? JSON.stringify(result.error).slice(0, 300) : ""
						});
					} catch { /* 诊断失败不影响主流程 */ }
				}
				if (!result || result.ok !== true) {
					const e = (result && result.error) || {};
					throw new Error(`${e.code || "ERROR"}: ${e.message || "远程调用失败"}`);
				}
				return result.value;
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
