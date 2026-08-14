/**
 * Applies the persisted chat-background image to the document. One instance
 * per plugin fiber; pure DOM writes from settings snapshots, in the
 * ui-layout ThemePresenter pattern.
 */
import type { ChatBackgroundSettings } from '../chat-background-settings.ts'

/** CSS variable carrying the scrollport background-image value. */
export const BACKGROUND_IMAGE_VARIABLE = '--dsw-chat-bg-image'

/** Applies chat-background settings snapshots to the document. */
export class ChatBackgroundPresenter {
  /**
   * Project one resolved section onto the document: set or clear the
   * scrollport background-image variable on the root element.
   * @param section - resolved section, or undefined before the first acceptance.
   */
  apply(section: ChatBackgroundSettings | undefined): void {
    const image = section?.backgroundImage
    const value = image ? `url("${image}")` : ''
    document.documentElement.style.setProperty(BACKGROUND_IMAGE_VARIABLE, value)
  }

  /** Retract the variable this presenter wrote. */
  dispose(): void {
    document.documentElement.style.removeProperty(BACKGROUND_IMAGE_VARIABLE)
  }
}
