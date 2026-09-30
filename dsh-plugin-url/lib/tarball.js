/**
 * 纯 Node 的 npm tarball 打包器。
 *
 * 为什么不用 `pnpm pack` / `npm pack`：
 *   dsh-plugin-url 的运行环境（DSH 桌面版 host 进程）不保证 PATH 里有 pnpm ——
 *   插件管理器自己是从 `pnpmCommand`（默认 "pnpm"）去找的，那个值并不对外暴露。
 *   依赖外部命令会让「装上就用」变成「装不上就废」。npm 包就是一个 gzip 过的
 *   tar，用 node:zlib + 手写 512 字节 tar 头即可自产，零依赖、零外部进程。
 *
 * 产出的归档：条目一律以 `package/` 开头（npm 约定），可被 pnpm/npm 直接 add。
 */
import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/** 不进包的东西：只排除确定无用的，宁可多带也不要漏带（漏带 lib/ 就是装了个废插件）。 */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".github", ".vscode", ".idea", ".cache"]);
const IGNORED_FILE = /\.(?:tgz|tar\.gz)$/i;

/** 上限，防极端仓库把内存打爆。 */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 4000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 八进制字段：n-1 位数字 + NUL。 */
function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/**
 * 把八进制串里的字节数算出来（tar 头里字段一律 ASCII）。
 * @param {Buffer} buf
 */
function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += buf[i];
  return sum;
}

/**
 * 写一个 tar 头。name 放不下时优先用 ustar 的 prefix 字段拆分。
 * @returns {Buffer} 512 字节
 */
function header({ name, prefix, size, mode, mtime, typeflag }) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, NAME_MAX, "utf8");
  buf.write(octal(mode & 0o7777, 8), 100, 8, "ascii");
  buf.write(octal(0, 8), 108, 8, "ascii"); // uid
  buf.write(octal(0, 8), 116, 8, "ascii"); // gid
  buf.write(octal(size, 12), 124, 12, "ascii");
  buf.write(octal(mtime, 12), 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii"); // chksum 占位（必须是空格）
  buf.write(typeflag, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  if (prefix !== undefined && prefix.length > 0) buf.write(prefix, 345, PREFIX_MAX, "utf8");
  buf.write(checksum(buf).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

/**
 * 把 `package/...` 路径拆成 ustar 的 name + prefix。
 * @returns {{name: string, prefix?: string} | undefined} undefined 表示 ustar 放不下，需要 GNU longname
 */
function splitName(fullName) {
  if (Buffer.byteLength(fullName, "utf8") <= NAME_MAX) return { name: fullName };
  for (let i = fullName.length - 1; i > 0; i -= 1) {
    if (fullName[i] !== "/") continue;
    const prefix = fullName.slice(0, i);
    const name = fullName.slice(i + 1);
    if (name.length === 0) continue;
    if (Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX && Buffer.byteLength(name, "utf8") <= NAME_MAX) {
      return { name, prefix };
    }
  }
  return undefined;
}

/** 文件条目：`${prefix}/文件` 的 tar 块序列（含 512 对齐填充）。 */
function fileEntry(archivePath, content, mode, mtime) {
  const parts = [];
  const split = splitName(archivePath);
  if (split === undefined) {
    // GNU longname：一个 'L' 头 + 名字本体，随后是真头（名字用截断串占位）
    const payload = Buffer.from(archivePath + "\0", "utf8");
    parts.push(header({ name: "././@LongLink", size: payload.length, mode: 0o644, mtime, typeflag: "L" }));
    parts.push(pad(payload));
    parts.push(header({ name: archivePath.slice(0, NAME_MAX), size: content.length, mode, mtime, typeflag: "0" }));
  } else {
    parts.push(header({ ...split, size: content.length, mode, mtime, typeflag: "0" }));
  }
  parts.push(pad(content));
  return Buffer.concat(parts);
}

/** 内容补到 512 边界。 */
function pad(content) {
  const rest = content.length % BLOCK;
  if (rest === 0) return content;
  return Buffer.concat([content, Buffer.alloc(BLOCK - rest)]);
}

/**
 * 收集要打包的文件。
 * @param {string} dir 包目录
 * @returns {Promise<Array<{archivePath: string, full: string, size: number, mode: number, mtime: number}>>}
 */
async function collect(dir) {
  const out = [];
  let total = 0;
  async function walk(current, rel) {
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = join(current, dirent.name);
      const next = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`;
      // 符号链接一律跳过：既不跟随（防目录逃逸），也不打包（防指向仓库外的文件）
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name)) continue;
        await walk(full, next);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (IGNORED_FILE.test(dirent.name)) continue;
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      total += info.size;
      if (total > MAX_TOTAL_BYTES) throw new Error(`包体积超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MiB 上限，拒绝打包`);
      out.push({
        archivePath: `package/${next}`,
        full,
        size: info.size,
        mode: info.mode & 0o7777,
        mtime: Math.floor(info.mtimeMs / 1000),
      });
      if (out.length > MAX_ENTRIES) throw new Error(`文件数超过 ${MAX_ENTRIES} 上限，拒绝打包`);
    }
  }
  await walk(dir, "");
  return out;
}

/**
 * 把一个插件目录打成 npm tarball。
 * @param {string} dir 包根目录（含 package.json）
 * @returns {Promise<Buffer>} gzip 后的 tar
 */
export async function buildNpmTarball(dir) {
  const entries = await collect(dir);
  const hasManifest = entries.some((entry) => entry.archivePath === "package/package.json");
  if (!hasManifest) throw new Error("该目录没有 package.json，无法打包");

  const chunks = [];
  for (const entry of entries) {
    const content = await readFile(entry.full);
    chunks.push(fileEntry(entry.archivePath, content, entry.mode || 0o644, entry.mtime));
  }
  // tar 结尾必须是两个全零块
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}
