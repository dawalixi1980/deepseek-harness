/**
 * Node resolve hook: maps the DSH-internal specifiers to local stand-ins so the
 * offline tests can import `lib/index.js` unchanged.
 *
 *   @deepseek-ai/dsh-typert-protocol -> ./typert-stub.mjs
 *   zod                              -> the real zod that ships inside the DSH
 *                                       package (the plugin resolves it the same
 *                                       way inside DSH)
 *
 * Usage: node --import ./test/register-stub.mjs test/host.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Locate the zod that DSH itself bundles. */
function findZod() {
  const candidates = [];
  // 1) next to the globally installed @deepseek-ai/dsh package
  try {
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(
        path.join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "zod", "index.js"),
      );
    }
  } catch { /* ignore */ }
  // 2) resolvable from the plugin directory
  try {
    candidates.push(require.resolve("zod"));
  } catch { /* ignore */ }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return undefined;
}

const ZOD = findZod();

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@deepseek-ai/dsh-typert-protocol") {
    return {
      url: new URL("./typert-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier === "zod") {
    if (ZOD === undefined) {
      throw new Error(
        "dsh-lexiang tests: 找不到 zod。插件在 DSH 内部解析 zod，" +
          "离线测试需要它来构造 strict codec 的 schema。",
      );
    }
    return { url: pathToFileURL(ZOD).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
