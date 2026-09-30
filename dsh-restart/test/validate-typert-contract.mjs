/**
 * dsh-restart —— typert codec 契约测试（host 半 + client 半）。
 *
 * 为什么必须有这个测试：
 *   DSH 的 typert 注册表在 register() 时会逐个校验 codec，规则是
 *     function validateCodec(codec, subject) {
 *       if (codec.mode === "src-json") return;
 *       validateNonempty(`${subject} type symbol`, codec.typeSymbol);
 *       if (typeof codec.create !== "function")
 *         throw new Error(`typert: ${subject} strict codec has no create() factory`);
 *     }
 *   运行期再按 `codec.create().parse(value)` 解析线格式（见 decode()）。
 *   生成器产出的 codec 形状是
 *     { mode: "strict", typeSymbol: "...", create: () => z.object({ ... }) }
 *
 *   事故记录（来自师兄插件 dsh-plugin-url）：插件曾把 codec 写成
 *   `{ mode, typeSymbol, schema }`（没有 create）。结果是 host 项激活失败：
 *     「启用失败 … 1 entry did not activate …」
 *   因为注册 MANIFEST 时 validateCodec 直接抛错，整个功能一起消失。
 *   `node --check` 与 test/load-client.mjs 都兜不住 —— 前者只看语法，
 *   后者用假 ctx 挂载，不经过注册表的 codec 校验。
 *
 *   host 半（lib/index.js）顶层就 import 了 `zod` 与
 *   `@deepseek-ai/dsh-typert-protocol`，这两个包只在 DSH 应用内存在，纯 Node
 *   下无法直接 import。本测试的做法是：把**字节相同**的真实源码复制进一个
 *   临时目录，再给它配一份最小依赖树（zod / protocol 的桩），于是真实模块体
 *   能被 import，而 MANIFEST 仍是插件里那一份，没有第二个副本可以漂移。
 *
 *   与师兄插件的差别：dsh-restart 的 lib/index.js **没有同目录 import**，
 *   所以桩目录里只复制 index.js 一个文件就够（少一个 import，这里就少一个坑）。
 *
 * 本测试**不自己写一份宽松的假校验**，而是从已安装的 DSH（app.asar）里
 * 抠出真实的 validateInvocation / requireStrictCodec 源码，拿插件真实的
 * MANIFEST 与 CONTRIBUTION 去过一遍。DSH 升级后契约若变化，测试会跟着失败。
 *
 * 刻意**不执行** restart()（那会真的把自己杀掉）：只断言它的线名、codec 与
 * 纯函数（detect / buildHelperScript）的返回结构。
 *
 * 用法：
 *   node test/validate-typert-contract.mjs
 *   DSH_APP_ASAR=D:/path/to/app.asar node test/validate-typert-contract.mjs
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const asarPath = process.env.DSH_APP_ASAR ?? "E:/dsh/resources/app.asar";

/** 本插件的线面约定：包名 / 命名空间 / 恰好两个无参方法。 */
const PACKAGE_NAME = "dsh-restart";
const NAMESPACE = "appRestart";
const EXPECTED_METHODS = ["restart", "restartSupport"];

const failures = [];
let total = 0;
function record(ok, label, detail) {
	total += 1;
	console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail === undefined ? "" : " -> " + detail));
	if (!ok) failures.push(label + (detail === undefined ? "" : ": " + detail));
}
function check(label, fn) {
	try {
		fn();
		record(true, label);
	} catch (err) {
		record(false, label, err?.message ?? String(err));
	}
}

// ── 1. 从已安装的 DSH 抠出真实校验源码 ───────────────────────────────────

console.log("asar: " + asarPath);

let asarText;
try {
	asarText = readFileSync(asarPath).toString("latin1");
} catch (err) {
	console.log("\n无法读取 app.asar（" + (err?.message ?? err) + "）。");
	console.log("请用 DSH_APP_ASAR=<app.asar 路径> 指向已安装的 DSH。");
	process.exit(2);
}

