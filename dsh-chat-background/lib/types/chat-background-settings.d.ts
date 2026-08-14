/** Durable chat-background settings shared by the Host schema and the browser scope. */
import z from '@deepseek-ai/schemastery';
/** Settings namespace owned by the chat-background plugin. */
export declare const CHAT_BACKGROUND_SETTINGS_NAMESPACE = "ui-chat-background";
/** Field carrying the user-picked background image as a data URL. */
export declare const BACKGROUND_IMAGE_FIELD = "backgroundImage";
/** Largest accepted image size in bytes; larger files are refused with copy. */
export declare const MAX_BACKGROUND_IMAGE_BYTES: number;
/** Durable chat-background section shared by the Host schema and the browser scope. */
export interface ChatBackgroundSettings {
    /** Data URL of the user-picked chat background image; empty when unset. */
    backgroundImage: string;
}
/** Durable chat-background schema; also the wire envelope the browser scope validates against. */
export declare const ChatBackgroundSettingsSchema: z<ChatBackgroundSettings>;
//# sourceMappingURL=chat-background-settings.d.ts.map