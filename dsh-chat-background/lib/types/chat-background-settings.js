/** Durable chat-background settings shared by the Host schema and the browser scope. */
import z from '@deepseek-ai/schemastery';
/** Settings namespace owned by the chat-background plugin. */
export const CHAT_BACKGROUND_SETTINGS_NAMESPACE = 'ui-chat-background';
/** Field carrying the user-picked background image as a data URL. */
export const BACKGROUND_IMAGE_FIELD = 'backgroundImage';
/** Largest accepted image size in bytes; larger files are refused with copy. */
export const MAX_BACKGROUND_IMAGE_BYTES = 2 * 1024 * 1024;
/** Durable chat-background schema; also the wire envelope the browser scope validates against. */
export const ChatBackgroundSettingsSchema = z.object({
    [BACKGROUND_IMAGE_FIELD]: z.string().default(''),
});
//# sourceMappingURL=chat-background-settings.js.map