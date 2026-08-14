/** Host registration for the chat-background preference. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CHAT_BACKGROUND_SETTINGS_NAMESPACE, ChatBackgroundSettingsSchema,
} from './chat-background-settings.ts'

export {
  BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES,
  type ChatBackgroundSettings,
} from './chat-background-settings.ts'

const CHAT_BACKGROUND_NAMESPACE = settingsNamespace(CHAT_BACKGROUND_SETTINGS_NAMESPACE)

/**
 * Register the durable chat-background section when the optional Host
 * settings service is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(CHAT_BACKGROUND_NAMESPACE, ChatBackgroundSettingsSchema)
  })
}