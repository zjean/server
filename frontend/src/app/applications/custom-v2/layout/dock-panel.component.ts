import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { CommentsPanelComponent } from '../components/comments-panel.component'
import { IconV2Component } from '../icons/icon-v2.component'
import { DockRailService } from './dock-rail.service'
import { LayoutV2Service } from './layout-v2.service'

type FolderSizeState = { kind: 'loading' } | { kind: 'loaded'; size: number } | { kind: 'error' }

// Hosts the body of the right dock panel. Switches by LayoutV2Service.dockActive()
// (info / comment) and reads the single-selected file from
// DockRailService.currentSelected(). When nothing is selected, renders a
// scoped empty state instead of letting the inner components break.
@Component({
  selector: 'app-v2-dock-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommentsPanelComponent, IconV2Component, ToBytesPipe, TimeAgoPipe, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="dp">
      <header class="dp__head">{{ headerLabel() | translate: locale.language }}</header>
      @if (active() === 'info') {
        @if (selected(); as f) {
          <section class="dp__kv">
            <div class="dp__kv-title" l10nTranslate>Properties</div>
            <div class="dp__kv-row">
              <span l10nTranslate>Name</span>
              <span class="dp__kv-val">{{ f.name }}</span>
            </div>
            <div class="dp__kv-row">
              <span l10nTranslate>Type</span>
              <span class="dp__kv-val">{{ f.mime }}</span>
            </div>
            <div class="dp__kv-row">
              <span l10nTranslate>Size</span>
              @if (!f.isDir) {
                <span class="dp__kv-val dp__kv-mono">{{ f.size | toBytes: 2 : true }}</span>
              } @else {
                @let resolved = folderSizeBytes();
                @if (resolved !== null) {
                  <span class="dp__kv-val dp__kv-mono">{{ resolved | toBytes: 2 : true }}</span>
                } @else if (isFolderSizeLoading()) {
                  <span class="dp__kv-val dp__kv-faint" l10nTranslate>Loading…</span>
                } @else {
                  <span class="dp__kv-val dp__kv-mono dp__kv-faint">●</span>
                }
              }
            </div>
            <div class="dp__kv-row">
              <span l10nTranslate>Location</span>
              <span class="dp__kv-val">{{ f.path }}</span>
            </div>
            @if (f.mtime) {
              <div class="dp__kv-row">
                <span l10nTranslate>Modified</span>
                <span class="dp__kv-val">{{ f.mtime | amTimeAgo }}</span>
              </div>
            }
            @if (f.ctime) {
              <div class="dp__kv-row">
                <span l10nTranslate>Created</span>
                <span class="dp__kv-val">{{ f.ctime | amTimeAgo }}</span>
              </div>
            }
          </section>
        } @else {
          <div class="dp__empty">
            <app-v2-icon name="info" [size]="20" />
            <div class="dp__empty-title" l10nTranslate>Select a file to see details</div>
            <div class="dp__empty-lede" l10nTranslate>Click a row to inspect its properties.</div>
          </div>
        }
      } @else if (active() === 'comment') {
        @if (selected(); as f) {
          @if (!f.isDir) {
            <app-v2-comments-panel [filePath]="f.path" [fileId]="f.id" />
          } @else {
            <div class="dp__empty">
              <app-v2-icon name="comment" [size]="20" />
              <div class="dp__empty-title" l10nTranslate>Comments are file-only</div>
              <div class="dp__empty-lede" l10nTranslate>Pick a file (not a folder) to read or post comments.</div>
            </div>
          }
        } @else {
          <div class="dp__empty">
            <app-v2-icon name="comment" [size]="20" />
            <div class="dp__empty-title" l10nTranslate>No comments to show</div>
            <div class="dp__empty-lede" l10nTranslate>Select a file to see its comment thread.</div>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        min-width: 0;
      }
      .dp {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        font-family: var(--si-sans);
        color: var(--si-fg);
      }
      .dp__head {
        flex: 0 0 auto;
        padding: 14px 18px;
        font-family: var(--si-display);
        font-weight: 600;
        font-size: var(--si-text-10);
        letter-spacing: -0.01em;
        color: var(--si-fg);
        text-transform: capitalize;
        border-bottom: 1px solid var(--si-line);
      }
      .dp__kv {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 14px 18px 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .dp__kv-title {
        font-size: var(--si-text-4);
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--si-fg-faint);
        margin-bottom: 2px;
      }
      .dp__kv-row {
        display: grid;
        grid-template-columns: 92px 1fr;
        align-items: baseline;
        gap: 12px;
        font-size: var(--si-text-8);

        > span:first-child {
          color: var(--si-fg-faint);
          font-size: var(--si-text-6);
        }
      }
      .dp__kv-val {
        color: var(--si-fg);
        word-break: break-word;
      }
      .dp__kv-mono {
        font-family: var(--si-mono);
        font-size: var(--si-text-7);
      }
      .dp__kv-faint {
        color: var(--si-fg-faint);
      }
      .dp__empty {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 32px 18px;
        text-align: center;
        color: var(--si-fg-muted);
      }
      .dp__empty-title {
        font-family: var(--si-display);
        font-weight: 500;
        font-size: var(--si-text-10);
        color: var(--si-fg);
        margin-top: 4px;
      }
      .dp__empty-lede {
        font-size: var(--si-text-7);
        color: var(--si-fg-faint);
        max-width: 220px;
        line-height: 1.45;
      }
    `
  ]
})
export class DockPanelComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly layoutV2 = inject(LayoutV2Service)
  private readonly dockRail = inject(DockRailService)
  private readonly http = inject(HttpClient)
  private readonly destroyRef = inject(DestroyRef)

  // Per-folder recursive size cache. Keyed by file id so reselecting the same
  // folder reuses the resolved value instead of re-walking the subtree.
  // Mirrors classic's getSizeLazy + shareReplay pattern in
  // files-selection.component.ts:99-108.
  private readonly folderSizes = signal<Map<number, FolderSizeState>>(new Map())

  protected readonly active = computed(() => this.layoutV2.dockActive())
  protected readonly selected = computed(() => this.dockRail.currentSelected())
  protected readonly headerLabel = computed(() => {
    const id = this.active()
    return this.dockRail.tabs().find((t) => t.id === id)?.label ?? ''
  })

  private readonly folderSizeState = computed<FolderSizeState | undefined>(() => {
    const f = this.selected()
    if (!f || !f.isDir) return undefined
    return this.folderSizes().get(f.id)
  })

  protected readonly folderSizeBytes = computed<number | null>(() => {
    const st = this.folderSizeState()
    return st?.kind === 'loaded' ? st.size : null
  })

  protected readonly isFolderSizeLoading = computed<boolean>(() => this.folderSizeState()?.kind === 'loading')

  constructor() {
    // Lazy-fetch the recursive folder size when the user opens Info on a
    // folder. Backend GET /api/files/operation/getSize/{path} does a recursive
    // fs walk per call (no cache; see issue #205 deferral), so we only trigger
    // it on explicit user inspection — never as part of a listing.
    effect(() => {
      if (this.active() !== 'info') return
      const f = this.selected()
      if (!f || !f.isDir) return
      const cached = this.folderSizes().get(f.id)
      if (cached) return
      untracked(() => this.fetchFolderSize(f.id, f.path))
    })
  }

  private fetchFolderSize(id: number, path: string): void {
    this.setSizeState(id, { kind: 'loading' })
    this.http
      .get<{ size: number }>(`${API_FILES_OPERATION}/${FILE_OPERATION.GET_SIZE}/${encodeUrl(path)}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.setSizeState(id, { kind: 'loaded', size: r.size }),
        error: (_e: HttpErrorResponse) => this.setSizeState(id, { kind: 'error' })
      })
  }

  private setSizeState(id: number, state: FolderSizeState): void {
    this.folderSizes.update((m) => {
      const next = new Map(m)
      next.set(id, state)
      return next
    })
  }
}
