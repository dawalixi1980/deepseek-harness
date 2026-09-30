/**
 * dsh-skill-url —— URL 解析与 GitHub 技能发现。
 *
 * 设计目标：用户粘贴一个网址，插件自己搞清楚"这是哪个仓库的哪一层"，
 * 然后把里面所有 skill 找出来。与 dsh-skill-remote 的关键区别：
 *   - 接受**仓库首页** URL（dsh-skill-remote 只认 /tree/ 深链，首页会直接报错）
 *   - 接受子目录、blob 文件、raw 链接、skills.sh，全部归一化到
 *     { owner, repo, ref, subpath }
 *   - 下载仓库归档后**递归**扫描全部 SKILL.md（不只是直接子级）
 *
 * 本模块零外部依赖（只用 node: 内置模块）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// ── 体积与超时护栏 ────────────────────────────────────────────────────────

/** 归档下载上限：技能仓库不该有几百 MB。 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** 单次下载超时（毫秒）。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 递归扫描深度上限，防止畸形仓库把内存打满。 */
export const MAX_SCAN_DEPTH = 6;
/** 单仓库最多发现多少个技能。 */
export const MAX_SKILLS = 300;
/** 单个 SKILL.md 读取上限（防止把巨型文件读进内存）。 */
const MAX_SKILL_FILE_BYTES = 512 * 1024;

// ── 仓库坐标校验（字符白名单，防 URL 改写 / 路径穿越）─────────────────────

/** GitHub 账号名：ASCII 字母数字 + '-'，≤39。 */
export function isValidOwner(owner) {
  return (
    typeof owner === "string" &&
    owner.length > 0 &&
    owner.length <= 39 &&
    [...owner].every((c) => /[A-Za-z0-9-]/.test(c))
  );
}

/** 仓库名：字母数字 + . - _，不能是 . 或 ..，≤100。 */
export function isValidRepoName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 100 &&
    name !== "." &&
    name !== ".." &&
    [...name].every((c) => /[A-Za-z0-9._-]/.test(c))
  );
}

/** git ref（分支/标签）：逐段白名单，允许 /。 */
export function isValidRef(ref) {
  if (typeof ref !== "string") return false;
  if (ref.length === 0 || ref.toUpperCase() === "HEAD") return true;
  if (ref.length > 200) return false;
  if (ref.startsWith("/") || ref.endsWith("/") || ref.includes("//")) return false;
  if (ref.includes("@{") || ref.includes("..")) return false;
  if ([...ref].some((c) => c < " " || " ~^:?*[\\#%".includes(c))) return false;
  return ref
    .split("/")
    .every(
      (seg) =>
        seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".") && !seg.endsWith(".lock"),
    );
}

/** 子路径：不得含 .. 段、不得绝对、不得盘符。 */
export function isSafeSubpath(subpath) {
  if (typeof subpath !== "string") return false;
  if (subpath.length === 0) return true;
  if (subpath.startsWith("/") || /^[A-Za-z]:/.test(subpath)) return false;
  return !subpath.split("/").some((seg) => seg === "..");
}

/** 校验一处仓库坐标；任何异常都抛，绝不"尽力而为"。 */
export function assertRepoRef(owner, repo, ref, subpath) {
  if (!isValidOwner(owner)) throw new Error(`无效的 GitHub 用户名：${owner}`);
  if (!isValidRepoName(repo)) throw new Error(`无效的仓库名：${repo}`);
  if (!isValidRef(ref)) throw new Error(`无效的分支/标签名：${ref}`);
  if (!isSafeSubpath(subpath)) throw new Error(`无效的子路径：${subpath}`);
}

// ── URL 解析：把五花八门的输入归一化 ──────────────────────────────────────

/**
 * @typedef {Object} RepoLocation
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref      分支/标签；空串表示"用默认分支自动探测"
 * @property {string} subpath  仓库内相对目录；空串表示仓库根
 * @property {string} original 用户原始输入（错误信息里回显）
 */

/**
 * 把用户粘贴的任意受支持网址解析成 {@link RepoLocation}。
 *
 * 支持：
 *   - https://github.com/owner/repo                      （仓库首页 ← 重点）
 *   - https://github.com/owner/repo/tree/ref/sub/dir
 *   - https://github.com/owner/repo/blob/ref/sub/SKILL.md
 *   - https://github.com/owner/repo/tree/ref/sub/dir/    （尾斜杠）
 *   - https://raw.githubusercontent.com/owner/repo/ref/sub/SKILL.md
 *   - https://www.skills.sh/owner/repo/skill-name
 *   - owner/repo 或 owner/repo/sub/dir                   （裸坐标）
 *
 * @throws {Error} 输入不受支持或含非法坐标时。
 */
