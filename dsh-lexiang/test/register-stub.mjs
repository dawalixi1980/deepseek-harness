/**
 * Registers the resolve hook that maps `@deepseek-ai/dsh-typert-protocol` to the
 * local stub. Load this with `node --import ./test/register-stub.mjs ...`.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./hooks-stub.mjs", pathToFileURL(import.meta.filename));
