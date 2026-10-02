/**
 * dsh-browser-persist —— asar 归档读写（用 original-fs 绕过 asar 补丁）。
 *
 * 为什么必须是 original-fs：插件跑在 DSH 进程里，而 DSH 对 fs 打了 asar 补丁，
 * 于是 F:\dsh\resources\app.asar 被伪装成目录（statSync 报 isDirectory、size 0），
 * 用普通 fs.openSync 打开它会得到 ENOENT（补丁转身去归档里找"这个文件"）。
 * Electron 的 original-fs 是**未打补丁**的原生 fs，实测可以正常把它当文件读写：
 *
 *     original-fs.statSync(app.asar) -> isFile: true, size: 121348951
 *     前 8 字节 0400000038c23300      -> asar/pickle 归档头
 *
 * 非桌面版（从源码跑 dsh web）没有 original-fs，此时退回 node:fs ——
 * 那种布局下 app.asar 本来就是普通目录，直接编辑文件即可。
 */
import { createRequire } from "node:module";

/** 未打补丁的原生 fs；拿不到就用 node:fs。 */
export function resolveRawFs() {
  try {
    const require = createRequire(import.meta.url);
    const candidate = require("original-fs");
    if (candidate && typeof candidate.openSync === "function") return candidate;
  } catch {
    /* 不是 Electron 环境，正常 */
  }
  return null;
}

import * as nodeFs from "node:fs";

/** 实际使用的 fs：优先 original-fs，退回 node:fs。 */
const fs = resolveRawFs() || nodeFs;
const { closeSync, openSync, readSync, statSync, writeSync, copyFileSync, ftruncateSync } = fs;
import { createHash } from "node:crypto";

/** 读长度头与头部 JSON。 */
export function readHeader(archivePath, mode) {
  const fd = openSync(archivePath, mode || "r");
  try {
    /*
     * 实测出来的头部布局（对真实 app.asar 逐字节核对过）：
     *
     *   [0..4)   = 4                  pickle 长度头，固定
     *   [4..8)   = headerBufLen       含下面这 4 字节的头部总长
     *   [8..12)  = headerBufLen - 4
     *   [12..16) = strLen             JSON 的字节数
     *   [16..)   = JSON
     *
     * 数据区从 dataOffset = 8 + headerBufLen 开始；
     * 条目的 offset 相对 dataOffset。
     */
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, 16, 0);
    const headerBufLen = prefix.readUInt32LE(4);
    const strLen = prefix.readUInt32LE(12);
    if (!(headerBufLen > 0 && headerBufLen < 64 * 1024 * 1024)) {
      throw new Error("asar 头部长度异常：" + headerBufLen);
    }
    if (!(strLen > 0 && strLen <= headerBufLen)) {
      throw new Error("asar 头部字符串长度异常：" + strLen);
    }
    const json = Buffer.alloc(strLen);
    readSync(fd, json, 0, strLen, 16);
    /*
     * JSON 之后到 dataOffset 之间还有 pickle 对齐填充，必须原样保留：
     * 头部总长是 headerBufLen + 8，而 prefix(16) + strLen 常常不等于它。
     * 写回时把这段填充丢掉的后果是——JSON 解析时后面跟上二进制字节，
     * 表现为 "Unexpected token" 之类的 JSON 解析错误。
     */
    const headerEnd = 8 + headerBufLen;
    // 实测：headerBufLen = strLen + 8，因此 headerEnd = 16 + strLen，填充恒为 0。
    // 仍然按通用公式算，兼容未来可能的对齐变化。
    const tailLength = headerEnd - (16 + strLen);
    if (tailLength < 0) throw new Error("asar 头部填充长度为负，布局异常：" + tailLength);
    const tail = Buffer.alloc(tailLength);
    if (tailLength > 0) readSync(fd, tail, 0, tailLength, 16 + strLen);
    return {
      fd: fd,
      headerBufLen: headerBufLen,
      headerPrefix: prefix,
      strLen: strLen,
      headerTail: tail,
      json: json.toString("utf8"),
      dataOffset: headerEnd,
      totalSize: statSync(archivePath).size,
    };
  } catch (error) {
    try { closeSync(fd); } catch { /* 已经关了 */ }
    throw error;
  }
}

/** 按路径片段取条目。 */
export function entryAt(header, parts) {
  let node = header;
  for (const part of parts) {
    const files = node && node.files;
    if (files === undefined || files === null) return null;
    node = files[part];
    if (node === undefined || node === null) return null;
  }
  return node;
}

