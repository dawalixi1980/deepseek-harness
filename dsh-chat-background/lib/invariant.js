//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-chat-background`.
* @module @deepseek-ai/dsh-client-ui-chat-background/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-chat-background";
/** Cordis companion plugin name. */
const name = "client-ui-chat-background-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the settings namespace registration is a provider
* effect observed through the settings wire, and the presenter's DOM writes
* are covered by the client spec.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns The installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
