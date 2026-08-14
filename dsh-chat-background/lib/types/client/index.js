import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react';
import { ChatBackgroundPresenter } from "./background-presenter.js";
import { BackgroundSection } from "./BackgroundSection.js";
import { en, zh } from "./locales.js";
import { CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES, } from "../chat-background-settings.js";
export { ChatBackgroundPresenter } from "./background-presenter.js";
export { BACKGROUND_IMAGE_FIELD, CHAT_BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES } from "../chat-background-settings.js";
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.chat-background';
/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];
/**
 * Client plugin body: bind the durable namespace, run the scrollport
 * presenter, register the section copy, and register the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    const scope = ctx.settingsScope.bind({ namespace: CHAT_BACKGROUND_SETTINGS_NAMESPACE });
    // Presenter: pure DOM writes from settings snapshots, in the ui-layout
    // ThemePresenter pattern; no React path.
    ctx.effect(() => {
        const presenter = new ChatBackgroundPresenter();
        presenter.apply(scope.getSnapshot().value);
        const off = scope.subscribe(() => presenter.apply(scope.getSnapshot().value));
        return () => {
            off();
            presenter.dispose();
        };
    }, 'ui-chat-background: scrollport presenter');
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat-background: section dictionaries');
    // Registration-time text (the nav label thunk) and the inject face share
    // one bound translate; copy freshness rides the locale revision.
    const t = ctx.locale.bind(NS);
    const useSnapshot = bindSnapshotSelector(scope);
    const injected = () => ({
        scope,
        useSnapshot,
        t,
        maxBytes: MAX_BACKGROUND_IMAGE_BYTES,
    });
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'chat-background',
        order: 20,
        label: () => t('nav'),
        inject: injected,
    }, BackgroundSection));
}
//# sourceMappingURL=index.js.map