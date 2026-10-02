/**
 * dsh-browser-persist —— client 半（浏览器）。
 *
 * 一个设置页分区（settings.section），做三件事：
 *   1. 显示当前状态：补丁已应用 / 官方原样 / 认不出来（并说明原因）
 *   2. 一键「应用」或「撤销」
 *   3. 一键「重启 DSH」让改动生效
 *
 * 为什么做成设置页而不是侧边栏按钮：这是一个**低频、有副作用**的操作
 * （改的是官方安装文件），不该摆在侧边栏误触；设置页天然是"改配置"的地方。
 *
 * 两处踩过的坑，代码里都避开了：
 *   - codec 必须声明在 CONTRIBUTION **之前**（CONTRIBUTION 在求值期就调用它，
 *     否则踩 TDZ，整个 Web 端起不来，而 node --check 查不出来）。
 *   - 组件不直接拿 ctx，一切通过注册时的 inject 工厂传入；
 *     且 slot 宿主会把 inject 的返回值**摊平成 props**（不存在 props.face），
 *     所以用 props.face ?? props 兼容两种形态。
 */
window.__ModuleLoader__.load({
  id: "dsh-browser-persist",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const { jsx, Fragment } = jsxRuntime;

    const NS = "browserPersist";

    // ── 样式（BP_ 前缀避免冲突；配色一律走主题变量）────────────────────
    const css = [
      ".BP_root{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".BP_card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}",
      ".BP_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".BP_badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 9px;border-radius:999px;font-weight:600}",
      ".BP_badge[data-s=applied]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}",
      ".BP_badge[data-s=clean]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))}",
      ".BP_badge[data-s=unknown]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}",
      ".BP_h{font-size:13px;font-weight:600;margin:0}",
      ".BP_p{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}",
      ".BP_code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:17px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1));overflow-x:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}",
      ".BP_path{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all;color:var(--dsw-alias-label-tertiary)}",
      ".BP_btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;border-radius:6px;padding:0 12px;height:30px;white-space:nowrap}",
      ".BP_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}",
      ".BP_btn:disabled{opacity:.45;cursor:default}",
      ".BP_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
      ".BP_btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}",
      ".BP_msg{margin:0;font-size:12px;line-height:18px;padding:7px 10px;border-radius:6px}",
      ".BP_msg[data-kind=err]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}",
      ".BP_msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}",
      ".BP_msg[data-kind=info]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))}",
      ".BP_dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;align-items:baseline}",
      ".BP_dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".BP_dd{margin:0;word-break:break-all}",
      ".BP_list{margin:0;padding-left:18px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}"
    ].join("");

    const ensureStyle = () => {
      if (typeof document === "undefined") return;
      if (document.getElementById("dsh-browser-persist-style") !== null) return;
      const el = document.createElement("style");
      el.id = "dsh-browser-persist-style";
      el.textContent = css;
      document.head.appendChild(el);
    };

    // ── 文案 ──────────────────────────────────────────────────────────
    const zh = {
      nav: "浏览器登录态",
      title: "侧栏浏览器记住登录态",
      intro: "DSH 侧栏里打开的网页（比如从「书签」点开的乐享）每次都用一个全新的临时会话，所以关掉 DSH 再打开就得重新登录。这个开关会把它改成持久会话来记住登录状态。",
      stateApplied: "已启用",
      stateClean: "未启用（官方原样）",
      stateUnknown: "识别不了",
      apply: "启用",
      revert: "恢复官方",
      restart: "重启 DSH 生效",
      recheck: "重新检查",
      working: "处理中…",
      needRestart: "改动已写入，需要重启 DSH 才会生效。",
      restarted: "正在重启…窗口会在几秒后关闭并自动重新打开。",
      backup: "备份",
      path: "安装位置",
      kindAsar: "归档文件（正式安装包）",
      kindDir: "解包目录（开发版）",
      restartUnsupported: "当前不是桌面版，请手动重启 DSH",
      howTitle: "它改了什么",
      howBody: "官方把侧栏浏览器的分区建成「随机名字、不落盘」的临时会话；本插件把它换成由工作区派生的确定性名字加持久化前缀，于是同一工作区的登录态能跨重启保留。",
      upgradeTitle: "DSH 升级后",
      upgradeBody: "升级会整体替换安装文件，这个改动会随之消失。回到这里再点一次「启用」即可——不需要手工找代码改。"
    };
    const en = {
      nav: "Browser login",
      title: "Persist the sidebar browser session",
      intro: "Pages opened in the DSH sidebar (for example Lexiang, opened from Bookmarks) get a fresh throwaway session every time, so you must sign in again after restarting DSH. This switch turns that session into a persistent one.",
      stateApplied: "Enabled",
      stateClean: "Not enabled (stock)",
      stateUnknown: "Unrecognized",
      apply: "Enable",
      revert: "Restore stock",
      restart: "Restart DSH to apply",
      recheck: "Re-check",
      working: "Working…",
      needRestart: "The change is written; restart DSH for it to take effect.",
      restarted: "Restarting… this window will close and reopen in a few seconds.",
      backup: "Backup",
      path: "Install location",
      kindAsar: "Archive file (packaged install)",
      kindDir: "Unpacked directory (development)",
      restartUnsupported: "Not the desktop build — restart DSH manually",
      howTitle: "What it changes",
      howBody: "DSH gives the sidebar browser a random, in-memory session partition. This plugin switches it to a deterministic, workspace-derived name with a persistence prefix, so the same workspace keeps its login across restarts.",
      upgradeTitle: "After a DSH upgrade",
      upgradeBody: "An upgrade replaces the install files and removes this change. Come back here and press Enable once more — no manual code editing needed."
    };

    /**
     * 远程 schema codec 工厂。
     * 必须在 CONTRIBUTION **之前**声明：CONTRIBUTION 在模块求值期就会调用 codec()。
     * 形状必须带 create() 工厂，否则注册时抛 "strict codec has no create() factory"。
     */
    const identity = (v) => v;
    function codec(typeSymbol) {
      return { mode: "strict", typeSymbol, create: () => ({ parse: identity }) };
    }

    const CONTRIBUTION = {
      package: "dsh-browser-persist",
      descriptors: [
        { id: "dsh-browser-persist#browserPersist/status", service: "browserPersist", namespace: "browserPersist", method: "status", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Status") },
        { id: "dsh-browser-persist#browserPersist/apply", service: "browserPersist", namespace: "browserPersist", method: "apply", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Action") },
        { id: "dsh-browser-persist#browserPersist/revert", service: "browserPersist", namespace: "browserPersist", method: "revert", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Action") },
        { id: "dsh-browser-persist#browserPersist/restart", service: "browserPersist", namespace: "browserPersist", method: "restart", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-browser-persist#Restart") },
      ]
    };

    // ── 面板 ──────────────────────────────────────────────────────────
    function BrowserPersistSection(props) {
      ensureStyle();
      const face = props.face ?? props;
      const t = props.t ?? ((k) => k);

      const [status, setStatus] = react.useState(null);
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState(null);
      const [fatal, setFatal] = react.useState("");
      const aliveRef = react.useRef(true);

      react.useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      /** 所有远程调用都带超时兜底：host 半若卡住，界面不能永远停在"处理中"。 */
      const CALL_TIMEOUT_MS = 20000;
      const guard = react.useCallback(async (label, fn) => {
        setBusy(label);
        let timer = null;
        try {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(label + " 超时（" + CALL_TIMEOUT_MS / 1000 + "s 未响应）")),
              CALL_TIMEOUT_MS
            );
          });
          return await Promise.race([fn(), timeout]);
        } catch (error) {
          const text = error && error.message ? error.message : String(error);
          if (aliveRef.current) setMsg({ kind: "err", text });
          return null;
        } finally {
          if (timer) clearTimeout(timer);
          if (aliveRef.current) setBusy("");
        }
      }, []);

      const refresh = react.useCallback(async () => {
        try {
          if (typeof face?.status !== "function") {
            setFatal("browserPersist 服务不可用（host 半可能未加载）");
            return;
          }
          const value = await face.status();
          if (aliveRef.current) { setStatus(value); setFatal(""); }
        } catch (error) {
          if (aliveRef.current) setFatal(String(error?.message ?? error));
        }
      }, [face]);

      react.useEffect(() => { refresh(); }, [refresh]);

      const doApply = async () => {
        const r = await guard("应用补丁", () => face.apply());
        if (!r) return;
        setMsg({ kind: "ok", text: (r.changed ? "已写入改动。" : "无需改动。") + " " + t("needRestart") });
        await refresh();
      };

      const doRevert = async () => {
        const r = await guard("撤销补丁", () => face.revert());
        if (!r) return;
        setMsg({ kind: "ok", text: (r.changed ? "已恢复官方行为。" : "本来就没有启用。") + " " + t("needRestart") });
        await refresh();
      };

      const doRestart = () => {
        // 不等回执：几秒后进程就没了，promise 多半永远不 resolve
        setMsg({ kind: "info", text: t("restarted") });
        setBusy("重启");
        try { Promise.resolve(face.restart()).catch(() => {}); } catch { /* 同上 */ }
      };

      if (fatal) {
        return jsx("div", { className: "BP_root", children: jsx("p", { className: "BP_msg", "data-kind": "err", children: fatal }) });
      }

      const state = status ? status.state : "unknown";
      const supported = status ? status.supported === true : true;
      const busyNow = busy !== "";
      const canApply = supported && state === "clean" && !busyNow;
      const canRevert = supported && state === "applied" && !busyNow;

      const badgeText = state === "applied" ? t("stateApplied") : state === "clean" ? t("stateClean") : t("stateUnknown");
      const badgeIcon = state === "applied" ? "✓" : state === "clean" ? "○" : "!";

      return jsx("div", { className: "BP_root", children: [
        // 标题 + 状态
        jsx("div", { key: "head", className: "BP_card", children: [
          jsx("div", { key: "r", className: "BP_row", children: [
            jsx("h3", { key: "t", className: "BP_h", children: t("title") }),
            jsx("span", { key: "b", className: "BP_badge", "data-s": state, children: badgeIcon + " " + badgeText })
          ] }),
          jsx("p", { key: "p", className: "BP_p", children: t("intro") }),
          supported === false && status && status.reason
            ? jsx("p", { key: "why", className: "BP_msg", "data-kind": "err", children: status.reason })
            : null,
          status && status.state === "unknown" && status.reason
            ? jsx("p", { key: "un", className: "BP_msg", "data-kind": "err", children: status.reason })
            : null
        ] }),

        // 操作
        jsx("div", { key: "ops", className: "BP_card", children: [
          jsx("div", { key: "r", className: "BP_row", children: [
            jsx("button", {
              key: "a", type: "button", className: "BP_btn", "data-kind": "primary",
              disabled: !canApply, onClick: doApply,
              title: canApply ? t("apply") : badgeText,
              children: busy === "应用补丁" ? t("working") : t("apply")
            }),
            jsx("button", {
              key: "v", type: "button", className: "BP_btn", "data-kind": "danger",
              disabled: !canRevert, onClick: doRevert,
              children: busy === "撤销补丁" ? t("working") : t("revert")
            }),
            jsx("button", {
              key: "s", type: "button", className: "BP_btn",
              disabled: busyNow, onClick: refresh,
              children: t("recheck")
            }),
            jsx("button", {
              key: "rs", type: "button", className: "BP_btn",
              disabled: busyNow || !status || status.restartSupported !== true,
              onClick: doRestart,
              title: status && status.restartSupported === true ? t("restart") : t("restartUnsupported"),
              children: busy === "重启" ? t("working") : t("restart")
            })
          ] }),
          msg ? jsx("p", { key: "m", className: "BP_msg", "data-kind": msg.kind, children: msg.text }) : null
        ] }),

        // 详情
        status ? jsx("div", { key: "info", className: "BP_card", children: [
          jsx("dl", { key: "dl", className: "BP_dl", children: [
            jsx("dt", { key: "k1", className: "BP_dt", children: t("path") }),
            jsx("dd", { key: "v1", className: "BP_dd", children: [
              jsx("span", { key: "p", className: "BP_path", children: status.main || "—" }),
              jsx("br", { key: "br" }),
              jsx("span", { key: "k", className: "BP_dt", children: status.kind === "asar" ? t("kindAsar") : status.kind === "directory" ? t("kindDir") : "—" })
            ] }),
            status.version
              ? jsx(Fragment, { key: "ver", children: [
                  jsx("dt", { key: "k2", className: "BP_dt", children: "DSH" }),
                  jsx("dd", { key: "v2", className: "BP_dd", children: status.version })
                ] })
              : null,
            status.backup
              ? jsx(Fragment, { key: "bk", children: [
                  jsx("dt", { key: "k3", className: "BP_dt", children: t("backup") }),
                  jsx("dd", { key: "v3", className: "BP_dd", children: jsx("span", { className: "BP_path", children: status.backup }) })
                ] })
              : null
          ] })
        ] }) : null,

        // 说明
        jsx("div", { key: "help", className: "BP_card", children: [
          jsx("h3", { key: "t1", className: "BP_h", children: t("howTitle") }),
          jsx("p", { key: "p1", className: "BP_p", children: t("howBody") }),
          jsx("code", { key: "c1", className: "BP_code", children: "partition = \`dsh-sidebar-browser-" + D + "{randomUUID()}\`" }),
          jsx("code", { key: "c2", className: "BP_code", children: "partition = \`persist:dsh-sidebar-browser-" + D + "{createHash('sha256').update(workspace)…}\`" }),
          jsx("h3", { key: "t2", className: "BP_h", children: t("upgradeTitle") }),
          jsx("p", { key: "p2", className: "BP_p", children: t("upgradeBody") })
        ] })
      ] });
    }

    // ── cordis 插件体 ─────────────────────────────────────────────────
    const inject = ["slots", "locale", "remote"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-browser-persist: dictionaries");
      const t = ctx.locale.bind(NS);

      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method) => {
        await mount;
        const remote = ctx.get("remote.browserPersist");
        if (remote === undefined) throw new Error("browserPersist 服务不可用（host 半可能未加载）");
        const result = await remote[method]();
        if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
        return result.value;
      };
      const face = () => ({
        status: () => callRemote("status"),
        apply: () => callRemote("apply"),
        revert: () => callRemote("revert"),
        restart: () => callRemote("restart")
      });

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "browser-persist",
        order: 41,
        label: () => t("nav"),
        locale: NS,
        inject: face
      }, BrowserPersistSection));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    exports.BrowserPersistSection = BrowserPersistSection;
    exports.CONTRIBUTION = CONTRIBUTION;
    return module.exports;
  }
});
