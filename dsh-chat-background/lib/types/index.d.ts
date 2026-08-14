/** Host registration for the chat-background preference. */
import type { Context } from '@deepseek-ai/cordis';
export { BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES, type ChatBackgroundSettings, } from './chat-background-settings.ts';
/**
 * Register the durable chat-background section when the optional Host
 * settings service is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map