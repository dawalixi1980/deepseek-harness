/**
 * dsh-split-obsidian —— client 半（浏览器）。
 *
 * 在右侧栏注册一个 `obsidian` 标签页：
 *   · 显示 Obsidian 库信息与当前并排状态
 *   · 一条**可拖动的分隔条**，拖动实时改变两个窗口的宽度比例
 *   · 几个比例预设按钮、还原、聚焦切换、重新检测
 *
 * ## 路径选择：为什么是"侧栏标签页"
 *
 * 用户要的是"点击侧栏里的条目就能并排"。引导页的条目（guide entry）对应的就是
 * 一个标签页类型，所以注册一个带 guide 的 tab 即可 —— 它会自动出现在那个列表里，
 * 和「工作区文件 / 新建终端 / 浏览器 / 书签」并列。
 *
 * ## 拖动是怎么实现的
 *
 * 分隔条在 DSH 页面里，但它要控制的是**屏幕上的两个窗口**。所以：
 *   · 按下时记住起点；
 *   · 移动时按 pointer 的屏幕 X（clientX + 窗口在屏幕上的 X）换算成比例；
 *   · 调 host 的 drag()；
 *   · host 那边单次约 4ms（常驻 PowerShell），所以每一帧调都来得及。
 *
 * 一个必须承认的限制：**DSH 窗口自己会变窄**，而分隔条画在 DSH 页面里，
 * 所以拖动时分隔条的位置会跟着窗口边缘一起动 —— 视觉上有一点点"追不上手"。
 * 这是"用两条独立窗口模拟分屏"的固有问题，不是实现缺陷。
 *
 * ## 三条踩过的硬约束（doc 里都写着）
 *
 *   1. codec 必须声明在 CONTRIBUTION 之前（CONTRIBUTION 在求值期就调用它，
 *      晚了踩 TDZ，整个 Web 端起不来，而 node --check 查不出来）。
 *   2. codec 形状必须是 { mode, typeSymbol, create: () => schema }，缺 create() 注册即失败。
 *   3. 组件不直接拿 ctx，一切通过 inject 工厂传入；slot 宿主会把 inject 的返回值
 *      **摊平成 props**（不存在 props.face），所以用 props.face ?? props 兼容两种形态。
 */
