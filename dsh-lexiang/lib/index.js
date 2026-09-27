/*
 * dsh-lexiang — host half.
 *
 * Registers a Typert remote service so the client panel can drive Lexiang:
 *   settings      read / write credentials (token never returned in full)
 *   test          validate credentials via whoami
 *   teams/spaces  browse the tenant and its knowledge bases
 *   children      list an entry's children (lazy tree expansion)
 *   read          fetch an entry and, for pages, its body text
 *   search        keyword or embedding search
 *   create        create a page or folder
 *   rename/move   reorganize entries
 *   remove        invalidate an entry
 *   upload        three-step file upload (apply -> PUT -> commit)
 *
 * Credentials are stored in ~/.dsh/dsh-lexiang.json (outside any repository),
 * so each user supplies their own COMPANY_FROM + token through the UI.
 */

/*
 * `@deepseek-ai/dsh-typert-protocol` is resolved by DSH's own loader at runtime
 * (it lives inside the app bundle), so it is imported dynamically: that keeps
 * the module importable by the offline tests, which run outside DSH and cannot
 * resolve the package. A minimal stand-in is used when it is unavailable.
 */
let TypertRemoteService;
try {
  ({ TypertRemoteService } = await import("@deepseek-ai/dsh-typert-protocol"));
} catch {
  TypertRemoteService = class {
    constructor(ctx, namespace) {
      this.ctx = ctx;
      this.namespace = namespace;
    }
  };
}

import { LexiangClient, LexiangError, LX_ERR, DEFAULT_ENDPOINT } from "./lexiang-api.js";
import {
  loadState,
  saveState,
  publicState,
  applyPatch,
  rememberSpace,
  STATE_FILE,
} from "./store.js";

/**
 * Plugin name — must match the `id` in cordis.patch.yml, exactly like
 * dsh-skill-url does (`export const name = "skill-url"` for `id: skill-url`).
 */
export const name = "lexiang";

/**
 * Services this plugin needs before apply() runs.
 *
 * MISSING `inject` WAS THE ROOT CAUSE OF THE 404:
 * without declaring `typert`, `ctx.typert` is not wired up, so
 * `ctx.typert.register(MANIFEST)` never publishes the remote methods. The
 * client half still renders its panel (it loads independently), but every call
 * then fails with
 *   "transport failure for /api/lexiang/getSettings: HTTP 404"
 * because the host registered no route.
 *
 * dsh-skill-url declares `["typert", "skills", "sessions", "agents"]`; we only
 * need `typert`.
 */
export const inject = ["typert"];

/** Shape of every remote reply: { ok, data?, error? }. */
const ok = (data) => ({ ok: true, data: data === undefined ? null : data });
const fail = (err) => ({
  ok: false,
  error: {
    code: (err && err.code) || LX_ERR.UPSTREAM,
    message: (err && err.message) || String(err),
    detail: (err && err.detail) || "",
  },
});

/** Typert strict codec: the loader requires a `create` factory. */
const codec = (typeSymbol) => ({ mode: "strict", typeSymbol, create: () => anyObject });

/** Minimal permissive schema — the panel validates before sending. */
const anyObject = {
  parse: (v) => (v && typeof v === "object" ? v : {}),
  safeParse: (v) => ({ success: true, data: v }),
};

/**
 * One invocation per remote method. Each takes a single optional JSON object
 * named `args` (the panel always sends `{...}`), which keeps the descriptor
 * list uniform while staying inside the strict-codec contract.
 */
function invocation(method) {
  return {
    id: `dsh-lexiang#lexiang/${method}`,
    service: "lexiang",
    namespace: "lexiang",
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        acceptsUndefined: true,
        codec: codec(`dsh-lexiang#${method}Args`),
      },
    ],
    result: codec(`dsh-lexiang#${method}Result`),
  };
}

export const METHODS = [
  "getSettings",
  "saveSettings",
  "clearSettings",
  "testConnection",
  "listTeams",
  "listSpaces",
  "describeSpace",
  "listChildren",
  "readEntry",
  "search",
  "createEntry",
  "renameEntry",
  "moveEntry",
  "removeEntry",
  "uploadFile",
];

export const MANIFEST = {
  package: "dsh-lexiang",
  face: "host",
  schemas: [],
  invocations: METHODS.map(invocation),
  model: {},
};