/** 截取一段顶层函数源码（到下一个标记或注释块为止）。 */
function sliceFunction(text, signature, stopBefore) {
	const start = text.indexOf(signature);
	if (start < 0) throw new Error(`在 app.asar 里找不到 "${signature}" —— DSH 版本可能已变化`);
	const stop = text.indexOf(stopBefore, start);
	if (stop < 0) throw new Error(`在 app.asar 里找不到 "${stopBefore}"（${signature} 的结尾标记）`);
	return text.slice(start, stop);
}

// validateInvocation 的切片必须一路带上它依赖的 validateCodec / validateWireName /
// validateSegment / validateNonempty（它们就紧跟在这个函数后面），否则 new Function
// 建出来的函数一调用就是 "validateNonempty is not defined"。
const invocationSource = sliceFunction(asarText, "function validateInvocation(descriptor)", "//#region lib/types/client/index.js");
const strictCodecSource = sliceFunction(asarText, "function requireStrictCodec(pkgName, value, subject)", "\n/**");

/** loader 侧 requireStrictCodec 依赖的两个断言助手（源码里是同模块自由变量）。 */
function requireObject(pkgName, value, subject) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`typert-loader: ${pkgName} ${subject} must be an object`);
	return value;
}
function requireString(pkgName, value, key, subject) {
	const field = value?.[key];
	if (typeof field !== "string" || field.length === 0) throw new Error(`typert-loader: ${pkgName} ${subject}.${key} must be a nonempty string`);
	return field;
}

const validateInvocation = new Function(`${invocationSource}\nreturn validateInvocation;`)();
const requireStrictCodec = new Function("requireObject", "requireString", `${strictCodecSource}\nreturn requireStrictCodec;`)(requireObject, requireString);

// 先证明抠出来的校验器真的会拒绝旧形状，否则后面的 PASS 全是假绿。
check("抽取到的校验器已生效（旧形状 { schema } 必须被拒）", () => {
	const broken = { id: "x#y/restart", service: "y", namespace: "y", method: "restart", invocation: { kind: "direct" }, parameters: [], result: { mode: "strict", typeSymbol: "x#T", schema: {} } };
	let message;
	try {
		validateInvocation(broken);
	} catch (err) {
		message = err?.message ?? "";
	}
	if (message === undefined) throw new Error("validateInvocation 接受了缺少 create() 的 codec");
	if (!message.includes("has no create() factory")) throw new Error("报错文案不符：" + message);
});

/** 对单个 codec 跑 loader 规则 + 运行期 decode() 的调用方式。 */
function checkCodec(codec, subject) {
	requireStrictCodec(PACKAGE_NAME, codec, subject);
	if (typeof codec.create !== "function") throw new Error(`${subject} 缺少 create()`);
	const created = codec.create();
	if (typeof created?.parse !== "function") throw new Error(`${subject} 的 create() 没返回带 parse() 的 schema`);
}

// 再证明 codec 校验器本身不是空转：缺 create() 的 codec 必须被拒。
check("codec 校验器不是空转（缺 create() 必须被拒）", () => {
	let message;
	try {
		checkCodec({ mode: "strict", typeSymbol: "dsh-restart#T" }, "合成 codec");
	} catch (err) {
		message = err?.message ?? "";
	}
	if (message === undefined) throw new Error("checkCodec 放过了没有 create() 的 codec");
	if (!message.includes("create()")) throw new Error("报错文案不符：" + message);
});

// ── 1.5 远程方法名不能撞客户端 namespace service ──────────────────────────
//
// 客户端 api 的 RemoteNamespaceService 原型上有 install()/remove()/has() 等，
// 它的 assertMethodAvailable 会抛：
//   client api: method "appRestart/install" conflicts with its namespace service
// 所以从 app.asar 里把「原型成员 + REMOTE_NAMESPACE_FIELDS」抠出来做校验。