/** 从归档里读一个文件的原始字节。 */
export function readEntry(archivePath, parts) {
  const header = readHeader(archivePath);
  try {
    const entry = entryAt(JSON.parse(header.json), parts);
    if (entry === null || entry === undefined) throw new Error("归档里没有 " + parts.join("/"));
    if (typeof entry.offset !== "string" || typeof entry.size !== "number") {
      throw new Error(parts.join("/") + " 不是普通文件条目");
    }
    const buffer = Buffer.alloc(entry.size);
    readSync(header.fd, buffer, 0, entry.size, header.dataOffset + Number(entry.offset));
    return { entry: entry, content: buffer };
  } finally {
    closeSync(header.fd);
  }
}

/** sha256 十六进制。 */
export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 把一个条目指向的新内容追加到归档末尾，并改写头部指针。
 *
 * 前置条件（不满足即抛错，绝不猜）：
 *   - 条目存在、是普通文件、sha256 与头部记录一致（防止认错文件）；
 *   - 新旧 size 位数相同、新旧 offset 位数相同（保证头部 JSON 长度不变）；
 *   - 头部 JSON 里该条目的片段唯一可定位。
 */
export function replaceEntryContent(archivePath, parts, newContent) {
  const header = readHeader(archivePath, "r+");
  try {
    const parsed = JSON.parse(header.json);
    const entry = entryAt(parsed, parts);
    if (entry === null || entry === undefined) throw new Error("归档里没有 " + parts.join("/"));
    if (typeof entry.offset !== "string" || typeof entry.size !== "number") {
      throw new Error(parts.join("/") + " 不是普通文件条目");
    }
    const oldOffset = Number(entry.offset);
    const oldSize = entry.size;
    const oldHash = entry.integrity && entry.integrity.hash;
    if (typeof oldHash !== "string" || oldHash.length !== 64) {
      throw new Error(parts.join("/") + " 缺少可用的完整性哈希，拒绝改动");
    }

    // 认文件：内容必须与头部记录的哈希一致
    const current = Buffer.alloc(oldSize);
    readSync(header.fd, current, 0, oldSize, header.dataOffset + oldOffset);
    if (sha256(current) !== oldHash) {
      throw new Error(parts.join("/") + " 的内容哈希与头部记录不符，归档可能已被改动，拒绝操作");
    }

    const next = Buffer.isBuffer(newContent) ? newContent : Buffer.from(String(newContent), "utf8");
    if (next.length === oldSize && sha256(next) === oldHash) {
      return { changed: false, reason: "内容没有变化", size: oldSize, offset: oldOffset, hash: oldHash };
    }
    if (next.length === 0) throw new Error("新内容为空，拒绝写入");

    const newSize = next.length;
    const newHash = sha256(next);

    /*
     * 两种落点：
     *
     *   append      —— 新内容更长，只能写到归档末尾。要腾出新位置，
     *                  归档会变长；写入位置是**绝对位置** header.totalSize。
     *   reuseInPlace —— 旧区域已经放得下（回退时几乎总是如此），直接写回原处，
     *                  归档长度不变，也不会堆出死区。反复"打补丁↔回退"因此不膨胀。
     *
     * 归档条目里的 offset 是**相对 dataOffset** 的，落盘位置是**绝对位置**，
     * 两者相差一个 dataOffset，必须分开算。
     */
    const reuseInPlace = newSize <= oldSize;
    const newAbsolute = reuseInPlace ? header.dataOffset + oldOffset : header.totalSize;
    const newOffset = newAbsolute - header.dataOffset;
    const oldSizeStr = String(oldSize);
    const newSizeStr = String(newSize);
    const oldOffsetStr = String(oldOffset);
    const newOffsetStr = String(newOffset);
    if (oldSizeStr.length !== newSizeStr.length) {
      throw new Error("新旧长度位数不同（" + oldSizeStr.length + " vs " + newSizeStr.length + "），拒绝改动以免头部长度变化");
    }
    if (oldOffsetStr.length !== newOffsetStr.length) {
      throw new Error("新旧偏移位数不同（" + oldOffsetStr.length + " vs " + newOffsetStr.length + "），拒绝改动以免头部长度变化");
    }

    // 定位该条目在 JSON 原文里的片段：用 size + offset 组合，唯一性必须成立
    const anchor = "\"" + parts[parts.length - 1] + "\":{\"size\":" + oldSizeStr + ",\"offset\":\"" + oldOffsetStr + "\"";
    const first = header.json.indexOf(anchor);
    if (first === -1) throw new Error("在头部 JSON 里找不到条目片段，拒绝改动");
    if (header.json.indexOf(anchor, first + 1) !== -1) throw new Error("条目片段不唯一，拒绝改动");
    const regionEnd = Math.min(header.json.length, first + anchor.length + 400);
    const region = header.json.slice(first, regionEnd);
    const hashCount = region.split(oldHash).length - 1;
    if (hashCount !== 2) {
      throw new Error("条目片段里哈希出现 " + hashCount + " 次（应为 2：hash 与 blocks[0]），拒绝改动");
    }

    let newRegion = region.split(oldHash).join(newHash);
    newRegion = newRegion.replace("\"size\":" + oldSizeStr, "\"size\":" + newSizeStr);
    newRegion = newRegion.replace("\"offset\":\"" + oldOffsetStr + "\"", "\"offset\":\"" + newOffsetStr + "\"");
    const newJson = header.json.slice(0, first) + newRegion + header.json.slice(regionEnd);
    if (newJson.length !== header.json.length) {
      throw new Error("改写后头部 JSON 长度变化（" + header.json.length + " -> " + newJson.length + "），拒绝改动");
    }

    // 重建头部缓冲区（prefix + JSON + 对齐填充），总长必须与原来一致
    const newHeaderBuf = Buffer.concat([
      header.headerPrefix,
      Buffer.from(newJson, "utf8"),
      header.headerTail,
    ]);
    if (newHeaderBuf.length !== 8 + header.headerBufLen) {
      throw new Error("头部缓冲区长度变化（" + newHeaderBuf.length + " vs " + (8 + header.headerBufLen) + "），拒绝改动");
    }

    // 备份整个归档（只在第一次改之前做）
    const backup = archivePath + ".dsh-browser-persist.bak";
    if (!exists(backup)) copyFileSync(archivePath, backup);

    /*
     * Windows 上 "r+" 不会因为写到文件末尾之外而自动扩展，越界写会静默产生零区。
     * 所以先显式把文件撑到新的总长度，再写头部与内容。
     * 注意：新内容的写入位置是**绝对位置** newOffset（= 旧文件总长度），
     * 而头部里记录的是相对 dataOffset 的偏移，两者相差一个 dataOffset。
     */
    if (!reuseInPlace) {
      // 追加：先把文件撑到新长度（Windows 的 "r+" 不会自动扩展）
      ftruncateSync(header.fd, newAbsolute + next.length);
    }
    // newHeaderBuf 已包含 16 字节前缀，所以从**偏移 0** 开始写（不是 8）
    writeSync(header.fd, newHeaderBuf, 0, newHeaderBuf.length, 0);
    writeSync(header.fd, next, 0, next.length, newAbsolute);

    return {
      changed: true,
      size: newSize,
      offset: newOffset,
      absoluteOffset: newAbsolute,
      hash: newHash,
      previousSize: oldSize,
      previousOffset: oldOffset,
      previousAbsoluteOffset: header.dataOffset + oldOffset,
      contentGrowth: newSize - oldSize,
      growth: newSize,
      backup: backup,
    };
  } finally {
    closeSync(header.fd);
  }
}

function exists(p) {
  try { statSync(p); return true; } catch { return false; }
}

/** 复验：重新打开归档，确认条目指向新内容且哈希自洽。 */
export function verifyEntry(archivePath, parts, expectedHash) {
  const header = readHeader(archivePath);
  try {
    const parsed = JSON.parse(header.json);
    const entry = entryAt(parsed, parts);
    if (entry === null || entry === undefined) return { ok: false, reason: "复验时找不到条目" };
    const buffer = Buffer.alloc(entry.size);
    readSync(header.fd, buffer, 0, entry.size, header.dataOffset + Number(entry.offset));
    const actual = sha256(buffer);
    if (actual !== entry.integrity.hash) return { ok: false, reason: "复验：内容哈希与头部不一致" };
    if (expectedHash !== undefined && actual !== expectedHash) return { ok: false, reason: "复验：哈希与预期不符" };
    return { ok: true, size: entry.size, offset: Number(entry.offset), hash: actual };
  } catch (error) {
    return { ok: false, reason: "复验失败：" + String(error && error.message ? error.message : error) };
  } finally {
    closeSync(header.fd);
  }
}
