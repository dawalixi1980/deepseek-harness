/** Host registration for the chat-background preference. */
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { CHAT_BACKGROUND_SETTINGS_NAMESPACE, ChatBackgroundSettingsSchema, } from "./chat-background-settings.js";
export { BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES, } from "./chat-background-settings.js";
const CHAT_BACKGROUND_NAMESPACE = settingsNamespace(CHAT_BACKGROUND_SETTINGS_NAMESPACE);
/**
 * Register the durable chat-background section when the optional Host
 * settings service is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx) {
    ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.settings.register(CHAT_BACKGROUND_NAMESPACE, ChatBackgroundSettingsSchema);
    });
}
//# sourceMappingURL=index.js.map