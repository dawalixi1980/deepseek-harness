/**
 * dsh-skill-url —— host 半。
 *
 * 一个 Typert Remote 服务（"skillUrl"），暴露：
 *   - inspect(url)：粘贴网址 → 解析 + 下载 + 递归发现，返回技能清单（不落盘）
 *   - listInstalled()：当前已安装技能（含来源仓库标注）
 *   - install(url, subpath)：把指定技能装到 <dsh home>/skills/<name>/
 *   - uninstall(name)：卸载（删除目录或把平铺 md 重命名为 .disabled）
 *
 * 与 dsh-skill-manager 的分工：那个偏"管理已装的技能"，这个专做
 * "从任意网址发现并挑选安装"，交互模型是 URL → 列表 → 勾选。
 */
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  extractArchive,
  fetchArchive,
  inspectArchive,
  makeTempDir,
  parseRepoUrl,
  removeDir,
  scanSkills,
} from "./discover.js";

export const name = "skill-url";
export const inject = ["typert", "skills", "sessions", "agents"];

/** 已安装来源记录文件名。 */
const STATE_FILE = "dsh-skill-url.json";
/** 平铺技能的停用后缀（与 dsh-skill-filesystem 约定一致）。 */
const DISABLED_SUFFIX = ".disabled";
/** 技能名语法（kebab-case）。 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 最多保存多少条仓库网址。 */
const MAX_SAVED_SITES = 12;

/**
 * 把用户输入归一化成一条可保存的记录。
 * 能解析成仓库坐标时存 GitHub 首页（去重更狠），否则原样存文本。
 * @returns {{url: string, label: string, at: number} | undefined}
 */
function savedSiteOf(raw) {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return undefined;
  try {
    const loc = parseRepoUrl(text);
    return { url: `https://github.com/${loc.owner}/${loc.repo}`, label: `${loc.owner}/${loc.repo}`, at: Date.now() };
  } catch {
    return { url: text, label: text, at: Date.now() };
  }
}

function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

function stateFilePath() {
  return join(resolveDshHome(), STATE_FILE);
}

/** 用户技能根（安装落点，watcher 自动发现）。 */
function skillsRoot() {
  return join(resolveDshHome(), "skills");
}

/** 归档缓存目录。 */
function cacheDir() {
  return join(resolveDshHome(), "cache", "dsh-skill-url");
}

/** 来源记录：{ installed: {...}, recent: [{url,label,at}] }。 */
async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(), "utf8"));
    const installed =
      parsed !== null && typeof parsed === "object" && typeof parsed.installed === "object" && parsed.installed !== null
        ? parsed.installed
        : {};
    const recent = Array.isArray(parsed?.recent) ? parsed.recent.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.url === "string") : [];
    return { installed, recent };
  } catch {
    return { installed: {}, recent: [] };
  }
}

async function saveState(state) {
  await mkdir(resolveDshHome(), { recursive: true });
  await writeFile(
    stateFilePath(),
    JSON.stringify({ installed: state.installed ?? {}, recent: state.recent ?? [] }, null, 2),
    "utf8",
  );
}

// ── wire schemas ──────────────────────────────────────────────────────────

const discoveredSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  directory: z.string(),
  subpath: z.string(),
  installed: z.boolean(),
  enabled: z.boolean(),
});

const inspectResultSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  subpath: z.string(),
  skills: z.array(discoveredSkillSchema),
  totalScanned: z.number(),
  cached: z.boolean(),
});

const installedSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  dirBundle: z.boolean(),
  path: z.string(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  subpath: z.string().optional(),
});

const listInstalledResultSchema = z.object({ skills: z.array(installedSkillSchema) });

const installResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  fileCount: z.number(),
  replaced: z.boolean(),
});

const uninstallResultSchema = z.object({
  name: z.string(),
  removed: z.boolean(),
  disabled: z.boolean(),
});

/** 一条已保存的仓库网址。label 用于展示（owner/repo 或原始文本）。 */
const savedSiteSchema = z.object({
  url: z.string(),
  label: z.string(),
  at: z.number(),
});

const savedSitesResultSchema = z.object({ sites: z.array(savedSiteSchema) });