/**
 * The runtime service the client face talks to.
 *
 * MUST extend TypertRemoteService and call `super(ctx, namespace)`:
 * cordis constructs plugin classes with the context as the FIRST argument
 * (`new LexiangService(ctx)`), so a plain class that destructures its first
 * argument as a config object blows up with
 *   "Cannot get property \"file\" without inject at new LexiangService"
 * and the whole bundle fails to activate (GUI: 「1 entry did not activate」).
 *
 * Incident record: this class was originally a plain class with
 * `constructor({file, fetchImpl} = {})` and `apply()` called
 * `ctx.typert.register(MANIFEST, service)`. Two mistakes at once — the second
 * argument is not how the service is bound (register takes MANIFEST only), and
 * the constructor must accept ctx. Fixed by mirroring dsh-skill-url, which is
 * known to activate.
 */
export class LexiangService extends TypertRemoteService {
  constructor(ctx, options = {}) {
    super(ctx, "lexiang");
    // Options are only used by the offline tests; in DSH they are absent.
    this.file = options.file || STATE_FILE;
    this.fetchImpl = options.fetchImpl;
    this._client = null;
    this._clientKey = "";
  }

  get state() {
    return loadState(this.file);
  }

  _persist(next) {
    saveState(next, this.file);
    this._client = null;
    this._clientKey = "";
    return next;
  }

  /** Lazily build a client, rebuilding whenever credentials change. */
  _clientFor(state) {
    const key = `${state.companyFrom}|${state.token}|${state.endpoint}`;
    if (this._client && this._clientKey === key) return this._client;
    const c = new LexiangClient({
      companyFrom: state.companyFrom,
      token: state.token,
      endpoint: state.endpoint || DEFAULT_ENDPOINT,
      fetchImpl: this.fetchImpl,
    });
    this._client = c;
    this._clientKey = key;
    return c;
  }

  _require() {
    const state = this.state;
    if (!state.companyFrom || !state.token) {
      throw new LexiangError(
        LX_ERR.NO_CREDENTIALS,
        "尚未配置乐享凭证：请填写 COMPANY_FROM 与 LEXIANG_TOKEN 后保存。",
      );
    }
    return { state, client: this._clientFor(state) };
  }

  // ---------------------------------------------------------------- settings

  getSettings() {
    return ok({ ...publicState(this.state), stateFile: this.file });
  }

  saveSettings(patch) {
    const before = this.state;
    const next = applyPatch(before, patch || {});
    this._persist(next);
    return ok({ ...publicState(next), stateFile: this.file });
  }

  clearSettings() {
    const next = { companyFrom: "", token: "", endpoint: "", activeSpaceId: "", recent: [] };
    this._persist(next);
    return ok({ ...publicState(next), stateFile: this.file });
  }

  async testConnection() {
    try {
      const { client } = this._require();
      const me = await client.whoami();
      const staff = (me && me.staff) || {};
      const company = (me && me.company) || {};
      return ok({
        staffName: staff.display_name || "",
        staffId: staff.id || "",
        companyName: company.name || company.corp_name || "",
        companyFrom: company.code || this.state.companyFrom,
        personalSpaceId: (me && me.personal_space && me.personal_space.id) || "",
      });
    } catch (err) {
      return fail(err);
    }
  }

  // ------------------------------------------------------------------ browse

  async listTeams() {
    try {
      const { client } = this._require();
      const data = await client.json("team_list_teams", {});
      const teams = ((data && data.teams) || []).map((t) => ({
        id: t.id,
        name: t.name || t.id,
        code: t.code || "",
      }));
      return ok({ teams });
    } catch (err) {
      return fail(err);
    }
  }

  async listSpaces({ teamId, limit = 50 } = {}) {
    try {
      const { client } = this._require();
      const args = { limit };
      if (teamId) args.team_id = teamId;
      const data = await client.json("space_list_spaces", args);
      const spaces = ((data && data.spaces) || []).map((s) => ({
        id: s.id,
        name: s.name || s.id,
        description: s.description || "",
        rootEntryId: s.root_entry_id || "",
        spaceType: s.space_type,
      }));
      return ok({ spaces, nextPageToken: (data && data.next_page_token) || "" });
    } catch (err) {
      return fail(err);
    }
  }

  async describeSpace({ spaceId } = {}) {
    try {
      const { client } = this._require();
      let space;
      if (spaceId) {
        const data = await client.json("lexiang_fetch", { resource: "space", id: spaceId });
        space = data.space || data;
      } else {
        const data = await client.json("space_describe_personal_space", {});
        space = data.space || data;
      }
      const view = {
        id: space.id,
        name: space.name || space.id,
        description: space.description || "",
        rootEntryId: space.root_entry_id || "",
      };
      if (view.id) this._persist(rememberSpace(this.state, view));
      return ok(view);
    } catch (err) {
      return fail(err);
    }
  }

