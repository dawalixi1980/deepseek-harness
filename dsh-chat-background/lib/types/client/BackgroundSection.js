import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Chat-background settings section: pick a local image, preview it, apply it
 * as the chat scrollport background, or reset to the default. Reads and
 * writes ride the durable settings scope; the pick draft is component-local.
 */
import { useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { BACKGROUND_IMAGE_FIELD } from "../chat-background-settings.js";
import sectionStyles from './BackgroundSection.module.css';
import './background.module.css';
/** Human-readable size limit used in copy, e.g. "2 MB". */
function formatLimit(bytes) {
    if (bytes % (1024 * 1024) === 0)
        return `${bytes / (1024 * 1024)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
}
/**
 * Guard the inject face: the outlet always supplies every member, but the
 * spread props type stays partial (the ModelsSection precedent).
 * @param props - the inject face spread flat by the slot outlet.
 */
export function BackgroundSection(props) {
    const { scope, useSnapshot, t, maxBytes } = props;
    if (scope === undefined || useSnapshot === undefined || t === undefined || maxBytes === undefined) {
        return _jsx(_Fragment, {});
    }
    return (_jsx(BackgroundSectionLoaded, { scope: scope, useSnapshot: useSnapshot, t: t, maxBytes: maxBytes }));
}
/** The section body with a complete inject face. */
function BackgroundSectionLoaded({ scope, useSnapshot, t, maxBytes, }) {
    const inputRef = useRef(null);
    const snapshot = useSnapshot(snapshot => snapshot);
    const [draft, setDraft] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const applied = snapshot.value?.backgroundImage;
    const preview = draft ?? applied;
    const limit = formatLimit(maxBytes);
    function openPicker() {
        inputRef.current?.click();
    }
    function pickImage(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file)
            return;
        if (file.size > maxBytes) {
            setError(t('tooLarge', { size: limit }));
            setDraft(null);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            setDraft(typeof reader.result === 'string' ? reader.result : null);
            setError(null);
        };
        reader.onerror = () => {
            setError(t('unreadable'));
            setDraft(null);
        };
        reader.readAsDataURL(file);
    }
    async function applyDraft() {
        // The Apply button is disabled without a draft, so this guard cannot run.
        /* v8 ignore next -- unreachable through the UI: the button gates on draft */
        if (!draft)
            return;
        setBusy(true);
        setError(null);
        try {
            await scope.set(BACKGROUND_IMAGE_FIELD, draft);
            setDraft(null);
        }
        catch {
            setError(t('applyFailed'));
        }
        finally {
            setBusy(false);
        }
    }
    async function reset() {
        setBusy(true);
        setError(null);
        try {
            await scope.unset(BACKGROUND_IMAGE_FIELD);
        }
        catch {
            setError(t('resetFailed'));
        }
        finally {
            setBusy(false);
        }
    }
    return (_jsxs("section", { className: sectionStyles.section, children: [_jsx("p", { className: sectionStyles.intro, children: t('intro') }), _jsx("div", { className: sectionStyles.previewCard, children: preview
                    ? _jsx("img", { className: sectionStyles.previewImage, src: preview, alt: t('preview') })
                    : _jsx("span", { className: sectionStyles.emptyPreview, children: t('noBackground') }) }), applied && !draft && _jsx("p", { className: sectionStyles.currentLabel, children: t('current') }), draft && _jsx("p", { className: sectionStyles.currentLabel, children: t('preview') }), error && _jsx("p", { className: sectionStyles.error, role: "alert", children: error }), _jsx("input", { ref: inputRef, className: sectionStyles.hiddenInput, type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", onChange: pickImage }), _jsxs("div", { className: sectionStyles.actions, children: [_jsx(Button, { onClick: openPicker, children: draft ? t('replace') : t('pick') }), _jsx(Button, { disabled: !draft || busy, onClick: applyDraft, children: busy ? t('applying') : t('apply') }), _jsx(Button, { disabled: !applied || busy, onClick: reset, children: t('reset') })] }), _jsx("p", { className: sectionStyles.hint, children: t('filePickerHint', { size: limit }) })] }));
}
//# sourceMappingURL=BackgroundSection.js.map