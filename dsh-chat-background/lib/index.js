import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
//#region lib/types/chat-background-settings.js
/** Durable chat-background settings shared by the Host schema and the browser scope. */
/** Settings namespace owned by the chat-background plugin. */
const CHAT_BACKGROUND_SETTINGS_NAMESPACE = "ui-chat-background";
/** Field carrying the user-picked background image as a data URL. */
const BACKGROUND_IMAGE_FIELD = "backgroundImage";
/** Largest accepted image size in bytes; larger files are refused with copy. */
const MAX_BACKGROUND_IMAGE_BYTES = 2 * 1024 * 1024;
/** Durable chat-background schema; also the wire envelope the browser scope validates against. */
const ChatBackgroundSettingsSchema = z.object({ [BACKGROUND_IMAGE_FIELD]: z.string().default("") });
//#endregion
//#region lib/types/index.js
/** Host registration for the chat-background preference. */
const CHAT_BACKGROUND_NAMESPACE = settingsNamespace(CHAT_BACKGROUND_SETTINGS_NAMESPACE);
/**
* Register the durable chat-background section when the optional Host
* settings service is composed.
* @param ctx - Host context that may acquire the settings service.
*/
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(CHAT_BACKGROUND_NAMESPACE, ChatBackgroundSettingsSchema);
	});
}
//#endregion
export { BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES, apply };