/**
 * 远程 schema codec 工厂。
 *
 * DSH 的 typert 注册表只认这一种形状：strict codec 必须带 `create()` 工厂，
 * 运行期按 `codec.create().parse(value)` 做边界校验
 * （@deepseek-ai/dsh-typert-registry 的 validateCodec / decode；
 * loader 侧 requireStrictCodec 同样要求 create）。
 * 生成器产出的 codec 也是 `{ mode: "strict", typeSymbol, create: () => z.object({...}) }`。
 *
 * 事故记录：这里曾写成 `{ mode, typeSymbol, schema }`。注册表在
 * ctx.typert.register() 时直接抛
 *   "typert: <id> result strict codec has no create() factory"
 * 于是 skill-url 这一项激活失败（GUI 报「启用失败 / 1 entry did not activate」），
 * 设置页分区也一起消失。test/validate-typert-contract.mjs 用 DSH 里真实的
 * validateInvocation / requireStrictCodec 兜住这个契约。
 */
const codec = (typeSymbol, schema) => ({ mode: "strict", typeSymbol, create: () => schema });

/** 注册到 API 网关的远程描述符。 */
const MANIFEST = {
  package: "dsh-skill-url",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-skill-url#skillUrl/inspect",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "inspect",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText", z.string()) },
      ],
      result: codec("dsh-skill-url#InspectResult", inspectResultSchema),
    },
    {
      id: "dsh-skill-url#skillUrl/listInstalled",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "listInstalled",
      invocation: { kind: "direct" },
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-url#SessionId", z.string().optional()) },
      ],
      result: codec("dsh-skill-url#ListInstalledResult", listInstalledResultSchema),
    },
    {
      // 注意：远程方法名 **不能叫 install**。客户端 api 的 RemoteNamespaceService
      // 原型上就有 install()（installDirect/installScoped 都调它），
      // 它的 assertMethodAvailable 会直接抛
      //   client api: method "skillUrl/install" conflicts with its namespace service
      // 禁用名（原型成员 + REMOTE_NAMESPACE_FIELDS）：
      //   assertMethodAvailable, constructor, empty, has, install, installDirect,
      //   installScoped, methods, remove, ctx, invokeRemote, name, namespace
      // test/validate-typert-contract.mjs 会从 app.asar 里抠出这份名单做校验。
      id: "dsh-skill-url#skillUrl/installSkill",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "installSkill",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText", z.string()) },
        { name: "subpath", wire: "subpath", source: "json", codec: codec("dsh-skill-url#Subpath", z.string()) },
      ],
      result: codec("dsh-skill-url#InstallResult", installResultSchema),
    },
    {
      id: "dsh-skill-url#skillUrl/uninstall",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "uninstall",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: codec("dsh-skill-url#SkillName", z.string()) },
      ],
      result: codec("dsh-skill-url#UninstallResult", uninstallResultSchema),
    },
    {
      // 保存一个仓库网址（最近使用的排在最前，去重，上限 MAX_SAVED_SITES 条）
      id: "dsh-skill-url#skillUrl/rememberUrl",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "rememberUrl",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText", z.string()) },
      ],
      result: codec("dsh-skill-url#SavedSitesResult", savedSitesResultSchema),
    },
    {
      id: "dsh-skill-url#skillUrl/recentUrls",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "recentUrls",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-skill-url#SavedSitesResult", savedSitesResultSchema),
    },
    {
      id: "dsh-skill-url#skillUrl/forgetUrl",
      service: "skillUrl",
      namespace: "skillUrl",
      method: "forgetUrl",
      invocation: { kind: "direct" },
      parameters: [
        { name: "url", wire: "url", source: "json", codec: codec("dsh-skill-url#UrlText", z.string()) },
      ],
      result: codec("dsh-skill-url#SavedSitesResult", savedSitesResultSchema),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

// ── 本地技能扫描（列表 / 冲突检测用）──────────────────────────────────────

/**
 * 扫描 <dsh home>/skills 顶层，返回 { name: {enabled, dirBundle, path, description} }。
 * 顶层扫描即可：安装落点就在顶层，且与 filesystem provider 的发现范围一致。
 */
async function scanUserSkills() {
  const root = skillsRoot();
  const out = new Map();
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    if (dirent.name === ".system") continue;
    if (dirent.isDirectory()) {
      const dir = join(root, dirent.name);
      const on = join(dir, "SKILL.md");
      const off = join(dir, "SKILL.md" + DISABLED_SUFFIX);
      let file;
      let enabled;
      if (await exists(on)) {
        file = on;
        enabled = true;
      } else if (await exists(off)) {
        file = off;
        enabled = false;
      } else {
        continue;
      }
      const meta = await readMeta(file);
      if (meta === undefined) continue;
      out.set(meta.name, { name: meta.name, description: meta.description, enabled, dirBundle: true, path: dir });
    } else if (dirent.name.endsWith(".md") || dirent.name.endsWith(".md" + DISABLED_SUFFIX)) {
      const enabled = dirent.name.endsWith(".md");
      const file = join(root, dirent.name);
      const meta = await readMeta(file);
      if (meta === undefined) continue;
      out.set(meta.name, { name: meta.name, description: meta.description, enabled, dirBundle: false, path: file });
    }
  }
  return out;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 读 SKILL.md 的 frontmatter（复用 discover 的解析器）。 */
async function readMeta(file) {
  try {
    const { parseFrontmatter } = await import("./discover.js");
    return parseFrontmatter(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

// ── 远程服务 ──────────────────────────────────────────────────────────────

class SkillUrlGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "skillUrl");
  }

  /**
   * 粘贴网址 → 发现技能清单（只读，不落盘）。
   * 下载与解压都在临时目录，结束后清理。
   */
  async inspect(url) {
    const loc = parseRepoUrl(url);
    const { buffer, ref, cached } = await fetchArchive(loc.owner, loc.repo, loc.ref, {
      cacheDir: cacheDir(),
    });

    // 解压到临时目录后按 subpath 收窄扫描范围
    const tempDir = await makeTempDir();
    try {
      await extractArchive(buffer, tempDir);
      let scanDir = tempDir;
      if (loc.subpath.length > 0) {
        const candidate = join(tempDir, loc.subpath);
        if (await exists(candidate)) scanDir = candidate;
        // subpath 不存在时不报错：回退扫全仓库，用户仍能看到可装的技能
      }
      const skills = await scanSkills(scanDir);
      const local = await scanUserSkills();
      return {
        owner: loc.owner,
        repo: loc.repo,
        ref,
        subpath: loc.subpath,
        totalScanned: skills.length,
        cached,
        skills: skills.map((s) => {
          const hit = local.get(s.name);
          return {
            name: s.name,
            description: s.description,
            directory: s.directory,
            subpath: s.subpath,
            installed: hit !== undefined,
            enabled: hit?.enabled ?? false,
          };
        }),
      };
    } finally {
      await removeDir(tempDir);
    }
  }

  /** 已安装技能列表（含来源仓库标注）。 */
  async listInstalled(sessionId) {
    const local = await scanUserSkills();
    const { installed } = await loadState();
    const skills = [...local.values()].map((entry) => {
      const src = installed[entry.name];
      return {
        name: entry.name,
        description: entry.description,
        enabled: entry.enabled,
        dirBundle: entry.dirBundle,
        path: entry.path,
        ...(src === undefined ? {} : { owner: src.owner, repo: src.repo, ref: src.ref, subpath: src.subpath }),
      };
    });
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills };
  }

  /**
   * 从网址安装一个技能。原子：先解压到临时目录并校验，再复制到落点。
   * 同名已存在时直接替换（用户已明确选择）。
   *
   * 方法名不能叫 `install`（会撞客户端 RemoteNamespaceService 原型上的
   * install()），故为 installSkill；线名字见 MANIFEST 里的同名 method。
   */
  async installSkill(url, subpath) {
    const loc = parseRepoUrl(url);
    const target = String(subpath ?? "");
    if (target.length === 0) throw new Error("缺少技能路径（subpath）");

    const { buffer, ref } = await fetchArchive(loc.owner, loc.repo, loc.ref, {
      cacheDir: cacheDir(),
    });

    const tempDir = await makeTempDir();
    try {
      await extractArchive(buffer, tempDir);
      // 定位技能源目录：subpath 优先，缺失时按末级目录名递归查找
      let sourceDir;
      const direct = join(tempDir, target);
      if (await exists(join(direct, "SKILL.md"))) {
        sourceDir = direct;
      } else {
        sourceDir = await findDirByName(tempDir, target.split("/").pop(), 0);
      }
      if (sourceDir === undefined) {
        throw new Error(`仓库里找不到这个技能目录：${target}`);
      }

      const meta = await readMeta(join(sourceDir, "SKILL.md"));
      if (meta === undefined) {
        throw new Error("该目录的 SKILL.md 缺少合法的 name/description，不是有效技能");
      }
      const skillName = meta.name;
      if (!NAME_RE.test(skillName)) {
        throw new Error(`技能名不合法（需 kebab-case）：${skillName}`);
      }

      const root = skillsRoot();
      await mkdir(root, { recursive: true });
      const dest = join(root, skillName);
      const replaced = await exists(dest);

      // 原子替换：先复制到兄弟暂存目录，再改名就位
      const staging = join(root, `.installing-${skillName}-${Date.now()}`);
      await mkdir(staging, { recursive: true });
      await cp(sourceDir, staging, { recursive: true });
      if (!(await exists(join(staging, "SKILL.md")))) {
        await rm(staging, { recursive: true, force: true });
        throw new Error("暂存目录缺少 SKILL.md，安装中止");
      }
      await rm(dest, { recursive: true, force: true });
      await rename(staging, dest);

      // 落盘来源记录
      const state = await loadState();
      state.installed[skillName] = { owner: loc.owner, repo: loc.repo, ref, subpath: target, at: Date.now() };
      await saveState(state);

      const files = await countFiles(dest);
      return { name: skillName, path: dest, fileCount: files, replaced };
    } finally {
      await removeDir(tempDir);
    }
  }

  /**
   * 卸载技能。
   *   - 目录束：整目录删除
   *   - 平铺 md：删除该文件（连同可能的 .disabled 变体）
   *   - bundled/runtime 技能不在 skills 根里，天然拒绝
   */
  async uninstall(name) {
    const skillName = String(name ?? "");
    if (!NAME_RE.test(skillName)) throw new Error(`技能名不合法：${skillName}`);

    const local = await scanUserSkills();
    const entry = local.get(skillName);
    if (entry === undefined) {
      throw new Error(`技能 "${skillName}" 不在用户技能目录里，无法卸载`);
    }

    if (entry.dirBundle) {
      await rm(entry.path, { recursive: true, force: true });
    } else {
      await rm(entry.path, { force: true });
      await rm(entry.path.replace(/\.md$/, ".md" + DISABLED_SUFFIX), { force: true });
      // 也尝试停用变体本身
      await rm(entry.path.replace(/\.md$/, ".md") + DISABLED_SUFFIX, { force: true });
    }

    const state = await loadState();
    delete state.installed[skillName];
    await saveState(state);

    return { name: skillName, removed: true, disabled: false };
  }

  // ── 已保存的仓库网址 ───────────────────────────────────────────────────

  /**
   * 保存一个仓库网址。能解析成仓库坐标时**归一化**成 GitHub 首页
   * （同一个仓库从 /tree/main/xxx 或 raw 链接进来也只存一条），否则按原文保存。
   * 最近使用的排最前，按 url 去重，最多 MAX_SAVED_SITES 条。
   */
  async rememberUrl(url) {
    const site = savedSiteOf(url);
    if (site === undefined) throw new Error("网址为空，无法保存");

    const state = await loadState();
    const recent = [site, ...state.recent.filter((entry) => entry.url !== site.url)].slice(0, MAX_SAVED_SITES);
    state.recent = recent;
    await saveState(state);
    return { sites: recent };
  }

  /** 已保存的网址列表（最近使用优先）。 */
  async recentUrls() {
    const { recent } = await loadState();
    return { sites: recent };
  }

  /** 删除一条已保存的网址（按归一化后的 url 精确匹配）。 */
  async forgetUrl(url) {
    const site = savedSiteOf(url);
    const target = site === undefined ? String(url ?? "").trim() : site.url;

    const state = await loadState();
    const recent = state.recent.filter((entry) => entry.url !== target);
    state.recent = recent;
    await saveState(state);
    return { sites: recent };
  }
}

/** 按目录名递归查找含 SKILL.md 的目录（深度 ≤4）。 */
async function findDirByName(dir, target, depth) {
  if (depth > 4 || target === undefined || target.length === 0) return undefined;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const path = join(dir, dirent.name);
    if (dirent.name.toLowerCase() === target.toLowerCase() && (await exists(join(path, "SKILL.md")))) {
      return path;
    }
    const found = await findDirByName(path, target, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 统计目录下文件数（用于安装回执）。 */
async function countFiles(dir) {
  let total = 0;
  async function walk(current) {
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) await walk(join(current, dirent.name));
      else total += 1;
    }
  }
  await walk(dir);
  return total;
}

export function apply(ctx) {
  const gateway = new SkillUrlGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "skill-url: typert manifest");
  return gateway;
}