  async listChildren({ parentId, limit = 50, pageToken = "" } = {}) {
    try {
      if (!parentId) throw new LexiangError(LX_ERR.PROTOCOL, "缺少 parentId");
      const { client } = this._require();
      const args = { parent_id: parentId, limit };
      if (pageToken) args.page_token = pageToken;
      const data = await client.json("entry_list_children", args);
      const entries = ((data && data.entries) || []).map((e) => ({
        id: e.id,
        name: e.name || e.id,
        type: e.entry_type || "",
        hasChildren: Boolean(e.has_children),
        targetType: e.target_type || "",
        targetId: e.target_id || "",
        extension: e.extension || "",
        icon: e.display_icon || "",
        editedAt: Number(e.edited_at) || 0,
        validity: e.validity_type || "none",
      }));
      return ok({ entries, nextPageToken: (data && data.next_page_token) || "" });
    } catch (err) {
      return fail(err);
    }
  }

  async readEntry({ entryId } = {}) {
    try {
      if (!entryId) throw new LexiangError(LX_ERR.PROTOCOL, "缺少 entryId");
      const { client } = this._require();

      let entry = null;
      try {
        const data = await client.json("entry_describe_entry", { entry_id: entryId });
        entry = data.entry || data;
      } catch {
        const data = await client.json("lexiang_fetch", { resource: "entry", id: entryId });
        entry = data.entry || data;
      }

      // Pages carry their body in a separate call.
      let body = "";
      let bodyFormat = "";
      if (entry && entry.entry_type === "page") {
        try {
          const page = await client.json("block_fetch_page", {
            entry_id: entryId,
            render_mode: "markdown",
          });
          body =
            (page && (page.content || page.markdown || page.text)) ||
            (typeof page === "string" ? page : "");
          bodyFormat = "markdown";
        } catch (e) {
          body = `（正文读取失败：${e && e.message ? e.message : e}）`;
        }
      }

      return ok({
        entry: entry
          ? {
              id: entry.id,
              name: entry.name || entry.id,
              type: entry.entry_type || "",
              parentId: entry.parent_id || "",
              spaceId: entry.space_id || "",
              targetId: entry.target_id || "",
              editedAt: Number(entry.edited_at) || 0,
              createdAt: Number(entry.created_at) || 0,
            }
          : { id: entryId, name: entryId },
        body,
        bodyFormat,
      });
    } catch (err) {
      return fail(err);
    }
  }

  async search({ query, mode = "keyword", spaceId, limit = 20, threshold } = {}) {
    try {
      const q = String(query || "").trim();
      if (!q) throw new LexiangError(LX_ERR.PROTOCOL, "搜索关键词不能为空");
      const { client } = this._require();

      if (mode === "semantic") {
        const filters = { keyword: q };
        const args = { filters, limit };
        if (spaceId) args.space_id = spaceId;
        if (Number.isFinite(threshold)) args.threshold = threshold;
        const data = await client.json("search_kb_embedding_search", args);
        const items = (data && (data.docs || data.chunks)) || [];
        return ok({
          mode,
          hits: items.map((d) => ({
            id: d.id || d.target_id || "",
            title: d.title || d.target_id || "(无标题)",
            snippet: String(d.content || "").slice(0, 400),
            score: typeof d.score === "number" ? d.score : null,
            spaceId: d.space_id || "",
            fileType: d.file_type || "",
          })),
        });
      }

      const data = await client.json("search_kb_search", { query: q, limit });
      const docs = (data && data.docs) || [];
      return ok({
        mode,
        total: (data && data.total) || docs.length,
        hits: docs.map((d) => ({
          id: d.id || d.target_id || "",
          title: d.title || "(无标题)",
          snippet: String(d.content || "").slice(0, 400),
          score: null,
          spaceId: d.space_id || "",
          fileType: d.file_type || "",
          targetType: d.target_type || "",
        })),
      });
    } catch (err) {
      return fail(err);
    }
  }

  // ------------------------------------------------------------------ mutate

  async createEntry({ parentId, name, type = "page" } = {}) {
    try {
      if (!parentId) throw new LexiangError(LX_ERR.PROTOCOL, "缺少 parentId");
      if (!name || !String(name).trim()) throw new LexiangError(LX_ERR.PROTOCOL, "名称不能为空");
      const kind = type === "folder" ? "folder" : "page";
      const { client } = this._require();
      const data = await client.json("entry_create_entry", {
        entry_type: kind,
        parent_entry_id: parentId,
        name: String(name).trim(),
      });
      const entry = (data && data.entry) || data;
      return ok({ id: entry.id, name: entry.name, type: entry.entry_type });
    } catch (err) {
      return fail(err);
    }
  }

