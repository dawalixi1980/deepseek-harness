/*
 * dsh-lexiang — credential + settings store.
 *
 * Credentials live OUTSIDE the repository, in the user's DSH directory, so a
 * cloned plugin never ships anyone's token:
 *
 *   ~/.dsh/dsh-lexiang.json
 *   {
 *     "companyFrom": "...",
 *     "token": "lxmcp_...",
 *     "endpoint": "https://mcp.lexiang-app.com/mcp",
 *     "activeSpaceId": "...",
 *     "recent": [{ "id", "name", "at" }]
 *   }
 *
 * The file is written with mode 0600 where the platform supports it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_FILE = path.join(os.homedir(), ".dsh", "dsh-lexiang.json");
export const MAX_RECENT = 10;

function emptyState() {
  return {
    companyFrom: "",
    token: "",
    endpoint: "",
    activeSpaceId: "",
    recent: [],
  };
}

/** Read state, tolerating a missing/corrupt file. */
export function loadState(file = STATE_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return emptyState();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object") return emptyState();
  const base = emptyState();
  return {
    companyFrom: typeof parsed.companyFrom === "string" ? parsed.companyFrom : base.companyFrom,
    token: typeof parsed.token === "string" ? parsed.token : base.token,
    endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : base.endpoint,
    activeSpaceId:
      typeof parsed.activeSpaceId === "string" ? parsed.activeSpaceId : base.activeSpaceId,
    recent: Array.isArray(parsed.recent)
      ? parsed.recent
          .filter((r) => r && typeof r.id === "string" && r.id.length > 0)
          .slice(0, MAX_RECENT)
          .map((r) => ({
            id: r.id,
            name: typeof r.name === "string" ? r.name : r.id,
            at: Number.isFinite(r.at) ? r.at : Date.now(),
          }))
      : [],
  };
}

/** Write state atomically (tmp + rename) with restrictive permissions. */
export function saveState(state, file = STATE_FILE) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return file;
}

/** Never echo a token back to the UI in full. */
export function maskToken(token) {
  const t = String(token || "");
  if (t.length === 0) return "";
  if (t.length <= 10) return `${t.slice(0, 2)}****`;
  return `${t.slice(0, 5)}…${t.slice(-4)} (${t.length} 位)`;
}

/** Public, safe-to-render view of the state (no raw token). */
export function publicState(state) {
  return {
    companyFrom: state.companyFrom || "",
    hasToken: Boolean(state.token && state.token.length > 0),
    tokenMasked: maskToken(state.token),
    endpoint: state.endpoint || "",
    activeSpaceId: state.activeSpaceId || "",
    recent: state.recent || [],
    configured: Boolean(state.companyFrom && state.token),
  };
}

/** Merge a partial patch into state, preserving unknown/absent fields. */
export function applyPatch(state, patch = {}) {
  const next = { ...state };
  if (typeof patch.companyFrom === "string") next.companyFrom = patch.companyFrom.trim();
  if (typeof patch.endpoint === "string") next.endpoint = patch.endpoint.trim();
  if (typeof patch.activeSpaceId === "string") next.activeSpaceId = patch.activeSpaceId;
  // A token patch replaces the stored one; `null` clears it, `undefined` keeps it.
  if (patch.token === null) next.token = "";
  else if (typeof patch.token === "string" && patch.token.trim().length > 0) {
    next.token = patch.token.trim();
  }
  if (Array.isArray(patch.recent)) next.recent = patch.recent.slice(0, MAX_RECENT);
  return next;
}

/** Push a space to the front of the recently-used list. */
export function rememberSpace(state, space) {
  if (!space || !space.id) return state;
  const rest = (state.recent || []).filter((r) => r.id !== space.id);
  return {
    ...state,
    recent: [{ id: space.id, name: space.name || space.id, at: Date.now() }, ...rest].slice(
      0,
      MAX_RECENT,
    ),
  };
}
