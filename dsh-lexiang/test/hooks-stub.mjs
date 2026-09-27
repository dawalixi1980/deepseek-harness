/**
 * Node resolve hook: maps the DSH-internal specifier to the local stub so the
 * offline tests can import `lib/index.js` unchanged.
 *
 * Usage: node --import ./test/register-stub.mjs test/host.test.mjs
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@deepseek-ai/dsh-typert-protocol") {
    return {
      url: new URL("./typert-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