window.__ModuleLoader__.load({
  id: "dsh-split-obsidian",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const { jsx, Fragment } = jsxRuntime;

    const TAB_KIND = "obsidian";
    const TAB_ID = "dsh-split-obsidian";
    const NS = "obsidianSplit";

    // ── 样式（OS_ 前缀，配色走主题变量）──────────────────────────────
    const css = [
      ".OS_root{width:100%;height:100%;display:flex;flex-direction:column;gap:10px;padding:10px 12px;box-sizing:border-box;overflow:auto;color:var(--dsw-alias-label-primary);font-size:13px}",
      ".OS_card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}",
      ".OS_h{font-size:13px;font-weight:600;margin:0}",
      ".OS_p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".OS_row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".OS_btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:0 10px;height:28px;white-space:nowrap}",
      ".OS_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}",
      ".OS_btn:disabled{opacity:.45;cursor:default}",
      ".OS_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}",
      ".OS_badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:2px 8px;border-radius:999px;font-weight:600}",
      ".OS_badge[data-s=on]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}",
      ".OS_badge[data-s=off]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))}",
      ".OS_badge[data-s=err]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}",
      ".OS_msg{margin:0;font-size:11.5px;line-height:17px;padding:6px 9px;border-radius:6px}",
      ".OS_msg[data-kind=err]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}",
      ".OS_msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}",
      ".OS_msg[data-kind=info]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))}",
      // 拖动轨道：一条横向的"屏幕示意"，分隔条在按比例的位置上
      ".OS_track{position:relative;height:44px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));overflow:hidden;user-select:none;touch-action:none}",
      ".OS_side{position:absolute;top:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-tertiary);pointer-events:none;overflow:hidden;white-space:nowrap}",
      ".OS_split{position:absolute;top:0;bottom:0;width:14px;margin-left:-7px;cursor:col-resize;display:flex;align-items:center;justify-content:center;z-index:2}",
      ".OS_split::before{content:\"\";width:3px;height:70%;border-radius:2px;background:var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))}",
      ".OS_split:hover::before,.OS_split[data-dragging=true]::before{background:var(--dsw-alias-state-business-primary);width:4px}",
      ".OS_split[data-dragging=true]{cursor:col-resize}",
      ".OS_label{font-size:11.5px;color:var(--dsw-alias-label-tertiary);display:flex;justify-content:space-between}",
      ".OS_kv{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11.5px}",
      ".OS_k{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".OS_v{margin:0;word-break:break-all;font-family:ui-monospace,Consolas,monospace}",
      ".OS_note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}"
    ].join("");

    const ensureStyle = () => {
      if (typeof document === "undefined") return;
      if (document.getElementById("dsh-split-obsidian-style") !== null) return;
      const el = document.createElement("style");
      el.id = "dsh-split-obsidian-style";
      el.textContent = css;
      document.head.appendChild(el);
    };

    // ── 文案 ──────────────────────────────────────────────────────────
    const zh = {
      nav: "Obsidian",
      title: "并排 Obsidian",
      intro: "把 DSH 和 Obsidian 两个窗口在屏幕上左右并排。拖动下面的分隔条可以随时调整比例。",
      snap: "并排",
      unsnap: "还原 DSH",
      recheck: "重新检测",
      focusLeft: "聚焦 DSH",
      focusRight: "聚焦 Obsidian",
      openVault: "在 Obsidian 打开本工作区",
      stateOn: "已并排",
      stateOff: "未并排",
      stateErr: "不可用",
      dragHint: "拖动分隔条调整比例",
      screen: "屏幕工作区",
      vault: "库名",
      howTitle: "它是怎么工作的",
      howBody: "这不是把 Obsidian 嵌进侧栏（做不到：Obsidian 是独立桌面程序）。它是在操作系统层面把两个窗口平铺到屏幕左右，中间留一条缝。",
      saved: "比例会记住，下次打开还是这个比例。"
    };
    const en = {
      nav: "Obsidian",
      title: "Side by side with Obsidian",
      intro: "Tiles the DSH and Obsidian windows left and right on screen. Drag the divider below to change the split at any time.",
      snap: "Tile",
      unsnap: "Restore DSH",
      recheck: "Re-check",
      focusLeft: "Focus DSH",
      focusRight: "Focus Obsidian",
      openVault: "Open this workspace in Obsidian",
      stateOn: "Tiled",
      stateOff: "Not tiled",
      stateErr: "Unavailable",
      dragHint: "Drag the divider to change the split",
      screen: "Screen work area",
      vault: "Vault",
      howTitle: "How it works",
      howBody: "This does not embed Obsidian in the sidebar (impossible: Obsidian is a separate desktop app). It tiles the two windows left and right at the OS level.",
      saved: "The split is remembered for next time."
    };

    /**
     * 远程 schema codec。
     * 必须声明在 CONTRIBUTION 之前；形状必须带 create() 工厂。
     */
    const identity = (v) => v;
    function codec(typeSymbol) {
      return { mode: "strict", typeSymbol, create: () => ({ parse: identity }) };
    }

    const P = "dsh-split-obsidian";
    /*
     * 远程描述符。
     *
     * 参数的形状必须是一个**对象**：{ name, wire, source, codec }。
     * 写成裸 codec(`parameters: [codec(...)]`) 会在 mount 时炸：
     * api-gateway 的 requireStrictInputs 会逐个读 parameter.codec，
     * 拿到 undefined 就报 "Cannot read properties of undefined (reading 'mode')"。
     *
     * 这里沿用 dsh-lexiang 的做法：每个方法都收一个叫 args 的 JSON 参数，
     * 无参方法靠 acceptsUndefined 也能不传。这样描述符形状统一，少一类错误。
     */
    /*
     * 远程描述符。三点必须与 host 半逐字一致：
     *
     *  1. parameters 的每一项必须是**对象** { name, wire, source, codec } ——
     *     写裸 codec 会让 api-gateway 读到 undefined 再读 .mode，报
     *     "Cannot read properties of undefined (reading 'mode')"。
     *  2. **无参方法不声明参数**。status / unsnap 之前也挂了 args，
     *     结果边界校验对不上，报 "wire field \"args\" failed boundary validation"。
     *  3. result codec 必须带 create() 工厂。
     */
    const CONTRIBUTION = {
      package: P,
      descriptors: [
                { id: P + "#obsidianSplit/status", service: "obsidianSplit", namespace: "obsidianSplit", method: "status", invocation: { kind: "direct" }, parameters: [], result: codec(P + "#statusResult") },
                { id: P + "#obsidianSplit/snap", service: "obsidianSplit", namespace: "obsidianSplit", method: "snap", invocation: { kind: "direct" }, parameters: [{ name: "args", wire: "args", source: "json", acceptsUndefined: true, codec: codec(P + "#snapArgs") }], result: codec(P + "#snapResult") },
                { id: P + "#obsidianSplit/drag", service: "obsidianSplit", namespace: "obsidianSplit", method: "drag", invocation: { kind: "direct" }, parameters: [{ name: "args", wire: "args", source: "json", acceptsUndefined: true, codec: codec(P + "#dragArgs") }], result: codec(P + "#dragResult") },
                { id: P + "#obsidianSplit/unsnap", service: "obsidianSplit", namespace: "obsidianSplit", method: "unsnap", invocation: { kind: "direct" }, parameters: [], result: codec(P + "#unsnapResult") },
                { id: P + "#obsidianSplit/focus", service: "obsidianSplit", namespace: "obsidianSplit", method: "focus", invocation: { kind: "direct" }, parameters: [{ name: "args", wire: "args", source: "json", acceptsUndefined: true, codec: codec(P + "#focusArgs") }], result: codec(P + "#focusResult") },
                { id: P + "#obsidianSplit/openVault", service: "obsidianSplit", namespace: "obsidianSplit", method: "openVault", invocation: { kind: "direct" }, parameters: [{ name: "args", wire: "args", source: "json", acceptsUndefined: true, codec: codec(P + "#openVaultArgs") }], result: codec(P + "#openVaultResult") }
      ]
    };

    const MIN_RATIO = 0.2;
    const MAX_RATIO = 0.8;

    /** 从 DSH 工作区路径里猜 Obsidian 库名（就是最后一段目录名）。 */
    function vaultNameFromPath(p) {
      if (typeof p !== "string" || p.length === 0) return "";
      const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
      return parts.length > 0 ? parts[parts.length - 1] : "";
    }

    // ── 面板 ──────────────────────────────────────────────────────────
    function ObsidianSplitPanel(props) {
      ensureStyle();
      const face = props.face ?? props;
      const t = props.t ?? ((k) => k);

      const [status, setStatus] = react.useState(null);
      const [ratio, setRatio] = react.useState(0.62);
      const [msg, setMsg] = react.useState(null);
      const [dragging, setDragging] = react.useState(false);
      const [fatal, setFatal] = react.useState("");
      const trackRef = react.useRef(null);
      const aliveRef = react.useRef(true);
      const dragRef = react.useRef({ active: false, raf: 0, pending: -1 });

      react.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          const d = dragRef.current;
          if (d.raf) cancelAnimationFrame(d.raf);
        };
      }, []);

      /** 所有远程调用都带超时兜底：host 卡住时界面不能永远停在"处理中"。 */
      const CALL_TIMEOUT_MS = 15000;
      const guard = react.useCallback(async (label, fn) => {
        let timer = null;
        try {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + " 超时（" + CALL_TIMEOUT_MS / 1000 + "s 未响应）")), CALL_TIMEOUT_MS);
          });
          return await Promise.race([fn(), timeout]);
        } catch (error) {
          const text = error && error.message ? error.message : String(error);
          if (aliveRef.current) setMsg({ kind: "err", text: text });
          return null;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }, []);

      const refresh = react.useCallback(async () => {
        try {
          if (typeof face?.status !== "function") {
            setFatal("obsidianSplit 服务不可用（host 半可能未加载）");
            return;
          }
          const value = await face.status();
          if (!aliveRef.current) return;
          setStatus(value);
          setFatal("");
          if (typeof value?.ratio === "number") setRatio(value.ratio);
        } catch (error) {
          if (aliveRef.current) setFatal(String(error && error.message ? error.message : error));
        }
      }, [face]);

      react.useEffect(() => { refresh(); }, [refresh]);

      const doSnap = async (r) => {
        const value = typeof r === "number" ? r : ratio;
        const res = await guard("并排", () => face.snap(value));
        if (res === null) return;
        setRatio(res.ratio);
        setMsg({ kind: "ok", text: "已并排（" + res.label + "）" });
        await refresh();
      };

      const doUnsnap = async () => {
        const res = await guard("还原", () => face.unsnap());
        if (res === null) return;
        setMsg({ kind: "ok", text: "DSH 已占满工作区" });
        await refresh();
      };

      const doFocus = async (side) => {
        await guard("切换焦点", () => face.focus(side));
      };

      const doOpenVault = async () => {
        const name = vaultNameFromPath(workspacePath);
        if (name.length === 0) { setMsg({ kind: "err", text: "拿不到当前工作区路径" }); return; }
        const res = await guard("打开 Obsidian", () => face.openVault(name));
        if (res !== null) setMsg({ kind: "ok", text: "已请求 Obsidian 打开库「" + name + "」" });
      };

      // ── 拖动 ────────────────────────────────────────────────────────
      /**
       * 把指针位置换算成比例并下发。
       *
       * 用 rAF 节流：拖动中每次 pointermove 只记下最新的目标值，真正下发放在下一帧 ——
       * 这样鼠标狂甩时也不会堆积请求。实测单次约 4ms，一帧一个完全来得及。
       */
      const pushRatio = react.useCallback((next) => {
        const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, next));
        setRatio(clamped);
        const d = dragRef.current;
        d.pending = clamped;
        if (d.raf) return;
        d.raf = requestAnimationFrame(() => {
          d.raf = 0;
          const target = d.pending;
          if (target < 0 || !aliveRef.current) return;
          Promise.resolve(face.drag(target)).catch(() => { /* 拖动中的失败不打断手势 */ });
        });
      }, [face]);

      const ratioFromPointer = react.useCallback((clientX) => {
        const el = trackRef.current;
        if (el === null) return ratio;
        const box = el.getBoundingClientRect();
        if (box.width <= 0) return ratio;
        return (clientX - box.left) / box.width;
      }, [ratio]);

      const onPointerDown = (ev) => {
        ev.preventDefault();
        const d = dragRef.current;
        d.active = true;
        setDragging(true);
        try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 旧浏览器 */ }
        pushRatio(ratioFromPointer(ev.clientX));
      };

      const onPointerMove = (ev) => {
        if (!dragRef.current.active) return;
        pushRatio(ratioFromPointer(ev.clientX));
      };

      const endDrag = (ev) => {
        const d = dragRef.current;
        if (!d.active) return;
        d.active = false;
        setDragging(false);
        try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* 忽略 */ }
        // 松手时用 snap 精确落位一次（snap 会重新查状态、更稳）
        const finalRatio = d.pending >= 0 ? d.pending : ratio;
        d.pending = -1;
        Promise.resolve(face.snap(finalRatio)).catch(() => { /* 忽略 */ });
      };

      // 工作区路径：从 props 拿（DSH 会把当前会话的 cwd 传下来），拿不到就留空
      const workspacePath = String(props.workspacePath || props.cwd || "");

      if (fatal) {
        return jsx("div", { className: "OS_root", children: jsx("p", { className: "OS_msg", "data-kind": "err", children: fatal }) });
      }

      const available = status ? status.available === true : false;
      const hasObsidian = status ? status.obHandle > 0 : false;
      const stateKind = available ? (status.snapped ? "on" : "off") : "err";
      const stateText = available ? (status.snapped ? t("stateOn") : t("stateOff")) : t("stateErr");
      const wa = status ? status.workArea : { width: 0, height: 0 };
      const leftPct = Math.round(ratio * 100);
      const rightPct = 100 - leftPct;
      const vaultGuess = vaultNameFromPath(workspacePath);

      return jsx("div", { className: "OS_root", children: [
        // 标题 + 状态
        jsx("div", { key: "head", className: "OS_card", children: [
          jsx("div", { key: "r", className: "OS_row", children: [
            jsx("h3", { key: "t", className: "OS_h", children: t("title") }),
            jsx("span", { key: "b", className: "OS_badge", "data-s": stateKind, children: (stateKind === "on" ? "◧ " : stateKind === "off" ? "○ " : "! ") + stateText })
          ] }),
          jsx("p", { key: "p", className: "OS_p", children: t("intro") }),
          status && status.reason
            ? jsx("p", { key: "why", className: "OS_msg", "data-kind": available ? "info" : "err", children: status.reason })
            : null
        ] }),

        // 拖动轨道 —— 这块是核心
        jsx("div", { key: "track", className: "OS_card", children: [
          jsx("div", { key: "lbl", className: "OS_label", children: [
            jsx("span", { key: "a", children: leftPct + " : " + rightPct }),
            jsx("span", { key: "b", children: dragging ? "调整中…" : t("dragHint") })
          ] }),
          jsx("div", {
            key: "tk",
            ref: trackRef,
            className: "OS_track",
            onPointerDown: available && hasObsidian ? onPointerDown : undefined,
            onPointerMove: onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            title: available && hasObsidian ? t("dragHint") : (status && status.reason ? status.reason : ""),
            children: [
              jsx("div", { key: "l", className: "OS_side", style: { left: "0px", width: leftPct + "%" }, children: "DSH" }),
              jsx("div", { key: "r", className: "OS_side", style: { right: "0px", width: rightPct + "%" }, children: "Obsidian" }),
              jsx("div", {
                key: "s",
                className: "OS_split",
                "data-dragging": dragging ? "true" : "false",
                style: { left: leftPct + "%" }
              })
            ]
          }),
          jsx("div", { key: "note", className: "OS_note", children: t("saved") })
        ] }),

        // 操作
        jsx("div", { key: "ops", className: "OS_card", children: [
          jsx("div", { key: "r1", className: "OS_row", children: [
            jsx("button", {
              key: "snap", type: "button", className: "OS_btn", "data-kind": "primary",
              disabled: !available || !hasObsidian,
              onClick: () => doSnap(),
              children: t("snap")
            }),
            jsx("button", { key: "un", type: "button", className: "OS_btn", disabled: !available, onClick: doUnsnap, children: t("unsnap") }),
            jsx("button", { key: "rc", type: "button", className: "OS_btn", onClick: refresh, children: t("recheck") })
          ] }),
          jsx("div", { key: "r2", className: "OS_row", children: (status ? status.presets : [0.5, 0.62, 0.7, 0.38]).map((p) => {
            const lp = Math.round(p * 100);
            return jsx("button", {
              key: "p" + lp, type: "button", className: "OS_btn",
              disabled: !available || !hasObsidian,
              onClick: () => doSnap(p),
              children: lp + " : " + (100 - lp)
            });
          }) }),
          jsx("div", { key: "r3", className: "OS_row", children: [
            jsx("button", { key: "fl", type: "button", className: "OS_btn", disabled: !available, onClick: () => doFocus("left"), children: t("focusLeft") }),
            jsx("button", { key: "fr", type: "button", className: "OS_btn", disabled: !available || !hasObsidian, onClick: () => doFocus("right"), children: t("focusRight") })
          ] }),
          msg ? jsx("p", { key: "m", className: "OS_msg", "data-kind": msg.kind, children: msg.text }) : null
        ] }),

        // Obsidian 库
        jsx("div", { key: "vault", className: "OS_card", children: [
          jsx("h3", { key: "h", className: "OS_h", children: t("vault") }),
          jsx("dl", { key: "dl", className: "OS_kv", children: [
            jsx("dt", { key: "k1", className: "OS_k", children: t("vault") }),
            jsx("dd", { key: "v1", className: "OS_v", children: vaultGuess || "—" }),
            jsx("dt", { key: "k2", className: "OS_k", children: t("screen") }),
            jsx("dd", { key: "v2", className: "OS_v", children: wa.width > 0 ? wa.width + " × " + wa.height : "—" })
          ] }),
          jsx("div", { key: "b", className: "OS_row", children: jsx("button", {
            type: "button", className: "OS_btn",
            disabled: vaultGuess.length === 0,
            onClick: doOpenVault,
            children: t("openVault")
          }) })
        ] }),

        // 说明
        jsx("div", { key: "help", className: "OS_card", children: [
          jsx("h3", { key: "h", className: "OS_h", children: t("howTitle") }),
          jsx("p", { key: "p", className: "OS_p", children: t("howBody") })
        ] })
      ] });
    }

    // ── cordis 插件体 ─────────────────────────────────────────────────
    const inject = ["slots", "sidebarRightTabs", "sidebarRight", "locale", "remote"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-split-obsidian: dictionaries");
      const t = ctx.locale.bind(NS);

      const mount = ctx.remote.$mount(CONTRIBUTION);
      /*
       * 所有远程方法都收一个叫 args 的 JSON 参数（见 CONTRIBUTION 的注释）。
       * 无参方法也要传一个对象 —— 传 undefined 会让参数 codec 拿到空值。
       */
      /*
       * 有参方法传 { ... }，无参方法**什么都不传**。
       * 给无参方法传 {} 会和描述符的 parameters: [] 对不上，边界校验会拒。
       */
      const callRemote = async (method, args) => {
        await mount;
        const remote = ctx.get("remote.obsidianSplit");
        if (remote === undefined) throw new Error("obsidianSplit 服务不可用（host 半可能未加载）");
        const result = args === undefined ? await remote[method]() : await remote[method](args);
        if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
        return result.value;
      };
      const face = () => ({
        status: () => callRemote("status"),
        snap: (ratio) => callRemote("snap", { ratio: ratio }),
        drag: (ratio) => callRemote("drag", { ratio: ratio }),
        unsnap: () => callRemote("unsnap"),
        focus: (side) => callRemote("focus", { side: side }),
        openVault: (vaultName) => callRemote("openVault", { vaultName: vaultName })
      });

      // ① 声明标签页类型 + 引导页条目（就出现在「工作区文件 / 浏览器 / 书签」那个列表里）
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t("nav"),
          guide: [{
            id: TAB_ID + ":entry",
            order: 60,
            title: () => t("nav"),
            description: () => t("intro"),
            icon: () => "◧"
          }]
        }),
        "dsh-split-obsidian: tab type"
      );

      // ② 提供正文。key 必须与上面的 id 逐字一致。
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, locale: NS, inject: face }, ObsidianSplitPanel)
        ),
        "dsh-split-obsidian: tab body"
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    exports.ObsidianSplitPanel = ObsidianSplitPanel;
    exports.TAB_KIND = TAB_KIND;
    exports.TAB_ID = TAB_ID;
    return module.exports;
  }
});
