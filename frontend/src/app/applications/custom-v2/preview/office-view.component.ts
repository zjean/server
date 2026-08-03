import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { FILE_MODE } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { EURO_OFFICE_APP_LOCK, ONLY_OFFICE_APP_LOCK } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.constants'
import type { OnlyOfficeReqDto } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.dtos'
import { API_ONLY_OFFICE_SETTINGS } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.routes'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { OnlyOfficeComponent } from '../../files/components/utils/only-office.component'
import { IconV2Component } from '../icons/icon-v2.component'
import type { FileModel } from '../../files/models/file.model'
import { StoreService } from '../../../store/store.service'
import type { OnlyOfficeHistoryEditor, OnlyOfficeHistoryHooks } from '../models/only-office-history.model'
import { EditorHistoryService } from '../services/editor-history.service'
import { VersionsService } from '../services/versions.service'
import { buildFileModelStub } from '../utils/file-model-stub'

// Renders an OnlyOffice editor for an office file (or PDF being toggled into
// edit mode). Owns the lock lifecycle for the duration of the component:
// fetches /api/.../only-office/settings/<path>, mirrors the resulting lock
// onto a FileModel stub so any classic services that look at the file see a
// consistent lock state, and releases the lock on destroy if we own it.
//
// Mirrors classic FilesViewerOnlyOfficeComponent behaviour
// (frontend/src/app/applications/files/components/viewers/files-viewer-only-office.component.ts)
// — same fetch, same applyOfficeLock semantics, same removeLock on destroy.
@Component({
  selector: 'app-v2-preview-office-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OnlyOfficeComponent, IconV2Component, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    @if (loading()) {
      <div class="office-view__state" l10nTranslate>Loading editor…</div>
    } @else if (error(); as err) {
      <div class="office-view__error">
        <div class="office-view__error-card">
          <div class="office-view__error-icon">
            <app-v2-icon name="info" [size]="22" />
          </div>
          <div class="office-view__error-title">{{ err | translate: locale.language : { editor: officeEditorName } }}</div>
          @if (errorDetail(); as detail) {
            <div class="office-view__error-detail">{{ detail }}</div>
          }
          <div class="office-view__error-actions">
            <button type="button" class="office-view__error-btn office-view__error-btn--primary" (click)="retry()" l10nTranslate>Try again</button>
            <a class="office-view__error-btn" [href]="downloadUrl()" download l10nTranslate>Download file</a>
          </div>
        </div>
      </div>
    } @else if (config(); as cfg) {
      <app-files-onlyoffice-document
        class="office-view__doc"
        [id]="docId()"
        [editorName]="officeEditorName"
        [documentServerUrl]="cfg.documentServerUrl"
        [config]="cfg.config"
        [historyHooks]="historyHooks()"
        (loadError)="onLoadError($event)"
        (wasSaved)="onSave()"
      />
    }
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        background: var(--si-bg1);
      }
      .office-view__state {
        padding: var(--si-space-11);
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
      }
      // Was two bare sentences top-left in an otherwise empty full-height
      // canvas, with no icon, no card and no way forward — the least finished
      // surface in v2, and a reachable one (any docserver outage lands here).
      // Now it matches the shared empty-state's visual language and offers the
      // two actions that actually exist at this point: retry, or take the file.
      .office-view__error {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--si-space-11);
      }
      .office-view__error-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 56px var(--si-space-10);
        max-width: 440px;
        background: var(--si-bg3);
        border: 1px dashed var(--si-line-strong);
        border-radius: var(--si-r3);
      }
      .office-view__error-icon {
        width: 48px;
        height: 48px;
        border-radius: 24px;
        background: var(--si-bg3);
        color: var(--si-rose-ink);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: var(--si-space-7);
        border: 1px solid var(--si-line);
      }
      .office-view__error-title {
        font-family: var(--si-display);
        font-size: var(--si-text-11);
        font-weight: 500;
        color: var(--si-fg);
        letter-spacing: -0.1px;
        max-width: 36ch;
      }
      .office-view__error-detail {
        margin-top: var(--si-space-3);
        font-size: var(--si-text-7);
        color: var(--si-fg-muted);
        max-width: 40ch;
      }
      .office-view__error-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: var(--si-space-4);
        margin-top: var(--si-space-9);
      }
      .office-view__error-btn {
        display: inline-flex;
        align-items: center;
        height: 30px;
        padding: 0 var(--si-space-7);
        border-radius: var(--si-r1);
        border: 1px solid var(--si-border);
        background: transparent;
        color: var(--si-fg);
        font: inherit;
        font-size: var(--si-text-8);
        text-decoration: none;
        cursor: pointer;
        transition: background var(--si-dur-2) var(--si-ease-out);
        &:hover {
          background: var(--si-bg3);
        }
        &--primary {
          background: var(--si-accent);
          border-color: var(--si-accent);
          color: var(--si-accent-fg);
          &:hover {
            background: var(--si-accent-hover);
          }
        }
      }
      .office-view__doc {
        display: block;
        width: 100%;
        height: 100%;
      }
    `
  ]
})
export class OfficeViewComponent implements OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly destroyRef = inject(DestroyRef)
  private readonly store = inject(StoreService)
  private readonly versions = inject(VersionsService)
  private readonly editorHistory = inject(EditorHistoryService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  readonly path = input.required<string>()
  readonly file = input.required<FileProps | null>()
  readonly saved = output<void>()

  protected readonly config = signal<OnlyOfficeReqDto | null>(null)
  protected readonly loading = signal(false)

  // Direct file URL, so the error card can offer "Download file" — the one
  // thing that still works when the document server is unreachable.
  protected readonly downloadUrl = computed(() => {
    const p = this.path()
    return p ? `${API_FILES_OPERATION}/${encodeUrl(p)}` : ''
  })

  // Re-runs the settings fetch that failed. loadSettings() already resets
  // error/errorDetail/config and re-acquires the lock, so this needs no
  // teardown of its own.
  protected retry(): void {
    const p = this.path()
    const f = this.file()
    if (!p || !f) return
    this.loadSettings(p, f)
  }
  protected readonly error = signal<string | null>(null)
  // Untranslated technical detail shown under the localized headline. Only the
  // editor-load path sets it; see onLoadError for why it is not a i18n key.
  protected readonly errorDetail = signal<string | null>(null)
  protected readonly docId = computed(() => `v2-preview-doc-${this.file()?.id ?? 'none'}`)
  // Editor label shown in OnlyOfficeComponent's load/init error messages.
  // Mirrors classic FilesViewerOnlyOfficeComponent.officeEditorName — picks
  // OnlyOffice vs Euro-Office based on the server's configured editor.
  // Upstream 2.4.1 made `editorName` a required input on OnlyOfficeComponent
  // (commit 98031da3, dynamic editor naming).
  protected readonly officeEditorName = this.store.server().files.editors.onlyoffice ? ONLY_OFFICE_APP_LOCK : EURO_OFFICE_APP_LOCK

  /**
   * The editor's own version-history panel, or nothing.
   *
   * Four conditions, all required, and the last two are the interesting ones:
   *
   *  - the feature is on. `availability` latches one-way off a real call, so a
   *    server with `files.versions.enabled` false never offers the panel. The
   *    probe below is what settles it.
   *  - the session is EDITABLE. A read-only session that offers Restore is worse
   *    than no panel at all: the button is there, and the server refuses it. The
   *    backend route carries MODIFY, so this gate is the honest UI, not the
   *    security boundary.
   *  - the config carries an ONLY_OFFICE token. Without it, every url we would
   *    hand the document server is one it cannot fetch, so the panel would open
   *    and render nothing — better to not offer it.
   *  - `historyHooks` is UNDEFINED, not an empty object, when any of those fail.
   *    OnlyOfficeComponent spreads whatever it is given into `config.events`, and
   *    the editor decides whether to show the affordance by whether
   *    `onRequestHistory` exists.
   *
   * Left unset by the CLASSIC viewer (`files-viewer-only-office.component.ts`),
   * which shares the same component — a deliberate scope line for this feature,
   * not an oversight.
   */
  protected readonly historyHooks = computed<OnlyOfficeHistoryHooks | undefined>(() => {
    const cfg = this.config()
    if (!cfg || this.versions.availability() !== 'available') return undefined
    if (cfg.config?.editorConfig?.mode === FILE_MODE.VIEW) return undefined
    const officeToken = this.editorHistory.officeTokenFrom(cfg.config?.document?.url)
    if (!officeToken) return undefined
    return this.editorHistory.hooksFor({
      spacePath: this.path(),
      officeToken,
      // Resolved on every call rather than captured: the instance is replaced
      // whenever this component re-mounts the editor, which reloadEditor() does
      // right after a restore.
      editor: () => window.DocEditor?.instances?.[this.docId()] as OnlyOfficeHistoryEditor | undefined,
      locale: this.locale.language,
      onRestored: () => this.reloadEditor(),
      // Closing the panel needs the same re-mount, for a different reason: the
      // editor enters history mode read-only and the document server publishes
      // no command to leave it, so reinitializing is the only way back to an
      // editable document (#408).
      onHistoryClosed: () => this.reloadEditor()
    })
  })

  // FileModel stub — bridges to classic services (lock-aware) for the
  // duration of this view. Held outside signals so destroy can release the
  // lock without re-running computeds.
  private fileStub: FileModel | null = null
  // Tracks the last (path, fileId) pair that triggered a load so that
  // metadata-only parent updates (e.g. hasComments toggled via the comment
  // panel emitting hasCommentsChange → file.set({...f, hasComments}) creating
  // a new object reference) do not cause the editor to reload.
  private loadedKey = ''

  constructor() {
    // (Re-)load whenever the path or file identity changes. Cancels in-flight
    // HTTP via takeUntilDestroyed; effect itself is signal-driven.
    //
    // The seed/HTTP block is wrapped in untracked() because releaseLock()
    // reads this.config() and the success handler writes this.config.set(cfg).
    // Without the wrap, the second-and-subsequent effect runs (when
    // fileStub is no longer null on entry, so releaseLock proceeds past
    // its early-return) would track config as a dependency, and then the
    // HTTP success handler's config.set(cfg) would dirty the effect and
    // re-run it — firing the same /settings/<path> GET in an infinite
    // loop. Manifests as "OnlyOffice editor stuck on Loading…, lots of
    // network calls" for any existing doc whose FileProps reference is
    // refreshed by the parent after first mount (e.g. when the file list
    // refreshes after an NC PROPFIND inserts a real DB row in place of
    // the previously inode-derived placeholder id).
    //
    // See the project memory note "Angular effect signal writes need
    // untracked()" for the same pattern.
    effect(() => {
      const p = this.path()
      const f = this.file()
      if (!p || !f) return
      const key = `${p}::${f.id ?? ''}`
      if (key === this.loadedKey) return
      this.loadedKey = key
      untracked(() => this.loadSettings(p, f))
    })
  }

  // Extracted from the effect so a restore can re-run it directly — see
  // reloadEditor. Everything a caller must not do inside a tracked context (it
  // reads config() through releaseLock and writes it on success) is why the
  // effect calls this inside untracked().
  private loadSettings(p: string, f: FileProps): void {
    this.releaseLock()
    this.fileStub = buildFileModelStub(f, p)
    this.config.set(null)
    this.error.set(null)
    this.errorDetail.set(null)
    this.loading.set(true)
    // Settles `availability` once per session so historyHooks can decide whether
    // to offer the panel at all. A no-op after the first answer.
    this.versions.probe(p)
    this.http
      .get<OnlyOfficeReqDto>(`${API_ONLY_OFFICE_SETTINGS}/${p}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cfg) => {
          this.loading.set(false)
          if (!cfg) {
            this.error.set('v2_office_settings_missing')
            this.config.set(null)
            return
          }
          this.applyOfficeLock(cfg)
          this.config.set(cfg)
        },
        error: (e: HttpErrorResponse) => {
          this.loading.set(false)
          this.config.set(null)
          this.error.set(e.status === 404 ? 'v2_office_unavailable' : (e.error?.message ?? 'v2_office_load_failed'))
        }
      })
  }

  /**
   * Tears the editor down and re-opens it against a freshly fetched config.
   *
   * Called from both in-editor history events, and REQUIRED rather than tidy in
   * each — for two unrelated reasons:
   *
   *  - after a RESTORE, because it replaces the live bytes and drops the cached
   *    OnlyOffice document key server-side (invariant 7, #378) while the config
   *    held by this page still carries the OLD key. Without a re-open the editor
   *    goes on editing pre-restore content under a key the document server still
   *    honours, and the next save writes that content back over the restore.
   *  - after the panel is CLOSED, because the editor entered history mode
   *    read-only and the document server publishes no command to leave it. The
   *    Docs API is explicit that the integrator must reinitialize in editing
   *    mode; without it the panel stays open over a document that can no longer
   *    be edited (#408).
   *
   * Clearing `config` unmounts OnlyOfficeComponent, whose ngOnDestroy destroys
   * the DocEditor instance; the new config mounts a fresh one with the new key.
   * `loadedKey` is reset because the (path, fileId) pair has not changed, so the
   * effect would otherwise treat the reload as a duplicate.
   *
   * Upstream reloads the whole page for this (`editor.js:268`). Here that would
   * throw away the surrounding SPA.
   */
  private reloadEditor(): void {
    const p = this.path()
    const f = this.file()
    if (!p || !f) return
    this.loadedKey = ''
    this.loadSettings(p, f)
    this.loadedKey = `${p}::${f.id ?? ''}`
  }

  ngOnDestroy(): void {
    this.releaseLock()
    this.loadedKey = ''
  }

  protected onSave(): void {
    this.fileStub?.updateHTimeAgo?.()
    this.saved.emit()
  }

  // The document server's api.js failed to load, or DocsAPI never showed up.
  // Without this binding the emitted error went nowhere and the pane stayed
  // permanently blank — the `error()` signal is only otherwise set by the
  // /settings HTTP path, which had already succeeded by this point (#376).
  //
  // OnlyOfficeComponent hands over an already-interpolated English title+message
  // pair and never exposes the numeric error code (only-office.component.ts:79-93),
  // so the code cannot be mapped to one of our own keys. Instead the headline
  // comes from `v2_office_load_failed` — which carries the `{{ editor }}`
  // placeholder, so it names OnlyOffice or Euro-Office per the server config and
  // stays translatable — and the emitted `message` is surfaced verbatim beneath
  // it as technical detail. Classic shows both of these strings untranslated too
  // (it forwards them straight to sendNotification), so the detail line is
  // parity rather than a regression.
  //
  // Releasing the lock mirrors classic's net effect: classic closes the whole
  // dialog on this error, and its ngOnDestroy drops the lock. No server-side
  // editor session exists — the editor never loaded — so leaving the stub lock
  // in place would show the file as locked-by-me for something that isn't open.
  protected onLoadError(e: { title: string; message: string }): void {
    this.releaseLock()
    this.error.set('v2_office_load_failed')
    this.errorDetail.set(e.message)
  }

  // Mirrors classic FilesViewerOnlyOfficeComponent.ngOnInit lock handling.
  private applyOfficeLock(cfg: OnlyOfficeReqDto): void {
    const stub = this.fileStub
    if (!stub) return
    if (cfg.hasLock && !stub.lock) {
      stub.createLock(cfg.hasLock)
    }
    const isReadonly = cfg.config?.editorConfig?.mode === FILE_MODE.VIEW
    if (!isReadonly && !stub.lock) {
      const u = this.store.user.getValue()
      stub.createLock({
        owner: { login: u?.login ?? '', fullName: u?.fullName ?? '', email: u?.email ?? '' },
        app: this.store.server().files.editors.onlyoffice ? ONLY_OFFICE_APP_LOCK : EURO_OFFICE_APP_LOCK,
        isExclusive: false
      })
    }
  }

  // Release the in-memory lock on the stub when this view goes away —
  // matches classic FilesViewerOnlyOfficeComponent.ngOnDestroy. Keeps the
  // client-side picture consistent with the user's mental model (file
  // unlocked once they close the editor). Server-side OnlyOffice locks are
  // managed by the document server's own session lifecycle.
  private releaseLock(): void {
    const stub = this.fileStub
    if (!stub) return
    const cfg = this.config()
    const isReadonly = cfg?.config?.editorConfig?.mode === FILE_MODE.VIEW
    const me = this.store.user.getValue()?.login
    if (!isReadonly && stub.lock && stub.lock.owner.login === me) {
      stub.removeLock()
    }
    this.fileStub = null
  }
}
