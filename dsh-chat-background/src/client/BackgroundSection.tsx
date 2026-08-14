/**
 * Chat-background settings section: pick a local image, preview it, apply it
 * as the chat scrollport background, or reset to the default. Reads and
 * writes ride the durable settings scope; the pick draft is component-local.
 */
import { useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { BACKGROUND_IMAGE_FIELD, type ChatBackgroundSettings } from '../chat-background-settings.ts'
import type { en } from './locales.ts'
import sectionStyles from './BackgroundSection.module.css'
import './background.module.css'

/** Injected dependencies of {@link BackgroundSection} (slot `inject`). */
export interface BackgroundSectionInjected {
  /** Durable scope carrying the applied background image. */
  scope: SettingsScope<ChatBackgroundSettings>
  /** uSES subscription hook bound to the scope snapshot. */
  useSnapshot: SnapshotSelectorHook<SettingsScopeSnapshot<ChatBackgroundSettings>>
  /** Section copy. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
  /** Largest accepted image size in bytes. */
  maxBytes: number
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type BackgroundSectionProps = Partial<BackgroundSectionInjected>

/** Human-readable size limit used in copy, e.g. "2 MB". */
function formatLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}

/**
 * Guard the inject face: the outlet always supplies every member, but the
 * spread props type stays partial (the ModelsSection precedent).
 * @param props - the inject face spread flat by the slot outlet.
 */
export function BackgroundSection(props: BackgroundSectionProps): ReactElement {
  const { scope, useSnapshot, t, maxBytes } = props
  if (scope === undefined || useSnapshot === undefined || t === undefined || maxBytes === undefined) {
    return <></>
  }
  return (
    <BackgroundSectionLoaded
      scope={scope}
      useSnapshot={useSnapshot}
      t={t}
      maxBytes={maxBytes}
    />
  )
}

/** The section body with a complete inject face. */
function BackgroundSectionLoaded({
  scope, useSnapshot, t, maxBytes,
}: BackgroundSectionInjected): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const snapshot = useSnapshot(snapshot => snapshot)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applied = snapshot.value?.backgroundImage
  const preview = draft ?? applied
  const limit = formatLimit(maxBytes)

  function openPicker(): void {
    inputRef.current?.click()
  }

  function pickImage(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > maxBytes) {
      setError(t('tooLarge', { size: limit }))
      setDraft(null)
      return
    }
    const reader = new FileReader()
    reader.onload = (): void => {
      setDraft(typeof reader.result === 'string' ? reader.result : null)
      setError(null)
    }
    reader.onerror = (): void => {
      setError(t('unreadable'))
      setDraft(null)
    }
    reader.readAsDataURL(file)
  }

  async function applyDraft(): Promise<void> {
    // The Apply button is disabled without a draft, so this guard cannot run.
    /* v8 ignore next -- unreachable through the UI: the button gates on draft */
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await scope.set(BACKGROUND_IMAGE_FIELD, draft)
      setDraft(null)
    } catch {
      setError(t('applyFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function reset(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await scope.unset(BACKGROUND_IMAGE_FIELD)
    } catch {
      setError(t('resetFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={sectionStyles.section}>
      <p className={sectionStyles.intro}>{t('intro')}</p>
      <div className={sectionStyles.previewCard}>
        {preview
          ? <img className={sectionStyles.previewImage} src={preview} alt={t('preview')} />
          : <span className={sectionStyles.emptyPreview}>{t('noBackground')}</span>}
      </div>
      {applied && !draft && <p className={sectionStyles.currentLabel}>{t('current')}</p>}
      {draft && <p className={sectionStyles.currentLabel}>{t('preview')}</p>}
      {error && <p className={sectionStyles.error} role="alert">{error}</p>}
      <input
        ref={inputRef}
        className={sectionStyles.hiddenInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={pickImage}
      />
      <div className={sectionStyles.actions}>
        <Button onClick={openPicker}>{draft ? t('replace') : t('pick')}</Button>
        <Button disabled={!draft || busy} onClick={applyDraft}>
          {busy ? t('applying') : t('apply')}
        </Button>
        <Button disabled={!applied || busy} onClick={reset}>{t('reset')}</Button>
      </div>
      <p className={sectionStyles.hint}>{t('filePickerHint', { size: limit })}</p>
    </section>
  )
}