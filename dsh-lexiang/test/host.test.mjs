/*
 * Offline tests for the host service (no network, temp state file).
 * Run: node test/host.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LexiangService, MANIFEST } from "../lib/index.js";
import { loadState, saveState, publicState, applyPatch, rememberSpace, maskToken, MAX_RECENT } from "../lib/store.js";
import { LX_ERR } from "../lib/lexiang-api.js";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
    fail += 1;
  }
}

const tmpFile = path.join(os.tmpdir(), `dsh-lexiang-test-${process.pid}.json`);
function freshService(fetchImpl) {
  try { fs.unlinkSync(tmpFile); } catch {}
  return new LexiangService({ file: tmpFile, fetchImpl });
}

/** Reply helper: wrap a Lexiang envelope into an MCP tools/call result. */
const mcpReply = (obj) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(obj) }] },
  });

function routedFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const isPut = Boolean(init && init.method === "PUT");
    // presigned PUT carries raw bytes, never JSON — handle it before parsing.
    if (isPut) {
      calls.push({ url, method: "PUT", body: null });
      const r = routes.put ? routes.put(url, init) : { status: 200 };
      return { ok: r.status === 200, status: r.status, headers: { get: () => null }, text: async () => "" };
    }
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, method: init && init.method, body });
    const tool = body.params && body.params.arguments ? body.params.arguments.tool_name : body.method;
    const handler = routes[tool] || routes[body.method];
    const payload = handler ? handler(body) : { code: 0, data: {} };
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => mcpReply(payload),
    };
  };
  impl.calls = calls;
  return impl;
}

console.log("\n=== store ===");
await t("loadState 对缺失文件返回空状态", () => {
  const s = loadState(path.join(os.tmpdir(), "definitely-missing-xyz.json"));
  assert.equal(s.companyFrom, "");
  assert.deepEqual(s.recent, []);
});
await t("loadState 对损坏 JSON 返回空状态", () => {
  const bad = path.join(os.tmpdir(), `bad-${process.pid}.json`);
  fs.writeFileSync(bad, "{ not json");
  assert.equal(loadState(bad).token, "");
  fs.unlinkSync(bad);
});
await t("saveState + loadState 往返一致", () => {
  const s = { companyFrom: "cf", token: "tok", endpoint: "", activeSpaceId: "sp", recent: [] };
  saveState(s, tmpFile);
  const back = loadState(tmpFile);
  assert.equal(back.companyFrom, "cf");
  assert.equal(back.token, "tok");
  assert.equal(back.activeSpaceId, "sp");
});
await t("applyPatch 未提供 token 时保留原值", () => {
  const s = { companyFrom: "a", token: "keep", endpoint: "", activeSpaceId: "", recent: [] };
  assert.equal(applyPatch(s, { companyFrom: "b" }).token, "keep");
});
await t("applyPatch token=null 清空", () => {
  const s = { companyFrom: "a", token: "x", endpoint: "", activeSpaceId: "", recent: [] };
  assert.equal(applyPatch(s, { token: null }).token, "");
});
await t("publicState 不回传明文 token", () => {
  const p = publicState({ companyFrom: "cf", token: "lxmcp_secret_value_123456", endpoint: "", activeSpaceId: "", recent: [] });
  assert.equal(p.hasToken, true);
  assert.ok(!JSON.stringify(p).includes("secret_value"));
  assert.ok(p.tokenMasked.includes("lxmcp"));
});
await t("maskToken 短值也不泄露", () => {
  assert.equal(maskToken(""), "");
  assert.ok(!maskToken("abc").includes("abc"));
});
await t("rememberSpace 去重并置顶", () => {
  let s = { companyFrom: "", token: "", endpoint: "", activeSpaceId: "", recent: [] };
  s = rememberSpace(s, { id: "a", name: "A" });
  s = rememberSpace(s, { id: "b", name: "B" });
  s = rememberSpace(s, { id: "a", name: "A2" });
  assert.equal(s.recent.length, 2);
  assert.equal(s.recent[0].id, "a");
  assert.equal(s.recent[0].name, "A2");
});
await t("rememberSpace 上限为 MAX_RECENT", () => {
  let s = { companyFrom: "", token: "", endpoint: "", activeSpaceId: "", recent: [] };
  for (let i = 0; i < MAX_RECENT + 5; i++) s = rememberSpace(s, { id: `k${i}`, name: `K${i}` });
  assert.equal(s.recent.length, MAX_RECENT);
});

