/**
 * Minimal stand-in for `@deepseek-ai/dsh-typert-protocol` used ONLY by the
 * offline tests. DSH resolves the real package from inside its own bundle; this
 * file exists so `node --import ./test/register-stub.mjs` can load
 * `lib/index.js` outside DSH.
 *
 * It mirrors the surface the plugin relies on:
 *   - a base class whose constructor takes (ctx, namespace)
 *   - binding the namespace onto the instance
 *   - a `ctx.reflect.provide(name, service)` call, as cordis' Service does
 */
export class TypertRemoteService {
  constructor(ctx, namespace) {
    this.ctx = ctx;
    this.namespace = namespace;
    if (ctx && ctx.reflect && typeof ctx.reflect.provide === "function") {
      ctx.reflect.provide(namespace, this);
    }
  }
}

export default TypertRemoteService;
