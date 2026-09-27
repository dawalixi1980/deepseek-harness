/*
 * dsh-lexiang — Lexiang (乐享) MCP transport layer.
 *
 * Zero third-party dependencies: talks to the Lexiang MCP endpoint with the
 * global fetch (Node >= 18). The endpoint is a JSON-RPC 2.0 server over
 * "streamable HTTP" that answers with Server-Sent Events, so every response is
 * decoded from `data:` lines rather than parsed as plain JSON.
 *
 * Wire facts (verified against mcp.lexiang-app.com):
 *   URL   https://mcp.lexiang-app.com/mcp?preset=meta&company_from=<COMPANY_FROM>
 *   Auth  Authorization: Bearer <LEXIANG_TOKEN>
 *   meta  tools (list_tool_categories / search_tools / get_tool_schema) are
 *         invoked directly by name.
 *   business tools MUST be invoked through the `call_tool` meta tool with
 *         { tool_name, arguments }.
 */

export const DEFAULT_ENDPOINT = "https://mcp.lexiang-app.com/mcp";

/** Error codes we surface to the UI verbatim. */
export const LX_ERR = {
  NO_CREDENTIALS: "NO_CREDENTIALS",
  AUTH: "AUTH",
  NETWORK: "NETWORK",
  PROTOCOL: "PROTOCOL",
  UPSTREAM: "UPSTREAM",
};

export class LexiangError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "LexiangError";
    this.code = code;
    this.detail = detail;
  }
}

/** Build the endpoint URL for a given company_from. */
export function endpointFor(companyFrom, base) {
  const root = (base && String(base).trim()) || DEFAULT_ENDPOINT;
  const cf = String(companyFrom || "").trim();
  const sep = root.includes("?") ? "&" : "?";
  return `${root}${sep}preset=meta&company_from=${encodeURIComponent(cf)}`;
}

/**
 * Decode a streamable-HTTP response body. The server replies either with plain
 * JSON or with an SSE stream whose final `data:` line holds the JSON-RPC
 * envelope.
 */
export function decodeBody(text) {
  const raw = String(text == null ? "" : text);
  const trimmed = raw.trim();
  if (!trimmed) throw new LexiangError(LX_ERR.PROTOCOL, "乐享返回了空响应");
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to SSE decoding */
    }
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload);
    } catch {
      /* keep scanning upwards */
    }
  }
  throw new LexiangError(LX_ERR.PROTOCOL, "无法解析乐享响应", raw.slice(0, 400));
}

/**
 * A single Lexiang MCP connection. Holds credentials, tracks the session id the
 * server hands back, and exposes `call` / `biz` helpers.
 */
export class LexiangClient {
  constructor({ companyFrom, token, endpoint, timeoutMs = 60000, fetchImpl } = {}) {
    this.companyFrom = String(companyFrom || "").trim();
    this.token = String(token || "").trim();
    this.endpoint = endpointFor(this.companyFrom, endpoint);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.sessionId = null;
    this._seq = 0;
    this._initialized = false;
  }

  get configured() {
    return this.companyFrom.length > 0 && this.token.length > 0;
  }

  _assertConfigured() {
    if (!this.configured) {
      throw new LexiangError(
        LX_ERR.NO_CREDENTIALS,
        "尚未配置乐享凭证：请在面板里填写 COMPANY_FROM 与 LEXIANG_TOKEN。",
      );
    }
    if (typeof this.fetchImpl !== "function") {
      throw new LexiangError(LX_ERR.NETWORK, "当前运行环境没有可用的 fetch 实现");
    }
  }

  /** POST one JSON-RPC envelope, returning the parsed `result` (or throwing). */
  async _rpc(method, params) {
    this._assertConfigured();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;

    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: (this._seq += 1), method, params }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new LexiangError(LX_ERR.NETWORK, `无法连接乐享：${msg}`, msg);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const sid = res.headers && res.headers.get ? res.headers.get("mcp-session-id") : null;
    if (sid) this.sessionId = sid;

    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw new LexiangError(LX_ERR.NETWORK, "读取乐享响应失败", String(err));
    }

    if (res.status === 401 || res.status === 403) {
      throw new LexiangError(
        LX_ERR.AUTH,
        "乐享凭证无效或已过期（401）。请到 https://lexiangla.com/mcp 点「续期」，或重新填写凭证。",
        text.slice(0, 300),
      );
    }

    const body = decodeBody(text);
    if (body && body.error) {
      throw new LexiangError(
        LX_ERR.UPSTREAM,
        body.error.message || "乐享返回了错误",
        JSON.stringify(body.error).slice(0, 400),
      );
    }
    return body && body.result !== undefined ? body.result : body;
  }

  /** Perform the MCP handshake once per client instance. */
  async initialize() {
    if (this._initialized) return true;
    await this._rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "dsh-lexiang", version: "0.1.0" },
    });
    this._initialized = true;
    return true;
  }

  /** Pull the text out of an MCP tools/call result. */
  static _textOf(result) {
    if (!result) return "";
    const content = result.content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  }

  /** Invoke a meta tool directly by name. */
  async meta(name, args) {
    await this.initialize();
    const result = await this._rpc("tools/call", { name, arguments: args || {} });
    return LexiangClient._textOf(result);
  }

  /**
   * Invoke a business tool through `call_tool`, returning its raw text payload.
   * Callers normally want `json()` instead.
   */
  async raw(toolName, args) {
    await this.initialize();
    const result = await this._rpc("tools/call", {
      name: "call_tool",
      arguments: { tool_name: toolName, arguments: args || {} },
    });
    const text = LexiangClient._textOf(result);
    if (result && result.isError) {
      throw new LexiangError(LX_ERR.UPSTREAM, text || "乐享工具调用失败", text);
    }
    return text;
  }

  /**
   * Invoke a business tool and parse the JSON envelope the Lexiang API returns
   * (`{ code, message, data }`). A non-zero `code` becomes an upstream error.
   */
  async json(toolName, args) {
    const text = await this.raw(toolName, args);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LexiangError(LX_ERR.PROTOCOL, `${toolName} 返回了非 JSON 内容`, text.slice(0, 300));
    }
    if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
      throw new LexiangError(
        LX_ERR.UPSTREAM,
        parsed.message || `${toolName} 失败 (code ${parsed.code})`,
        JSON.stringify(parsed).slice(0, 300),
      );
    }
    return parsed && parsed.data !== undefined ? parsed.data : parsed;
  }

  /** Cheap credential probe: resolves the caller's identity. */
  async whoami() {
    return this.json("whoami", {});
  }
}

export default LexiangClient;
