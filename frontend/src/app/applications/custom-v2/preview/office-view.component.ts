import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { FILE_MODE } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { ONLY_OFFICE_APP_LOCK } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.constants'
import type { OnlyOfficeReqDto } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.dtos'
import { API_ONLY_OFFICE_SETTINGS } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.routes'
import { OnlyOfficeComponent } from '../../files/components/utils/only-office.component'
import type { FileModel } from '../../files/models/file.model'
import { StoreService } from '../../../store/store.service'
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
  imports: [OnlyOfficeComponent, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    @if (loading()) {
      <div class="office-view__state" l10nTranslate>Loading editor…</div>
    } @else if (error(); as err) {
      <div class="office-view__error">{{ err | translate: locale.language }}</div>
    } @else if (config(); as cfg) {
      <app-files-onlyoffice-document
        class="office-view__doc"
        [id]="docId()"
        [documentServerUrl]="cfg.documentServerUrl"
        [config]="cfg.config"
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
      .office-view__state,
      .office-view__error {
        padding: 24px;
        font-size: 13px;
        color: var(--si-fg-muted);
      }
      .office-view__error {
        color: var(--si-fg);
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
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  readonly path = input.required<string>()
  readonly file = input.required<FileProps | null>()
  readonly saved = output<void>()

  protected readonly config = signal<OnlyOfficeReqDto | null>(null)
  protected readonly loading = signal(false)
  protected readonly error = signal<string | null>(null)
  protected readonly docId = computed(() => `v2-preview-doc-${this.file()?.id ?? 'none'}`)

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
      untracked(() => {
        this.releaseLock()
        this.fileStub = buildFileModelStub(f, p)
        this.config.set(null)
        this.error.set(null)
        this.loading.set(true)
        this.http
          .get<OnlyOfficeReqDto>(`${API_ONLY_OFFICE_SETTINGS}/${p}`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (cfg) => {
              this.loading.set(false)
              if (!cfg) {
                this.error.set('OnlyOffice settings are missing.')
                this.config.set(null)
                return
              }
              this.applyOfficeLock(cfg)
              this.config.set(cfg)
            },
            error: (e: HttpErrorResponse) => {
              this.loading.set(false)
              this.config.set(null)
              this.error.set(
                e.status === 404 ? 'OnlyOffice is not available on this server.' : (e.error?.message ?? 'Failed to load OnlyOffice editor.')
              )
            }
          })
      })
    })
  }

  ngOnDestroy(): void {
    this.releaseLock()
    this.loadedKey = ''
  }

  protected onSave(): void {
    this.fileStub?.updateHTimeAgo?.()
    this.saved.emit()
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
        app: ONLY_OFFICE_APP_LOCK,
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
