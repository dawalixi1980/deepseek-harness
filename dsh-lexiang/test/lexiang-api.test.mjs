/*
 * Offline tests for the Lexiang transport layer (no network).
 * Run: node test/lexiang-api.test.mjs
 */
import assert from "node:assert/strict";
import {
  LexiangClient,
  LexiangError,
  LX_ERR,
  endpointFor,
  decodeBody,
  DEFAULT_ENDPOINT,
} from "../lib/lexiang-api.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
    fail += 1;
  }
}

async function checkAsync(name, fn) {
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

/** Build a fake fetch that records calls and replies with a canned body. */
function fakeFetch(reply, { status = 200, headers = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      status,
      headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
      text: async () => (typeof reply === "function" ? reply(calls.length) : reply),
    };
  };
  impl.calls = calls;
  return impl;
}

console.log("\n=== endpointFor ===");
check("默认端点拼装 preset 与 company_from", () => {
  const u = endpointFor("abc123");
  assert.equal(u, `${DEFAULT_ENDPOINT}?preset=meta&company_from=abc123`);
});
check("company_from 会被 URL 编码", () => {
  assert.ok(endpointFor("a b/c").includes("company_from=a%20b%2Fc"));
});
check("自定义 base 且已带 ? 时用 & 连接", () => {
  assert.ok(endpointFor("x", "https://h/mcp?preset=meta").includes("&company_from=x"));
});

console.log("\n=== decodeBody ===");
check("解析纯 JSON", () => {
  const r = decodeBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.equal(r.result.ok, true);
});
check("解析 SSE（取最后一条 data）", () => {
  const sse = ['event: message', 'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}', ""].join("\n");
  assert.equal(decodeBody(sse).result.a, 1);
});
check("SSE 有多条 data 时取最后一条", () => {
  const sse = 'data: {"n":1}\ndata: {"n":2}\n';
  assert.equal(decodeBody(sse).n, 2);
});
check("空响应抛 PROTOCOL", () => {
  assert.throws(() => decodeBody("   "), (e) => e.code === LX_ERR.PROTOCOL);
});
check("无法解析时抛 PROTOCOL 并带原文", () => {
  try {
    decodeBody("not json at all");
    assert.fail("应当抛错");
  } catch (e) {
    assert.equal(e.code, LX_ERR.PROTOCOL);
    assert.ok(e.detail.includes("not json"));
  }
});

console.log("\n=== 凭证门禁 ===");
await checkAsync("未配置凭证时调用抛 NO_CREDENTIALS", async () => {
  const c = new LexiangClient({ companyFrom: "", token: "" });
  assert.equal(c.configured, false);
  await assert.rejects(() => c.json("whoami", {}), (e) => e.code === LX_ERR.NO_CREDENTIALS);
});
await checkAsync("只有 company_from 仍算未配置", async () => {
  const c = new LexiangClient({ companyFrom: "abc", token: "" });
  assert.equal(c.configured, false);
});
await checkAsync("两者齐全时 configured 为 true", async () => {
  const c = new LexiangClient({ companyFrom: "abc", token: "t" });
  assert.equal(c.configured, true);
});

console.log("\n=== 请求头与会话 ===");
await checkAsync("携带 Bearer 认证头与 company_from", async () => {
  const f = fakeFetch('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"code\\":0,\\"data\\":{\\"staff\\":{\\"display_name\\":\\"X\\"}}}"}]}}');
  const c = new LexiangClient({ companyFrom: "cf", token: "tok", fetchImpl: f });
  const data = await c.whoami();
  assert.equal(data.staff.display_name, "X");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer tok");
  assert.ok(f.calls[0].url.includes("company_from=cf"));
});
await checkAsync("记录服务端返回的 mcp-session-id 并在后续请求携带", async () => {
  const f = fakeFetch(
    (n) =>
      n === 1
        ? '{"jsonrpc":"2.0","id":1,"result":{}}'
        : '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"code\\":0,\\"data\\":{}}"}]}}',
    { headers: { "mcp-session-id": "sess-1" } },
  );
  const c = new LexiangClient({ companyFrom: "cf", token: "tok", fetchImpl: f });
  await c.whoami();
  assert.equal(c.sessionId, "sess-1");
  assert.equal(f.calls[1].init.headers["mcp-session-id"], "sess-1");
});
await checkAsync("initialize 只握手一次", async () => {
  const f = fakeFetch('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"code\\":0,\\"data\\":{}}"}]}}');
  const c = new LexiangClient({ companyFrom: "cf", token: "tok", fetchImpl: f });
  await c.whoami();
  await c.whoami();
  const inits = f.calls.filter((x) => x.body.method === "initialize");
  assert.equal(inits.length, 1);
});

console.log("\n=== 业务工具走 call_tool ===");
await checkAsync("business 工具包装为 call_tool + tool_name", async () => {
  const f = fakeFetch('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"code\\":0,\\"data\\":{\\"entries\\":[]}}"}]}}');
  const c = new LexiangClient({ companyFrom: "cf", token: "tok", fetchImpl: f });
  await c.json("entry_list_children", { parent_id: "p1", limit: 5 });
  const call = f.calls.find((x) => x.body.method === "tools/call");
  assert.equal(call.body.params.name, "call_tool");
  assert.equal(call.body.params.arguments.tool_name, "entry_list_children");
  assert.equal(call.body.params.arguments.arguments.parent_id, "p1");
});

console.log("\n=== 错误映射 ===");
await checkAsync("401 映射为 AUTH 并提示续期", async () => {
  const f = fakeFetch("Unauthorized", { status: 401 });
  const c = new LexiangClient({ companyFrom: "cf", token: "bad", fetchImpl: f });
  await assert.rejects(
    () => c.json("whoami", {}),
    (e) => e.code === LX_ERR.AUTH && e.message.includes("续期"),
  );
});
await checkAsync("上游 code!=0 映射为 UPSTREAM 并保留 message", async () => {
  const f = fakeFetch('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"code\\":51,\\"message\\":\\"team_id: value is required\\"}"}]}}');
  const c = new LexiangClient({ companyFrom: "cf", token: "tok", fetchImpl: f });
  await assert.rejects(
    () => c.json("space_list_spaces", {}),
    (e) => e.code === LX_ERR.UPSTREAM && e.message.includes("team_id"),
  );
});
await checkAsync("fetch 抛错映射为 NETWORK", async () => {
  const c = new LexiangClient({
    companyFrom: "cf",
    token: "tok",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => c.json("whoami", {}),
    (e) => e.code === LX_ERR.NETWORK && e.message.includes("ECONNREFUSED"),
  );
});
await checkAsync("isError 结果抛 UPSTREAM", async () => {
  const f = fakeFetch('{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"boom"}]}}');
  const c = new LexiangClient({ companyFrom: "cf", token: "tok", fetchImpl: f });
  await assert.rejects(() => c.json("whoami", {}), (e) => e.code === LX_ERR.UPSTREAM);
});
check("LexiangError 保留 code 与 detail", () => {
  const e = new LexiangError(LX_ERR.AUTH, "m", "d");
  assert.equal(e.code, LX_ERR.AUTH);
  assert.equal(e.detail, "d");
  assert.ok(e instanceof Error);
});

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
