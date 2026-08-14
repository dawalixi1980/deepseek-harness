/**
 * Applies the persisted chat-background image to the document. One instance
 * per plugin fiber; pure DOM writes from settings snapshots, in the
 * ui-layout ThemePresenter pattern.
 */
import type { ChatBackgroundSettings } from '../chat-background-settings.ts';
/** CSS variable carrying the scrollport background-image value. */
export declare const BACKGROUND_IMAGE_VARIABLE = "--dsw-chat-bg-image";
/** Applies chat-background settings snapshots to the document. */
export declare class ChatBackgroundPresenter {
    /**
     * Project one resolved section onto the document: set or clear the
     * scrollport background-image variable on the root element.
     * @param section - resolved section, or undefined before the first acceptance.
     */
    apply(section: ChatBackgroundSettings | undefined): void;
    /** Retract the variable this presenter wrote. */
    dispose(): void;
}
//# sourceMappingURL=background-presenter.d.ts.map