console.log("\n=== settings ===");
await t("未配置时 getSettings.configured 为 false", () => {
  const svc = freshService();
  assert.equal(svc.getSettings().data.configured, false);
});
await t("saveSettings 持久化并标记 configured", () => {
  const svc = freshService();
  const r = svc.saveSettings({ companyFrom: "cf1", token: "tk1" });
  assert.equal(r.ok, true);
  assert.equal(r.data.configured, true);
  assert.equal(loadState(tmpFile).companyFrom, "cf1");
});
await t("saveSettings 不回传明文 token", () => {
  const svc = freshService();
  const r = svc.saveSettings({ companyFrom: "cf", token: "lxmcp_supersecret_abcdefghij" });
  assert.ok(!JSON.stringify(r).includes("supersecret"));
});
await t("clearSettings 清空", () => {
  const svc = freshService();
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  svc.clearSettings();
  assert.equal(svc.getSettings().data.configured, false);
});

console.log("\n=== 未配置时的门禁 ===");
await t("未配置调用 listSpaces 返回 NO_CREDENTIALS", async () => {
  const svc = freshService();
  const r = await svc.listSpaces({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, LX_ERR.NO_CREDENTIALS);
});

console.log("\n=== 业务方法（mock fetch）===");
await t("testConnection 返回身份信息", async () => {
  const f = routedFetch({
    whoami: () => ({ code: 0, data: { staff: { display_name: "Alice", id: "s1" }, company: { name: "ACME", code: "cf" } } }),
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.testConnection();
  assert.equal(r.ok, true);
  assert.equal(r.data.staffName, "Alice");
  assert.equal(r.data.companyName, "ACME");
});
await t("testConnection 401 时返回 AUTH", async () => {
  const f = async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => "no" });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "bad" });
  const r = await svc.testConnection();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, LX_ERR.AUTH);
});
await t("listTeams 映射字段", async () => {
  const f = routedFetch({ team_list_teams: () => ({ code: 0, data: { teams: [{ id: "t1", name: "团队A", code: "k1" }] } }) });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.listTeams();
  assert.equal(r.data.teams[0].name, "团队A");
});
await t("listChildren 映射并暴露 hasChildren", async () => {
  const f = routedFetch({
    entry_list_children: () => ({
      code: 0,
      data: { entries: [{ id: "e1", name: "页", entry_type: "page", has_children: false }, { id: "f1", name: "夹", entry_type: "folder", has_children: true }] },
    }),
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.listChildren({ parentId: "root" });
  assert.equal(r.data.entries.length, 2);
  assert.equal(r.data.entries[1].hasChildren, true);
});
await t("listChildren 缺 parentId 报错", async () => {
  const svc = freshService(routedFetch({}));
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.listChildren({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, LX_ERR.PROTOCOL);
});
await t("search keyword 模式解析 docs", async () => {
  const f = routedFetch({
    search_kb_search: () => ({ code: 0, data: { total: 30, docs: [{ id: "d1", title: "T", content: "正文片段" }] } }),
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.search({ query: "桥梁", mode: "keyword" });
  assert.equal(r.ok, true);
  assert.equal(r.data.total, 30);
  assert.equal(r.data.hits[0].snippet, "正文片段");
});
await t("search semantic 模式用 filters.keyword", async () => {
  let seen = null;
  const f = routedFetch({
    search_kb_embedding_search: (body) => {
      seen = body.params.arguments.arguments;
      return { code: 0, data: { docs: [{ id: "x", title: "Y", content: "c", score: 1.5 }] } };
    },
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.search({ query: "函数", mode: "semantic", spaceId: "sp" });
  assert.equal(r.ok, true);
  assert.equal(seen.filters.keyword, "函数");
  assert.equal(seen.space_id, "sp");
  assert.equal(r.data.hits[0].score, 1.5);
});
await t("search 空 query 报错", async () => {
  const svc = freshService(routedFetch({}));
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.search({ query: "  " });
  assert.equal(r.ok, false);
});
await t("createEntry 建页面", async () => {
  let seen = null;
  const f = routedFetch({
    entry_create_entry: (body) => {
      seen = body.params.arguments.arguments;
      return { code: 0, data: { entry: { id: "new1", name: "新页", entry_type: "page" } } };
    },
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.createEntry({ parentId: "p", name: "新页" });
  assert.equal(r.data.id, "new1");
  assert.equal(seen.entry_type, "page");
  assert.equal(seen.parent_entry_id, "p");
});
await t("removeEntry 用 force_expire", async () => {
  let seen = null;
  const f = routedFetch({
    entry_set_entry_validity: (body) => {
      seen = body.params.arguments.arguments;
      return { code: 0, data: {} };
    },
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.removeEntry({ entryId: "e9" });
  assert.equal(r.data.removed, true);
  assert.equal(seen.validity_type, "force_expire");
});
await t("renameEntry 传 entry_id + name", async () => {
  let seen = null;
  const f = routedFetch({
    entry_rename_entry: (body) => { seen = body.params.arguments.arguments; return { code: 0, data: {} }; },
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.renameEntry({ entryId: "e1", name: "改名" });
  assert.equal(r.data.name, "改名");
  assert.equal(seen.entry_id, "e1");
});

console.log("\n=== 三步上传 ===");
await t("uploadFile 走 apply -> PUT -> commit", async () => {
  const f = routedFetch({
    file_apply_upload: () => ({ code: 0, data: { session: { session_id: "S1", upload_url: "https://cos.example/put" } } }),
    file_commit_upload: () => ({ code: 0, data: { entry: { id: "file1", name: "a.pdf" } } }),
    put: () => ({ status: 200 }),
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.uploadFile({ parentId: "p", fileName: "a.pdf", contentBase64: Buffer.from("hello").toString("base64") });
  assert.equal(r.ok, true);
  assert.equal(r.data.id, "file1");
  const putCall = f.calls.find((c) => c.method === "PUT");
  assert.ok(putCall, "应当发出 PUT 请求");
  assert.equal(putCall.url, "https://cos.example/put");
});
await t("uploadFile PUT 失败时报 NETWORK", async () => {
  const f = routedFetch({
    file_apply_upload: () => ({ code: 0, data: { session: { session_id: "S1", upload_url: "https://cos.example/put" } } }),
    put: () => ({ status: 403 }),
  });
  const svc = freshService(f);
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.uploadFile({ parentId: "p", fileName: "a.pdf", contentBase64: "aGk=" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, LX_ERR.NETWORK);
});
await t("uploadFile 缺 fileName 报错", async () => {
  const svc = freshService(routedFetch({}));
  svc.saveSettings({ companyFrom: "cf", token: "tk" });
  const r = await svc.uploadFile({ parentId: "p", contentBase64: "aGk=" });
  assert.equal(r.ok, false);
});

console.log("\n=== MANIFEST 契约 ===");
await t("invocations 与实现方法一一对应", () => {
  const svc = freshService();
  for (const inv of MANIFEST.invocations) {
    assert.equal(typeof svc[inv], "function", `缺少实现: ${inv}`);
  }
});
await t("每个 invocation 都有对应 schema", () => {
  for (const inv of MANIFEST.invocations) {
    assert.ok(MANIFEST.schemas[inv], `缺少 schema: ${inv}`);
  }
});
await t("所有 codec 都有 create 工厂（loader 强制要求）", () => {
  for (const [k, v] of Object.entries(MANIFEST.schemas)) {
    assert.equal(typeof v.create, "function", `${k} 缺少 create`);
    assert.ok(v.create() && typeof v.create().parse === "function", `${k} 的 create() 需返回可 parse 的对象`);
  }
});
await t("face 为 host 且不含保留方法名", () => {
  assert.equal(MANIFEST.face, "host");
  const reserved = ["install", "installDirect", "installScoped", "remove", "has", "methods", "empty", "name", "namespace", "ctx", "constructor"];
  for (const inv of MANIFEST.invocations) {
    assert.ok(!reserved.includes(inv), `invocation 撞上保留名: ${inv}`);
  }
});

try { fs.unlinkSync(tmpFile); } catch {}
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
