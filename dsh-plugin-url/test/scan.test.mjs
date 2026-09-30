/**
 * scan.js 回归测试：仓库树里「是不是插件包」的判定。
 *
 * 判定标准只有一条 —— package.json 声明了 dsh.bundle.patch。这正是 DSH 插件管理器
 * bundleManifest 的门槛，所以这里识别出来的集合，和真正能装上的集合必须一致。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPluginPackages } from "../lib/scan.js";

let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + label);
  } else {
    fail += 1;
    console.log("  FAIL  " + label + (detail === undefined ? "" : "  -> " + detail));
  }
}

const root = await mkdtemp(join(tmpdir(), "dsh-plugin-url-scan-"));
async function put(rel, body) {
  const file = join(root, rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, body, "utf8");
}
const pluginManifest = (name, extra = {}) =>
  JSON.stringify({ name, version: "1.0.0", description: `${name} desc`, dsh: { bundle: { patch: "./cordis.patch.yml" } }, ...extra });

try {
  console.log("\n[1] 识别集合");
  await put("good/package.json", pluginManifest("dsh-good", { main: "lib/index.js" }));
  await put("good/lib/index.js", "export const x = 1;\n");
  await put("good/cordis.patch.yml", "- []\n");
  await put("needsbuild/package.json", pluginManifest("dsh-needsbuild", { scripts: { prepare: "tsc -b" } }));
  await put("needsbuild/cordis.patch.yml", "- []\n");
  await put("noentry/package.json", pluginManifest("dsh-noentry", { main: "dist/index.js" }));
  await put("noentry/cordis.patch.yml", "- []\n");
  await put("plain/package.json", JSON.stringify({ name: "totally-not-a-plugin", version: "9.9.9" }));
  await put("deep/a/b/plugin/package.json", pluginManifest("dsh-deep", { main: "index.js" }));
  await put("deep/a/b/plugin/index.js", "export {};\n");
  await put("deep/a/b/plugin/cordis.patch.yml", "- []\n");

  const found = await scanPluginPackages(root);
  const names = found.map((p) => p.name);

  check("找到 4 个插件包", found.length === 4, `实际 ${found.length}: ${names.join(",")}`);
  check("普通 npm 包不被识别", !names.includes("totally-not-a-plugin"));
  check("深层嵌套被找到", names.includes("dsh-deep"));

  console.log("\n[2] 必须跳过的目录");
  await put("node_modules/junk/package.json", pluginManifest("dsh-junk"));
  await put("node_modules/junk/cordis.patch.yml", "- []\n");
  await put(".hidden/package.json", pluginManifest("dsh-hidden"));
  await put(".hidden/cordis.patch.yml", "- []\n");
  await put(".git/config/package.json", pluginManifest("dsh-git"));
  await put(".git/config/cordis.patch.yml", "- []\n");
  const found2 = await scanPluginPackages(root);
  const names2 = found2.map((p) => p.name);
  check("node_modules 被跳过", !names2.includes("dsh-junk"));
  check(".hidden 被跳过", !names2.includes("dsh-hidden"));
  check(".git 被跳过", !names2.includes("dsh-git"));
  check("跳过目录不影响正常识别", found2.length === 4, `实际 ${found2.length}`);

  console.log("\n[3] readiness 分类");
  const byName = new Map(found2.map((p) => [p.name, p]));
  check("无脚本 + 入口存在 = ready", byName.get("dsh-good")?.readiness === "ready", byName.get("dsh-good")?.readiness);
  check("有 prepare = needs-build", byName.get("dsh-needsbuild")?.readiness === "needs-build");
  check("needs-build 报出脚本名", JSON.stringify(byName.get("dsh-needsbuild")?.buildScripts) === '["prepare"]');
  check("main 指向不存在的文件 = missing-entry", byName.get("dsh-noentry")?.readiness === "missing-entry");
  check("无 main 但有 index.js = ready", byName.get("dsh-deep")?.readiness === "ready");

  console.log("\n[4] 元信息");
  check("subpath 是相对仓库根的正斜杠路径", byName.get("dsh-deep")?.subpath === "deep/a/b/plugin", byName.get("dsh-deep")?.subpath);
  check("patch 原样保留", byName.get("dsh-good")?.patch === "./cordis.patch.yml");
  check("patchPresent 为 true", byName.get("dsh-good")?.patchPresent === true);
  check("description 被读出", byName.get("dsh-good")?.description === "dsh-good desc");
  check("web 半识别（无 dsh.client = false）", byName.get("dsh-good")?.web === false);

  await put("withweb/package.json", JSON.stringify({ name: "dsh-web", version: "1.0.0", main: "lib/index.js", dsh: { client: { platform: "web" }, bundle: { patch: "./cordis.patch.yml" } } }));
  await put("withweb/lib/index.js", "export {};\n");
  await put("withweb/cordis.patch.yml", "- []\n");
  const found3 = await scanPluginPackages(root);
  check("dsh.client 存在时 web = true", new Map(found3.map((p) => [p.name, p])).get("dsh-web")?.web === true);

  console.log("\n[5] 坏输入不崩");
  await put("broken/package.json", "{ this is not json");
  await put("nobundlepatch/package.json", JSON.stringify({ name: "dsh-nopatch", dsh: { bundle: {} } }));
  await put("noname/package.json", JSON.stringify({ version: "1.0.0", dsh: { bundle: { patch: "./p.yml" } } }));
  const found4 = await scanPluginPackages(root);
  const names4 = found4.map((p) => p.name);
  check("坏 JSON 被忽略", !names4.some((n) => n === undefined));
  check("dsh.bundle 缺 patch 字段被忽略", !names4.includes("dsh-nopatch"));
  check("缺 name 被忽略", names4.every((n) => typeof n === "string" && n.length > 0));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n扫描测试：${pass} 项 PASS，${fail} 项 FAIL。`);
if (fail > 0) process.exitCode = 1;