const RESERVED_FALLBACK = new Set([
	"assertMethodAvailable", "constructor", "empty", "has", "install",
	"installDirect", "installScoped", "methods", "remove",
	"ctx", "invokeRemote", "name", "namespace",
]);

function extractReservedMethodNames(text) {
	const reserved = new Set(RESERVED_FALLBACK);
	const classAt = text.indexOf("var RemoteNamespaceService = class");
	if (classAt >= 0) {
		const body = text.slice(classAt, classAt + 20000);
		for (const m of body.matchAll(/^\s{3}(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) reserved.add(m[1]);
		for (const m of body.matchAll(/^\s{3}([A-Za-z_$][\w$]*)\s*=/gm)) reserved.add(m[1]);
	}
	const setAt = text.indexOf("const REMOTE_NAMESPACE_FIELDS = new Set([");
	if (setAt >= 0) {
		const literal = text.slice(setAt, text.indexOf("]);", setAt));
		for (const m of literal.matchAll(/"([A-Za-z_$][\w$]*)"/g)) reserved.add(m[1]);
	}
	return reserved;
}

const reservedMethodNames = extractReservedMethodNames(asarText);

check("抽取到的禁用方法名集合是完整的（install / remove / methods 必须在列）", () => {
	for (const name of ["install", "remove", "methods", "namespace"]) {
		if (!reservedMethodNames.has(name)) throw new Error(`缺少 ${name} —— 抽取逻辑失效`);
	}
});

check("禁用方法名集合确实会拦住 install / remove 这类线名，但不会误伤本插件的 restart", () => {
	if (!reservedMethodNames.has("install")) throw new Error("install 不在禁用集合里，守卫就不是必需的");
	if (!reservedMethodNames.has("remove")) throw new Error("remove 不在禁用集合里");
	if (reservedMethodNames.has("restart")) throw new Error("restart 被误判为禁用名");
	if (reservedMethodNames.has("restartSupport")) throw new Error("restartSupport 被误判为禁用名");
});

/** 方法名守卫：命中 RemoteNamespaceService 原型/字段即视为会挂载失败。 */
function assertMethodAllowed(descriptor) {
	if (reservedMethodNames.has(descriptor.method)) {
		throw new Error(`method "${descriptor.namespace}/${descriptor.method}" 会抛 conflicts with its namespace service`);
	}
}

check("方法名守卫不是空转（合成 method: install 必须被判违规）", () => {
	let message;
	try {
		assertMethodAllowed({ namespace: NAMESPACE, method: "install" });
	} catch (err) {
		message = err?.message ?? "";
	}
	if (message === undefined) throw new Error("守卫放过了 method: install");
	if (!message.includes("conflicts with its namespace service")) throw new Error("报错文案不符：" + message);
});

/**
 * 线名比对：返回错误说明，或 null 表示一致。
 * 单独抽出来是为了能对**比对本身**做非空转守卫（下面的合成用例）。
 */
function compareMethods(actual, expected) {
	if (!Array.isArray(actual)) return "线名不是数组：" + JSON.stringify(actual);
	const sorted = [...actual].sort();
	if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
		return "线名 = " + JSON.stringify(sorted) + "，期望 " + JSON.stringify(expected);
	}
	return null;
}

check("线名比对不是空转（少一个 / 多一个都必须被判为不一致）", () => {
	if (compareMethods([...EXPECTED_METHODS], EXPECTED_METHODS) !== null) throw new Error("一致的清单被误判");
	if (compareMethods(["restart"], EXPECTED_METHODS) === null) throw new Error("少一个方法却判定一致");
	if (compareMethods([...EXPECTED_METHODS, "installPlugin"], EXPECTED_METHODS) === null) throw new Error("多一个方法却判定一致");
	if (compareMethods([], EXPECTED_METHODS) === null) throw new Error("空清单却判定一致");
});

// ── 2. host 半：真实 MANIFEST 过注册表校验 ───────────────────────────────

console.log("\n[1] host 半（lib/index.js）");

const ZOD_STUB = `
const identity = (value) => value;
function makeSchema(kind, extra) {
  const schema = { kind, parse: identity, optional: () => schema, readonly: () => schema, nullable: () => schema };
  if (extra !== undefined) Object.assign(schema, extra);
  return schema;
}
export const z = {
  string: () => makeSchema("string"),
  number: () => makeSchema("number"),
  boolean: () => makeSchema("boolean"),
  array: (item) => makeSchema("array", { item }),
  object: (shape) => makeSchema("object", { shape }),
};
`;

// 桩同时记录 super(ctx, key) 里的 key，用来验证服务键与 MANIFEST.namespace 一致。
const PROTOCOL_STUB = `
export class TypertRemoteService {
  constructor(ctx, key) { this.ctx = ctx; this.key = key; }
}
`;

let tmpRoot;
let manifest;
let hostModule;
let gateway;

async function loadHostManifest() {
	tmpRoot = await mkdtemp(join(tmpdir(), "dsh-restart-contract-"));
	await writeFile(join(tmpRoot, "package.json"), '{ "type": "module" }\n');
	// 复制真实源码（字节相同），只为给它配一份最小依赖树。
	// dsh-restart 的 index.js 顶层只 import 了 zod / @deepseek-ai/dsh-typert-protocol
	// 与 node: 内置模块，**没有同目录 import**，所以这里只需复制一个文件。
	// 以后 index.js 若新增同目录 import，这里也要跟着加，否则会以
	// "Cannot find module '.../xxx.js'" 的形式整片报红。
	await copyFile(join(pluginRoot, "lib", "index.js"), join(tmpRoot, "index.js"));

	const zodDir = join(tmpRoot, "node_modules", "zod");
	const protocolDir = join(tmpRoot, "node_modules", "@deepseek-ai", "dsh-typert-protocol");
	await mkdir(zodDir, { recursive: true });
	await mkdir(protocolDir, { recursive: true });
	await writeFile(join(zodDir, "package.json"), '{ "name": "zod", "type": "module", "main": "index.js" }\n');
	await writeFile(join(zodDir, "index.js"), ZOD_STUB);
	await writeFile(join(protocolDir, "package.json"), '{ "name": "@deepseek-ai/dsh-typert-protocol", "type": "module", "main": "index.js" }\n');
	await writeFile(join(protocolDir, "index.js"), PROTOCOL_STUB);

	hostModule = await import(pathToFileURL(join(tmpRoot, "index.js")).href);
	const ctx = {
		effect: (fn) => {
			fn();
			return () => {};
		},
		typert: {
			register: (value) => {
				manifest = value;
			},
		},
		get: () => undefined,
	};
	gateway = hostModule.apply(ctx);
}

let hostError;
try {
	await loadHostManifest();
} catch (err) {
	hostError = err;
}
record(hostError === undefined, "lib/index.js 可加载并注册 MANIFEST", hostError?.message);

check("MANIFEST 已交给 ctx.typert.register", () => {
	if (manifest === undefined) throw new Error("register 未被调用");
	if (manifest.package !== PACKAGE_NAME) throw new Error("package = " + manifest.package);
	if (manifest.face !== "host") throw new Error("face = " + manifest.face);
});

check("host 半注入恰好是 [typert]（不再需要 pluginManager）", () => {
	if (!Array.isArray(hostModule?.inject)) throw new Error("inject 不是数组");
	if (!hostModule.inject.includes("typert")) throw new Error("缺少 typert");
	if (JSON.stringify(hostModule.inject) !== JSON.stringify(["typert"])) throw new Error("inject = " + JSON.stringify(hostModule.inject));
	if (hostModule.inject.includes("pluginManager")) throw new Error("还挂着用不到的 pluginManager");
});

check("MANIFEST.schemas 每项都按 loader 规则校验", () => {
	if (!Array.isArray(manifest.schemas)) throw new Error("schemas 不是数组");
	for (const schema of manifest.schemas) requireStrictCodec(PACKAGE_NAME, schema, `schema "${schema.name}"`);
});

check("每条 invocation 都过注册表 validateInvocation", () => {
	if (!Array.isArray(manifest.invocations) || manifest.invocations.length === 0) throw new Error("invocations 为空");
	for (const invocation of manifest.invocations) validateInvocation(invocation);
});

check("每条 invocation 的 result / parameter codec 都能 create()", () => {
	for (const invocation of manifest.invocations) {
		checkCodec(invocation.result, `${invocation.id} result`);
		for (const parameter of invocation.parameters) checkCodec(parameter.codec, `${invocation.id} parameter ${parameter.name}`);
	}
});

check("远程方法名不撞 RemoteNamespaceService 原型（host 半）", () => {
	for (const invocation of manifest.invocations) assertMethodAllowed(invocation);
});

check("host 线名恰好是 [restart, restartSupport] 且命名空间是 appRestart", () => {
	const problem = compareMethods(manifest.invocations.map((value) => value.method), EXPECTED_METHODS);
	if (problem !== null) throw new Error(problem);
	if (manifest.invocations.length !== EXPECTED_METHODS.length) throw new Error("invocation 条数 = " + manifest.invocations.length);
	for (const invocation of manifest.invocations) {
		if (invocation.namespace !== NAMESPACE) throw new Error(`${invocation.id} 的 namespace = ${invocation.namespace}`);
		if (invocation.service !== NAMESPACE) throw new Error(`${invocation.id} 的 service = ${invocation.service}`);
		if (invocation.id !== `${PACKAGE_NAME}#${NAMESPACE}/${invocation.method}`) throw new Error("id 与 namespace/method 对不上：" + invocation.id);
	}
});

check("两个方法都是无参的（restartSupport() / restart()）", () => {
	for (const invocation of manifest.invocations) {
		if (!Array.isArray(invocation.parameters)) throw new Error(invocation.id + " 的 parameters 不是数组");
		if (invocation.parameters.length !== 0) throw new Error(invocation.id + " 竟然带了 " + invocation.parameters.length + " 个参数");
		if (invocation.invocation?.kind !== "direct") throw new Error(invocation.id + " 的 invocation.kind = " + invocation.invocation?.kind);
	}
});

check("host 的 result schema 覆盖界面要读的字段（supported / reason / started / helper…）", () => {
	const byMethod = new Map(manifest.invocations.map((value) => [value.method, value]));
	const support = byMethod.get("restartSupport")?.result?.create();
	const restart = byMethod.get("restart")?.result?.create();
	// 界面按 support.supported / support.reason 决定禁用与提示，缺一个就是点了没反应。
	for (const key of ["supported", "reason", "exe", "mode", "parentPid", "selfPid"]) {
		if (support?.shape?.[key] === undefined) throw new Error("restartSupport 的 schema 缺 " + key);
	}
	for (const key of ["started", "exe", "helper", "parentPid", "selfPid"]) {
		if (restart?.shape?.[key] === undefined) throw new Error("restart 的 schema 缺 " + key);
	}
});

check("codec.create() 返回的 schema 真的参与解析（decode 的用法）", () => {
	const invocation = manifest.invocations.find((value) => value.method === "restartSupport");
	const value = invocation.result.create().parse({ supported: false, reason: "x" });
	if (value === undefined || value === null) throw new Error("parse() 返回空");
});

check("apply() 返回的网关服务键与 MANIFEST.namespace 一致，且两个方法都在", () => {
	if (gateway === undefined) throw new Error("apply() 没有返回网关");
	if (gateway.key !== NAMESPACE) throw new Error("服务键 = " + gateway.key);
	for (const invocation of manifest.invocations) {
		if (typeof gateway[invocation.method] !== "function") throw new Error("网关上没有 " + invocation.method + "()");
	}
});

check("MANIFEST.model 结构完整", () => {
	for (const key of ["services", "events", "objects"]) if (!Array.isArray(manifest.model?.[key])) throw new Error(`model.${key} 不是数组`);
});

// ── 2.5 纯函数：detect / buildHelperScript 的返回结构 ─────────────────────
//
// 刻意只测结构，不测行为（行为在 test/host.test.mjs 里钉）。
// 尤其**不会**调 restart() —— 跑一遍就等于把自己重启了。

check("detect() 返回界面契约要求的字段类型", () => {
	if (typeof hostModule.detect !== "function") throw new Error("没有导出 detect");
	const info = hostModule.detect();
	if (typeof info?.supported !== "boolean") throw new Error("supported 不是 boolean：" + typeof info?.supported);
	if (typeof info?.reason !== "string") throw new Error("reason 不是 string");
	if (typeof info?.exe !== "string") throw new Error("exe 不是 string");
	if (typeof info?.mode !== "string") throw new Error("mode 不是 string");
	if (typeof info?.parentPid !== "number") throw new Error("parentPid 不是 number");
	if (typeof info?.selfPid !== "number") throw new Error("selfPid 不是 number");
	if (info.supported === false && info.reason.length === 0) throw new Error("说不支持却不给 reason，界面只能给个灰按钮");
});

check("buildHelperScript(info, port) 返回可写的 cmd 文本（只断言结构）", () => {
	if (typeof hostModule.buildHelperScript !== "function") throw new Error("没有导出 buildHelperScript");
	const script = hostModule.buildHelperScript({ supported: true, reason: "", exe: "E:\\dsh\\DeepSeek Harness.exe", mode: "desktop", parentPid: 27400, selfPid: 15044 }, "19387");
	if (typeof script !== "string" || script.length === 0) throw new Error("返回值不是非空字符串");
	if (!script.includes("\r\n")) throw new Error("没有用 CRLF（cmd 的脾气）");
	if (!script.includes('set "SELF=15044"') || !script.includes('set "PARENT=27400"')) throw new Error("没有把 PID 写进变量");
	if (!script.includes("port=19387")) throw new Error("日志里没有端口");
});

check("MANIFEST 里没有 restart 之外的危险动作（只有直接调用，没有 stream / uplink）", () => {
	for (const invocation of manifest.invocations) {
		if (invocation.mode !== undefined) throw new Error(invocation.id + " 声明了 mode = " + invocation.mode);
		if (invocation.uplink !== undefined) throw new Error(invocation.id + " 声明了 uplink");
		if (invocation.scope !== undefined) throw new Error(invocation.id + " 声明了 scope");
	}
});

// ── 3. client 半：真实 CONTRIBUTION 的 codec ─────────────────────────────

console.log("\n[2] client 半（lib/client.js）");

let contribution;

function makeReact() {
	return {
		useState: (init) => [init, () => {}],
		useCallback: (fn) => fn,
		useEffect: () => {},
		useMemo: (fn) => fn(),
		createElement: (type, props, ...kids) => ({ type, props, children: kids }),
	};
}
function makeJsxRuntime() {
	const jsx = (type, props) => ({ type, props: props ?? {}, children: (props ?? {}).children });
	return { jsx, jsxs: jsx, Fragment: Symbol.for("react.fragment") };
}

async function loadClientContribution() {
	let entry;
	globalThis.window = {
		__ModuleLoader__: {
			load(value) {
				entry = value;
			},
		},
	};
	globalThis.document = {
		getElementById: () => null,
		createElement: () => ({ set textContent(v) {}, id: "" }),
		head: { appendChild() {} },
	};
	await import(pathToFileURL(join(pluginRoot, "lib", "client.js")).href);
	if (entry === undefined) throw new Error("client bundle 未注册到 __ModuleLoader__");

	const mod = entry.factory((spec) => {
		if (spec === "react") return makeReact();
		if (spec === "react/jsx-runtime") return makeJsxRuntime();
		throw new Error("意料之外的 require：" + spec);
	});

	const ctx = {
		effect: (fn) => {
			fn();
			return () => {};
		},
		locale: { register: () => {}, bind: () => (key) => key },
		remote: {
			$mount: (value) => {
				contribution = value;
				return Promise.resolve();
			},
		},
		// client 半**不**注入 sessions（新版没有会话 id 需求）；这里故意不给。
		get: () => undefined,
		slots: { inject: (name, fn) => fn(), register: () => {} },
	};
	mod.apply(ctx);
}

let clientError;
try {
	await loadClientContribution();
} catch (err) {
	clientError = err;
}
record(clientError === undefined, "lib/client.js 可加载并挂载贡献", clientError?.message);

check("client 半挂载了 CONTRIBUTION", () => {
	if (contribution === undefined) throw new Error("$mount 未被调用");
	if (contribution.package !== PACKAGE_NAME) throw new Error("package = " + contribution.package);
});

check("client 描述符的 codec 同样满足 strict + create()", () => {
	if (!Array.isArray(contribution?.descriptors) || contribution.descriptors.length === 0) throw new Error("descriptors 为空");
	for (const descriptor of contribution.descriptors) {
		checkCodec(descriptor.result, `${descriptor.id} result`);
		for (const parameter of descriptor.parameters) checkCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`);
	}
});

check("client 描述符也过注册表 validateInvocation", () => {
	for (const descriptor of contribution.descriptors) validateInvocation(descriptor);
});

check("远程方法名不撞 RemoteNamespaceService 原型（client 半）", () => {
	for (const descriptor of contribution.descriptors) assertMethodAllowed(descriptor);
});

check("client 线名恰好是 [restart, restartSupport] 且命名空间是 appRestart", () => {
	const problem = compareMethods(contribution.descriptors.map((value) => value.method), EXPECTED_METHODS);
	if (problem !== null) throw new Error(problem);
	if (contribution.descriptors.length !== EXPECTED_METHODS.length) throw new Error("描述符条数 = " + contribution.descriptors.length);
	for (const descriptor of contribution.descriptors) {
		if (descriptor.namespace !== NAMESPACE) throw new Error(`${descriptor.id} 的 namespace = ${descriptor.namespace}`);
	}
});

/** 把一端的描述符压成可比对的签名（id + service + namespace + method + 参数线名 + kind）。 */
function signatureOf(list) {
	return list
		.map((value) => [
			value.id,
			value.service,
			value.namespace,
			value.method,
			value.invocation?.kind,
			value.parameters.map((parameter) => `${parameter.name}=${parameter.wire ?? ""}`).join(","),
		].join("|"))
		.sort();
}

check("host / client 两半的线名与描述符完全一致（不会各说各话）", () => {
	const hostSignatures = signatureOf(manifest.invocations);
	const clientSignatures = signatureOf(contribution.descriptors);
	// 空 == 空 会假绿，所以先钉住两端都必须有两条。
	if (hostSignatures.length !== EXPECTED_METHODS.length || clientSignatures.length !== EXPECTED_METHODS.length) {
		throw new Error("描述符条数不对：host = " + hostSignatures.length + " / client = " + clientSignatures.length);
	}
	if (JSON.stringify(hostSignatures) !== JSON.stringify(clientSignatures)) {
		throw new Error("host = " + JSON.stringify(hostSignatures) + " / client = " + JSON.stringify(clientSignatures));
	}
});

// ── 4. 汇总 ─────────────────────────────────────────────────────────────

if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
	console.log("全部通过（" + total + " 条断言）：MANIFEST / CONTRIBUTION 满足当前 DSH 的 typert codec 契约。");
	process.exit(0);
}
console.log(failures.length + " / " + total + " 项失败：");
for (const failure of failures) console.log("  - " + failure);
process.exit(1);
