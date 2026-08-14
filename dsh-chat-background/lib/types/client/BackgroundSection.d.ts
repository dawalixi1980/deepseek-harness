import type { ReactElement } from 'react';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react';
import { type ChatBackgroundSettings } from '../chat-background-settings.ts';
import type { en } from './locales.ts';
import './background.module.css';
/** Injected dependencies of {@link BackgroundSection} (slot `inject`). */
export interface BackgroundSectionInjected {
    /** Durable scope carrying the applied background image. */
    scope: SettingsScope<ChatBackgroundSettings>;
    /** uSES subscription hook bound to the scope snapshot. */
    useSnapshot: SnapshotSelectorHook<SettingsScopeSnapshot<ChatBackgroundSettings>>;
    /** Section copy. */
    t: (key: keyof typeof en, params?: Record<string, unknown>) => string;
    /** Largest accepted image size in bytes. */
    maxBytes: number;
}
/** Props delivered by the slot outlet: the inject face spread flat. */
export type BackgroundSectionProps = Partial<BackgroundSectionInjected>;
/**
 * Guard the inject face: the outlet always supplies every member, but the
 * spread props type stays partial (the ModelsSection precedent).
 * @param props - the inject face spread flat by the slot outlet.
 */
export declare function BackgroundSection(props: BackgroundSectionProps): ReactElement;
//# sourceMappingURL=BackgroundSection.d.ts.map