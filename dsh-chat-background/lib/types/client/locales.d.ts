/** Copy dictionaries for the chat-background settings section. */
/** English strings (the key-set source of truth for this pair). */
export declare const en: {
    readonly nav: "Chat Background";
    readonly title: "Chat Background";
    readonly intro: "Pick a local image and apply it as the chat window background. The choice is saved and survives reloads.";
    readonly pick: "Choose image";
    readonly replace: "Replace image";
    readonly current: "Current background";
    readonly preview: "Preview";
    readonly apply: "Apply";
    readonly applying: "Applying…";
    readonly reset: "Reset to default";
    readonly noBackground: "No custom background";
    readonly tooLarge: "The image exceeds {size}, please choose a smaller one.";
    readonly unreadable: "The image could not be read.";
    readonly applyFailed: "Applying the background failed.";
    readonly resetFailed: "Resetting the background failed.";
    readonly filePickerHint: "PNG, JPEG, WebP or GIF, up to {size}.";
};
/** Chinese strings; must keep the same keys as {@link en}. */
export declare const zh: Record<keyof typeof en, string>;
/** Copy keys of the chat-background section. */
export type ChatBackgroundKey = keyof typeof en;
//# sourceMappingURL=locales.d.ts.map