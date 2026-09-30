/**
 * dsh-restart —— client 半（浏览器）。
 *
 * 一个按钮，注册在 `sidebar.footer.action`。这个插槽的位置是查过代码确认的：
 *
 *   SidebarRoot 的 footArea = [
 *     div.footerActions { renderSlot("sidebar.footer.action", { wide }) },   ← 我们在这
 *     div.settingsArea  { renderSlot("sidebar.settings",  { wide }) }        ← 最底下一行
 *   ]
 *
 * 也就是侧边栏底部、最下面那一行的正上方。官方插件 @deepseek-ai/dsh-client-ui-cordis
 * 也是往这个插槽注册的，可以作参照。
 *
 * 交互：点一下直接重启（用户明确不要二次确认）。点击后立刻切到"正在重启…"，
 * **不去等 RPC 的回执** —— 几秒后 host 进程就会被杀掉，那个 promise 多半永远不 resolve。
 */
window.__ModuleLoader__.load({
	id: "dsh-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx } = react_jsx_runtime;

		// ── 样式（前缀 RS_，配色沿用主题变量，跟侧边栏底部的原生行一致）──────
		const css = [
			".RS_wrap{display:flex;flex-direction:column;min-width:0}",
			".RS_btn{align-items:center;gap:8px;width:100%;min-height:32px;padding:0 8px;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;border-radius:6px;box-sizing:border-box;display:flex;text-align:left}",
			".RS_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
			".RS_btn:disabled{opacity:.45;cursor:default}",
			".RS_btn[data-busy=true]{color:var(--dsw-alias-state-business-primary)}",
			".RS_glyph{flex:none;width:16px;height:16px;display:block}",
			".RS_btn[data-busy=true] .RS_glyph{animation:RS_spin 1s linear infinite}",
			"@keyframes RS_spin{to{transform:rotate(360deg)}}",
			".RS_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".RS_note{padding:0 8px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}"
		].join("");

		const styleId = "dsh-restart-style";
		if (typeof document !== "undefined" && document.getElementById(styleId) === null) {
			const el = document.createElement("style");
			el.id = styleId;
			el.textContent = css;
			document.head.appendChild(el);
		}
		const c = { wrap: "RS_wrap", btn: "RS_btn", glyph: "RS_glyph", label: "RS_label", note: "RS_note" };

		/** Material "refresh" 图标路径（24x24）。 */
		const REFRESH_PATH = "M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";

		// ── 文案 ──────────────────────────────────────────────────────────
		const NS = "appRestart";
		const zh = {
			restart: "重启",
			restarting: "正在重启…",
			title: "重启 DSH：关闭应用并重新打开",
			unavailable: "当前不可用"
		};
		const en = {
			restart: "Restart",
			restarting: "Restarting…",
			title: "Restart DSH: close the app and start it again",
			unavailable: "Unavailable"
		};

		/**
		 * 远程 schema codec 工厂。
		 * 必须在 CONTRIBUTION **之前**声明：CONTRIBUTION 在模块求值期就会调用 codec()，
		 * 声明晚了会踩 TDZ，整个 Web 端起不来（`node --check` 查不出来）。
		 * 形状必须带 `create()` 工厂，否则注册时抛 "strict codec has no create() factory"。
		 */
		const identity = (v) => v;
		function codec(typeSymbol) {
			return { mode: "strict", typeSymbol, create: () => ({ parse: identity }) };
		}

		/** 远程描述符（client 侧声明，用于 $mount）。 */
		const CONTRIBUTION = {
			package: "dsh-restart",
			descriptors: [
				{
					id: "dsh-restart#appRestart/restartSupport",
					service: "appRestart", namespace: "appRestart", method: "restartSupport",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-restart#RestartSupport")
				},
				{
					id: "dsh-restart#appRestart/restart",
					service: "appRestart", namespace: "appRestart", method: "restart",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-restart#RestartResult")
				}
			]
		};

		// ── 按钮 ──────────────────────────────────────────────────────────
		/**
		 * 侧边栏底部的重启按钮。
		 *
		 * props 形态：slot 宿主把 inject() 的返回值**摊平成 props**（不存在 props.face），
		 * 同时 owner 传进来的 `wide` 也在 props 上。两种 face 形态都兼容。
		 * 任何挂载期同步抛错都会把整个插槽项打成空白，所以全部包住。
		 */
		function RestartAction(props) {
			const face = props.face ?? props;
			const t = props.t ?? ((k) => k);
			// 侧边栏收起时只留图标
			const wide = props.wide !== false;
			const [support, setSupport] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			react.useEffect(() => {
				try {
					if (typeof face?.restartSupport !== "function") {
						setSupport({ supported: false, reason: "appRestart 服务不可用（host 半可能未加载）" });
						return;
					}
					Promise.resolve(face.restartSupport())
						.then((value) => setSupport(value))
						.catch((error) => setSupport({ supported: false, reason: String(error?.message ?? error) }));
				} catch (error) {
					setSupport({ supported: false, reason: String(error?.message ?? error) });
				}
			}, [face]);

			const supported = support === null ? true : support.supported === true;

			const click = () => {
				if (busy || !supported) return;
				setBusy(true);
				try {
					if (typeof face?.restart !== "function") return;
					// 不等回执：几秒后进程就没了，promise 多半不会 resolve
					Promise.resolve(face.restart()).catch(() => {});
				} catch { /* 同上，忽略 */ }
			};

			return jsx("div", { className: c.wrap, children: [
				jsx("button", {
					type: "button",
					className: c.btn,
					"data-busy": busy ? "true" : "false",
					disabled: busy || !supported,
					title: supported ? t("title") : (support?.reason ?? t("unavailable")),
					onClick: click,
					children: [
						jsx("svg", {
							className: c.glyph,
							viewBox: "0 0 24 24",
							fill: "currentColor",
							"aria-hidden": "true",
							children: jsx("path", { d: REFRESH_PATH })
						}),
						wide
							? jsx("span", { className: c.label, children: busy ? t("restarting") : t("restart") })
							: null
					]
				}),
				// 不支持时把原因写出来，而不是给一个点了没反应的灰按钮
				wide && support !== null && support.supported !== true
					? jsx("div", { className: c.note, children: support.reason })
					: null
			] });
		}

		// ── cordis 插件体 ─────────────────────────────────────────────────
		const inject = ["slots", "locale", "remote"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-restart: dictionaries");
			const t = ctx.locale.bind(NS);

			const mount = ctx.remote.$mount(CONTRIBUTION);
			const callRemote = async (method) => {
				await mount;
				const remote = ctx.get("remote.appRestart");
				if (remote === undefined) {
					throw new Error("appRestart 服务不可用（host 半可能未加载）");
				}
				const result = await remote[method]();
				if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
				return result.value;
			};
			const face = () => ({
				restartSupport: () => callRemote("restartSupport"),
				restart: () => callRemote("restart")
			});

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "app-restart",
				order: 50,
				label: () => t("restart"),
				locale: NS,
				inject: face
			}, RestartAction));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.RestartAction = RestartAction;
		return module.exports;
	}
});
