/**
 * Chat-background settings plugin, browser half: binds the durable
 * ui-chat-background namespace, applies its image to the chat scrollport
 * through the presenter, and registers the feature-owned "聊天背景" settings
 * section (pick a local image, preview, apply, reset). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ChatBackgroundPresenter } from './background-presenter.ts'
import { BackgroundSection } from './BackgroundSection.tsx'
import type { BackgroundSectionInjected } from './BackgroundSection.tsx'
import { en, zh, type ChatBackgroundKey } from './locales.ts'
import {
  CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES,
  type ChatBackgroundSettings,
} from '../chat-background-settings.ts'

export { ChatBackgroundPresenter } from './background-presenter.ts'
export { BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES } from '../chat-background-settings.ts'
export type { ChatBackgroundSettings } from '../chat-background-settings.ts'
export type { BackgroundSectionInjected, BackgroundSectionProps } from './BackgroundSection.tsx'
export type { ChatBackgroundKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The chat-background section copy. */
    'settings.chat-background': ChatBackgroundKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.chat-background'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: bind the durable namespace, run the scrollport
 * presenter, register the section copy, and register the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<ChatBackgroundSettings>({ namespace: CHAT_BACKGROUND_SETTINGS_NAMESPACE })

  // Presenter: pure DOM writes from settings snapshots, in the ui-layout
  // ThemePresenter pattern; no React path.
  ctx.effect(() => {
    const presenter = new ChatBackgroundPresenter()
    presenter.apply(scope.getSnapshot().value)
    const off = scope.subscribe(() => presenter.apply(scope.getSnapshot().value))
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-chat-background: scrollport presenter')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat-background: section dictionaries')

  // Registration-time text (the nav label thunk) and the inject face share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as BackgroundSectionInjected['t']
  const useSnapshot = bindSnapshotSelector(scope)
  const injected = (): BackgroundSectionInjected => ({
    scope,
    useSnapshot,
    t,
    maxBytes: MAX_BACKGROUND_IMAGE_BYTES,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'chat-background',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, BackgroundSection))
}