export function parseRepoUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length === 0) throw new Error("请输入一个仓库网址");

  // 裸坐标：owner/repo[/sub...]，不含协议且第一段是合法用户名。
  // 注意：形如 "github.com/a/b" 的输入不含协议，但它明显是个网址，
  // 必须走下面的 URL 分支并给出"缺 https://"的明确提示，而不是当成
  // 一个叫 "github.com" 的用户名。
  const looksLikeHost =
    /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/|$)/.test(trimmed) && !trimmed.includes("/ ");
  if (!trimmed.includes("://") && !trimmed.includes(" ") && !looksLikeHost) {
    const segs = trimmed.split("/").filter((s) => s.length > 0);
    if (segs.length >= 2) {
      const [owner, repo, ...rest] = segs;
      const loc = { owner, repo, ref: "", subpath: rest.join("/"), original: trimmed };
      assertRepoRef(loc.owner, loc.repo, loc.ref, loc.subpath);
      return loc;
    }
    throw new Error(`看不懂这个输入："${trimmed}"（试试 owner/repo 或完整网址）`);
  }

  // 没写协议但像一个网址：补一个 https:// 再解析，比报错更有用。
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`不是合法的网址："${trimmed}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只支持 http/https 网址，收到 "${url.protocol}"`);
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter((s) => s.length > 0);

  // skills.sh：/owner/repo/skill-name → 约定技能在 skills/ 目录下
  if (host === "skills.sh" || host === "www.skills.sh") {
    if (parts.length < 3) throw new Error("skills.sh 网址应为 /<owner>/<repo>/<skill>");
    const loc = {
      owner: parts[0],
      repo: parts[1],
      ref: "",
      subpath: `skills/${parts.slice(2).join("/")}`,
      original: trimmed,
    };
    assertRepoRef(loc.owner, loc.repo, loc.ref, loc.subpath);
    return loc;
  }

  // raw.githubusercontent.com：/owner/repo/ref/sub.../FILE
  if (host === "raw.githubusercontent.com") {
    if (parts.length < 3) throw new Error("raw 链接过短，应为 /<owner>/<repo>/<ref>/<路径>");
    const owner = parts[0];
    const repo = parts[1];
    const ref = parts[2];
    let rest = parts.slice(3);
    // 末段看起来像文件名（含点）就丢掉，定位到目录
    if (rest.length > 0 && rest[rest.length - 1].includes(".")) rest = rest.slice(0, -1);
    const loc = { owner, repo, ref, subpath: rest.join("/"), original: trimmed };
    assertRepoRef(loc.owner, loc.repo, loc.ref, loc.subpath);
    return loc;
  }

  if (host === "github.com" || host === "www.github.com") {
    if (parts.length < 2) throw new Error("GitHub 网址至少要包含 <owner>/<repo>");
    const owner = parts[0];
    const repo = parts[1];
    const rest = parts.slice(2);

    // 仓库首页：没有任何后续段，或只有 query/hash → 用默认分支扫全仓库
    if (rest.length === 0) {
      assertRepoRef(owner, repo, "", "");
      return { owner, repo, ref: "", subpath: "", original: trimmed };
    }

    // 非 tree/blob 的后续段（如 /issues、/releases）不是技能位置，回退到仓库根
    const kind = rest[0];
    if (kind !== "tree" && kind !== "blob") {
      assertRepoRef(owner, repo, "", "");
      return { owner, repo, ref: "", subpath: "", original: trimmed };
    }
    if (rest.length < 2) {
      throw new Error(`${kind} 链接缺少分支/标签名`);
    }

    let ref = rest[1];
    let sub = rest.slice(2);
    // 末段是文件（含点）→ 丢文件，定位目录（blob 链接尤其常见）
    if (kind === "blob" && sub.length > 0) sub = sub.slice(0, -1);
    // GitHub 的 ref 可以含 /，但无法从 URL 区分。此处按单段 ref 处理；
    // 若下载失败，discover 会用默认分支重试，故不影响可用性。

    const loc = { owner, repo, ref, subpath: sub.join("/"), original: trimmed };
    assertRepoRef(loc.owner, loc.repo, loc.ref, loc.subpath);
    return loc;
  }

  throw new Error(`不支持的网址域名 "${host}"（支持 github.com / raw.githubusercontent.com / skills.sh）`);
}

// ── 归档下载 ──────────────────────────────────────────────────────────────

/** 可重试的网络错误（瞬时失败），确定性错误（404 等）不重试。 */
class DeterministicError extends Error {}

