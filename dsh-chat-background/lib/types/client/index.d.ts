/**
 * Chat-background settings plugin, browser half: binds the durable
 * ui-chat-background namespace, applies its image to the chat scrollport
 * through the presenter, and registers the feature-owned "聊天背景" settings
 * section (pick a local image, preview, apply, reset). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type ChatBackgroundKey } from './locales.ts';
export { ChatBackgroundPresenter } from './background-presenter.ts';
export { BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES } from '../chat-background-settings.ts';
export type { ChatBackgroundSettings } from '../chat-background-settings.ts';
export type { BackgroundSectionInjected, BackgroundSectionProps } from './BackgroundSection.tsx';
export type { ChatBackgroundKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The chat-background section copy. */
        'settings.chat-background': ChatBackgroundKey;
    }
}
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Client plugin body: bind the durable namespace, run the scrollport
 * presenter, register the section copy, and register the settings section.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map