/**
 * dsh-skill-url —— typert codec 契约测试（host 半 + client 半）。
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
 *   事故记录：插件曾把 codec 写成 `{ mode, typeSymbol, schema }`（没有 create）。
 *   结果是 host 项激活失败：
 *     「启用失败 … 1 entry did not activate skill-url (dsh-skill-url)」
 *   因为注册 MANIFEST 时 validateCodec 直接抛错，连设置页分区一起消失。
 *   `node --check` 与 test/load-client.mjs 都兜不住 —— 前者只看语法，
 *   后者用假 ctx 挂载，不经过注册表的 codec 校验。
 *
 * 本测试**不自己写一份宽松的假校验**，而是从已安装的 DSH（app.asar）里
 * 抠出真实的 validateInvocation / requireStrictCodec 源码，拿插件真实的
 * MANIFEST 与 CONTRIBUTION 去过一遍。DSH 升级后契约若变化，测试会跟着失败。
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
const asarPath = process.env.DSH_APP_ASAR ?? "F:/dsh/resources/app.asar";

const failures = [];
function record(ok, label, detail) {
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
	const broken = { id: "x#y/inspect", service: "y", namespace: "y", method: "inspect", invocation: { kind: "direct" }, parameters: [], result: { mode: "strict", typeSymbol: "x#T", schema: {} } };
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
	requireStrictCodec("dsh-skill-url", codec, subject);
	if (typeof codec.create !== "function") throw new Error(`${subject} 缺少 create()`);
	const created = codec.create();
	if (typeof created?.parse !== "function") throw new Error(`${subject} 的 create() 没返回带 parse() 的 schema`);
}

// ── 1.5 远程方法名不能撞客户端 namespace service ──────────────────────────
//
// 客户端 api 的 RemoteNamespaceService 原型上有 install()/remove()/has() 等，
// 它的 assertMethodAvailable 会抛：
//   client api: method "skillUrl/install" conflicts with its namespace service
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

// ── 2. host 半：真实 MANIFEST 过注册表校验 ───────────────────────────────

console.log("\n[1] host 半（lib/index.js）");

const ZOD_STUB = `
const identity = (value) => value;
function makeSchema() {
  const schema = { parse: identity, optional: () => makeSchema(), readonly: () => schema };
  return schema;
}
export const z = { string: makeSchema, number: makeSchema, boolean: makeSchema, array: makeSchema, object: makeSchema };
`;

const PROTOCOL_STUB = `
export class TypertRemoteService {
  constructor(ctx, key) { this.ctx = ctx; this.key = key; }
}
`;

let tmpRoot;
let manifest;

async function loadHostManifest() {
	tmpRoot = await mkdtemp(join(tmpdir(), "dsh-skill-url-contract-"));
	await writeFile(join(tmpRoot, "package.json"), '{ "type": "module" }\n');
	// 复制真实源码（字节相同），只为给它配一份最小依赖树
	await copyFile(join(pluginRoot, "lib", "index.js"), join(tmpRoot, "index.js"));
	await copyFile(join(pluginRoot, "lib", "discover.js"), join(tmpRoot, "discover.js"));

	const zodDir = join(tmpRoot, "node_modules", "zod");
	const protocolDir = join(tmpRoot, "node_modules", "@deepseek-ai", "dsh-typert-protocol");
	await mkdir(zodDir, { recursive: true });
	await mkdir(protocolDir, { recursive: true });
	await writeFile(join(zodDir, "package.json"), '{ "name": "zod", "type": "module", "main": "index.js" }\n');
	await writeFile(join(zodDir, "index.js"), ZOD_STUB);
	await writeFile(join(protocolDir, "package.json"), '{ "name": "@deepseek-ai/dsh-typert-protocol", "type": "module", "main": "index.js" }\n');
	await writeFile(join(protocolDir, "index.js"), PROTOCOL_STUB);

	const mod = await import(pathToFileURL(join(tmpRoot, "index.js")).href);
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
	mod.apply(ctx);
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
	if (manifest.package !== "dsh-skill-url") throw new Error("package = " + manifest.package);
	if (manifest.face !== "host") throw new Error("face = " + manifest.face);
});

check("MANIFEST.schemas 每项都按 loader 规则校验", () => {
	if (!Array.isArray(manifest.schemas)) throw new Error("schemas 不是数组");
	for (const schema of manifest.schemas) requireStrictCodec("dsh-skill-url", schema, `schema "${schema.name}"`);
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
	for (const invocation of manifest.invocations) {
		if (reservedMethodNames.has(invocation.method)) {
			throw new Error(`method "${invocation.namespace}/${invocation.method}" 会抛 conflicts with its namespace service`);
		}
	}
});

check("codec.create() 返回的 schema 真的参与解析（decode 的用法）", () => {
	const invocation = manifest.invocations.find((value) => value.method === "inspect");
	const value = invocation.result.create().parse({ owner: "a", repo: "b" });
	if (value === undefined || value === null) throw new Error("parse() 返回空");
});

check("MANIFEST.model 结构完整", () => {
	for (const key of ["services", "events", "objects"]) if (!Array.isArray(manifest.model?.[key])) throw new Error(`model.${key} 不是数组`);
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
		get: (name) =>
			name === "sessions" ? { currentProvideInfo: { getSnapshot: () => ({ sessionId: "test-session" }) } } : undefined,
		slots: { inject: (name, fn) => fn(), register: () => {} },
	};
	mod.apply(ctx);
}

await loadClientContribution();

check("client 半挂载了 CONTRIBUTION", () => {
	if (contribution === undefined) throw new Error("$mount 未被调用");
	if (contribution.package !== "dsh-skill-url") throw new Error("package = " + contribution.package);
});

check("client 描述符的 codec 同样满足 strict + create()", () => {
	if (!Array.isArray(contribution.descriptors) || contribution.descriptors.length === 0) throw new Error("descriptors 为空");
	for (const descriptor of contribution.descriptors) {
		checkCodec(descriptor.result, `${descriptor.id} result`);
		for (const parameter of descriptor.parameters) checkCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`);
	}
});

check("client 描述符也过注册表 validateInvocation", () => {
	for (const descriptor of contribution.descriptors) validateInvocation(descriptor);
});

check("远程方法名不撞 RemoteNamespaceService 原型（client 半）", () => {
	for (const descriptor of contribution.descriptors) {
		if (reservedMethodNames.has(descriptor.method)) {
			throw new Error(`method "${descriptor.namespace}/${descriptor.method}" 会抛 conflicts with its namespace service`);
		}
	}
});

// ── 4. 汇总 ─────────────────────────────────────────────────────────────

if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
	console.log("全部通过：MANIFEST / CONTRIBUTION 满足当前 DSH 的 typert codec 契约。");
	process.exit(0);
}
console.log(failures.length + " 项失败：");
for (const failure of failures) console.log("  - " + failure);
process.exit(1);