  async renameEntry({ entryId, name } = {}) {
    try {
      if (!entryId || !name || !String(name).trim()) {
        throw new LexiangError(LX_ERR.PROTOCOL, "缺少 entryId 或 name");
      }
      const { client } = this._require();
      await client.json("entry_rename_entry", {
        entry_id: entryId,
        name: String(name).trim(),
      });
      return ok({ id: entryId, name: String(name).trim() });
    } catch (err) {
      return fail(err);
    }
  }

  async moveEntry({ entryId, targetParentId } = {}) {
    try {
      if (!entryId || !targetParentId) {
        throw new LexiangError(LX_ERR.PROTOCOL, "缺少 entryId 或 targetParentId");
      }
      const { client } = this._require();
      await client.json("entry_move_entry", {
        entry_id: entryId,
        parent_entry_id: targetParentId,
      });
      return ok({ id: entryId, parentId: targetParentId });
    } catch (err) {
      return fail(err);
    }
  }

  async removeEntry({ entryId } = {}) {
    try {
      if (!entryId) throw new LexiangError(LX_ERR.PROTOCOL, "缺少 entryId");
      const { client } = this._require();
      await client.json("entry_set_entry_validity", {
        entry_id: entryId,
        validity_type: "force_expire",
      });
      return ok({ id: entryId, removed: true });
    } catch (err) {
      return fail(err);
    }
  }

  // ------------------------------------------------------------------ upload

  /**
   * Three-step upload. `contentBase64` keeps the wire format JSON-safe; the
   * client reads the file and encodes it, so the host never needs fs access to
   * the user's picked file.
   */
  async uploadFile({ parentId, fileName, contentBase64, mimeType, fileId } = {}) {
    try {
      if (!parentId) throw new LexiangError(LX_ERR.PROTOCOL, "缺少 parentId");
      if (!fileName) throw new LexiangError(LX_ERR.PROTOCOL, "缺少 fileName");
      if (!contentBase64) throw new LexiangError(LX_ERR.PROTOCOL, "文件内容为空");
      const { client } = this._require();

      const applyArgs = {
        upload_type: "PRE_SIGNED_URL",
        parent_entry_id: parentId,
        file_name: fileName,
      };
      if (fileId) applyArgs.file_id = fileId;

      const applied = await client.json("file_apply_upload", applyArgs);
      const session = applied.session || applied;
      const sessionId = session.session_id || session.sessionId;
      const uploadUrl = session.upload_url || session.uploadUrl;
      if (!sessionId || !uploadUrl) {
        throw new LexiangError(LX_ERR.PROTOCOL, "申请上传凭证失败：缺少 session_id 或 upload_url");
      }

      // Step 2: the presigned PUT is a plain HTTP request, not an MCP call.
      const buf = Buffer.from(contentBase64, "base64");
      const putRes = await (this.fetchImpl || globalThis.fetch)(uploadUrl, {
        method: "PUT",
        headers: mimeType ? { "Content-Type": mimeType } : undefined,
        body: buf,
      });
      if (!putRes.ok) {
        throw new LexiangError(
          LX_ERR.NETWORK,
          `文件上传失败（HTTP ${putRes.status}）`,
          `PUT ${uploadUrl}`,
        );
      }

      // Step 3: confirm so the entry is actually created.
      const committed = await client.json("file_commit_upload", { session_id: sessionId });
      const entry = (committed && committed.entry) || committed || {};
      return ok({
        id: entry.id || "",
        name: entry.name || fileName,
        sessionId,
        bytes: buf.length,
      });
    } catch (err) {
      return fail(err);
    }
  }
}

/**
 * Cordis plugin entry. `register(MANIFEST)` takes the manifest ONLY — the
 * service is constructed by cordis from this class, not passed in.
 *
 * Guard rail: if `ctx.typert` is absent we are missing the `inject` declaration
 * (see above) and every remote call would 404 at runtime. Failing here instead
 * makes that mistake obvious at boot rather than as a confusing 404 in the UI.
 */
export function apply(ctx) {
  const service = new LexiangService(ctx);
  if (!ctx || !ctx.typert || typeof ctx.typert.register !== "function") {
    throw new Error(
      "dsh-lexiang: ctx.typert 不可用 —— 缺少 `export const inject = [\"typert\"]`，" +
        "远程方法将无法注册（客户端会收到 HTTP 404）",
    );
  }
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-lexiang: typert manifest");
  return service;
}

export { LexiangService as default };