async function downloadOnce(url, maxBytes, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    if (signal?.aborted) throw new Error("已取消");
    const why = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
    throw new Error(`网络请求失败：${why}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new DeterministicError(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("响应没有内容");
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      throw new DeterministicError(`归档过大（超过 ${Math.round(maxBytes / 1024 / 1024)} MiB）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 下载归档（瞬时失败重试 2 次）。 */
export async function downloadArchive(url, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const retries = options.retries ?? 2;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      return await downloadOnce(url, maxBytes, options.signal);
    } catch (err) {
      if (err instanceof DeterministicError) throw err;
      last = err;
    }
  }
  throw last ?? new Error("下载失败");
}

/** 分支候选：显式 ref → main → master（仓库默认分支未知时的兜底）。 */
export function refCandidates(ref) {
  const out = [];
  if (typeof ref === "string" && ref.length > 0 && ref.toUpperCase() !== "HEAD") out.push(ref);
  if (!out.includes("main")) out.push("main");
  if (!out.includes("master")) out.push("master");
  return out;
}

/** codeload 归档地址（比 github.com/.../archive 少一跳重定向）。 */
function archiveUrl(owner, repo, ref) {
  return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(ref)}`;
}

/** 归档缓存：<dsh home>/cache/dsh-skill-url，默认 30 分钟。 */
export const ARCHIVE_CACHE_TTL_MS = 30 * 60 * 1000;

function cacheKey(owner, repo, ref) {
  return `${owner}__${repo}__${ref}.zip`.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readCache(cacheDir, owner, repo, ref, ttlMs) {
  if (cacheDir === undefined) return undefined;
  const file = join(cacheDir, cacheKey(owner, repo, ref));
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > ttlMs) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

async function writeCache(cacheDir, owner, repo, ref, buffer) {
  if (cacheDir === undefined) return;
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, cacheKey(owner, repo, ref)), buffer);
  } catch {
    // 缓存写失败不影响主流程
  }
}

/**
 * 取仓库归档，自动在候选分支间回退。
 * @returns {Promise<{buffer: Buffer, ref: string, cached: boolean}>}
 */
export async function fetchArchive(owner, repo, ref, options = {}) {
  assertRepoRef(owner, repo, ref, "");
  const cacheDir = options.cacheDir;
  const ttlMs = options.ttlMs ?? ARCHIVE_CACHE_TTL_MS;
  let last;
  for (const candidate of refCandidates(ref)) {
    const cached = await readCache(cacheDir, owner, repo, candidate, ttlMs);
    if (cached !== undefined) return { buffer: cached, ref: candidate, cached: true };
    try {
      const buffer = await downloadArchive(archiveUrl(owner, repo, candidate), options);
      await writeCache(cacheDir, owner, repo, candidate, buffer);
      return { buffer, ref: candidate, cached: false };
    } catch (err) {
      last = err;
      if (options.signal?.aborted) throw new Error("已取消");
    }
  }
  const reason = last instanceof DeterministicError ? last.message : (last?.message ?? "未知错误");
  throw new Error(`无法下载 ${owner}/${repo}：${reason}（可能是私有仓库、仓库不存在，或分支名不对）`);
}

// ── ZIP 解压（仅支持 store + deflate，零依赖）────────────────────────────

/** 解析 ZIP 中央目录，返回条目列表。 */
export function parseZipEntries(buffer) {
  // 从尾部找 EOCD（End Of Central Directory）签名 0x06054b50
  const maxBack = Math.min(buffer.length, 66_000);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= buffer.length - maxBack && i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("不是有效的 ZIP 归档（找不到中央目录）");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP 中央目录损坏");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({
      name,
      method,
      compressedSize,
      localOffset,
      // Unix 模式下 0xA000 位表示符号链接
      isSymlink: (externalAttrs >>> 16) & 0xa000 ? ((externalAttrs >>> 16) & 0xf000) === 0xa000 : false,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压单条目为 Buffer。 */
export async function readZipEntry(buffer, entry) {
  const off = entry.localOffset;
  if (buffer.readUInt32LE(off) !== 0x04034b50) throw new Error("ZIP 本地头损坏");
  const nameLen = buffer.readUInt16LE(off + 26);
  const extraLen = buffer.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    const { inflateRawSync } = await import("node:zlib");
    return inflateRawSync(raw);
  }
  throw new Error(`不支持的压缩方式 ${entry.method}（仅支持 store/deflate）`);
}

/** 归档顶层包装目录（GitHub 归档统一是 <repo>-<ref>/）。 */
export function findWrapperRoot(entries) {
  if (entries.length === 0) return undefined;
  const first = entries[0].name;
  if (!first.endsWith("/")) return undefined;
  const seg = first.split("/")[0];
  if (!seg) return undefined;
  const prefix = seg + "/";
  return entries.every((e) => e.name === seg || e.name.startsWith(prefix)) ? seg : undefined;
}

// ── 技能发现 ──────────────────────────────────────────────────────────────

/** 规范化 frontmatter 名称校验（kebab-case）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 解析 SKILL.md 的 YAML frontmatter（宽松实现，只取 name/description）。
 * 支持多行 description（YAML 折叠/块标量）——这是常见写法。
 */
export function parseFrontmatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("---")) return undefined;
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1) return undefined;
  const closing = text.indexOf("\n---", firstEnd + 1);
  const fmEnd = closing === -1 ? text.length : closing;
  const fm = text.slice(3, fmEnd);

  const pick = (key) => {
    // 单行：key: value
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fm);
    if (line === null) return undefined;
    let value = line[1].trim();
    // 值可能被引号包裹（"x" / 'x'），先剥引号再判断是否为块标量。
    // 顺序很关键：不然 `description: "hi"` 会被误当成块标量。
    const unquote = (v) => {
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        return v.slice(1, -1);
      }
      return v;
    };
    // 块标量（| 或 >）：后续缩进行都是内容
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const idx = fm.indexOf(line[0]) + line[0].length;
      const rest = fm.slice(idx).split("\n");
      const buf = [];
      for (const l of rest) {
        if (l.trim().length === 0) {
          buf.push("");
          continue;
        }
        if (!/^\s/.test(l)) break;
        buf.push(l.trim());
      }
      return buf.join(" ").trim();
    }
    return unquote(value);
  };

  const name = pick("name");
  if (name === undefined || !SKILL_NAME_RE.test(name)) return undefined;
  return { name, description: pick("description") ?? "" };
}

/**
 * 扫描已解压的目录树，找出全部技能目录（含 SKILL.md 的目录）。
 * @returns {Promise<Array<{name, description, directory, subpath}>>}
 */
export async function scanSkills(rootDir, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const limit = options.limit ?? MAX_SKILLS;
  const found = [];

  async function walk(dir, relPath, depth) {
    if (depth > maxDepth || found.length >= limit) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 当前目录自身就是技能？
    const skillFile = dirents.find((d) => d.isFile() && d.name === "SKILL.md");
    if (skillFile !== undefined) {
      const parsed = await readSkillMeta(join(dir, "SKILL.md"));
      if (parsed !== undefined) {
        found.push({
          name: parsed.name,
          description: parsed.description,
          directory: relPath === "" ? "." : relPath,
          subpath: relPath,
        });
      }
      // 技能目录不再深入（避免把技能内部的示例当技能）
      return;
    }
    for (const dirent of dirents) {
      if (found.length >= limit) return;
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const next = relPath === "" ? dirent.name : `${relPath}/${dirent.name}`;
      await walk(join(dir, dirent.name), next, depth + 1);
    }
  }

  await walk(rootDir, "", 0);
  // 去重（同 subpath 只留一个）并按名排序
  const seen = new Set();
  const out = found.filter((s) => {
    const k = s.subpath.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function readSkillMeta(file) {
  try {
    const info = await stat(file);
    if (info.size > MAX_SKILL_FILE_BYTES) return undefined;
    return parseFrontmatter(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** 解压整个归档到一个临时目录（跳过符号链接与路径穿越条目）。 */
export async function extractArchive(buffer, targetDir) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const entries = parseZipEntries(buffer);
  const root = resolve(targetDir);
  const wrapper = findWrapperRoot(entries);
  let written = 0;
  for (const entry of entries) {
    if (entry.isSymlink) continue;
    let name = entry.name;
    if (wrapper !== undefined) {
      if (name === wrapper) continue;
      if (!name.startsWith(wrapper + "/")) continue;
      name = name.slice(wrapper.length + 1);
    }
    if (name.length === 0 || name.endsWith("/")) continue;
    // 路径穿越防护
    const dest = resolve(join(root, name));
    if (dest !== root && !dest.startsWith(root + sep)) continue;
    const data = await readZipEntry(buffer, entry);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, data);
    written += 1;
    if (written > 20_000) throw new Error("归档条目过多（上限 20000）");
  }
  return written;
}

/** 系统临时目录下的工作目录工厂。 */
export async function makeTempDir(prefix = ".dsh-su-") {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), prefix));
}

/** 接收 zip 缓冲区，解压并返回发现的技能（一次性，自动清理）。 */
export async function inspectArchive(buffer, options = {}) {
  const tempDir = await makeTempDir();
  const { rm } = await import("node:fs/promises");
  try {
    await extractArchive(buffer, tempDir);
    const skills = await scanSkills(tempDir, options);
    return { skills, tempDir };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

/** 递归删除目录（容错）。 */
export async function removeDir(dir) {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}
