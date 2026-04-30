import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { CommentsPanelComponent } from '../components/comments-panel.component'
import { IconV2Component } from '../icons/icon-v2.component'
import { DockRailService } from './dock-rail.service'
import { LayoutV2Service } from './layout-v2.service'

// Hosts the body of the right dock panel. Switches by LayoutV2Service.dockActive()
// (info / comment / tree) and reads the single-selected file from
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
            @if (!f.isDir) {
              <div class="dp__kv-row">
                <span l10nTranslate>Size</span>
                <span class="dp__kv-val dp__kv-mono">{{ f.size | toBytes: 2 : true }}</span>
              </div>
            }
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
      } @else if (active() === 'tree') {
        <div class="dp__empty">
          <app-v2-icon name="shareTree" [size]="20" />
          <div class="dp__empty-title" l10nTranslate>Tree view</div>
          <div class="dp__empty-lede" l10nTranslate>Folder tree picker arrives in a later phase.</div>
        </div>
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
        font-size: 14px;
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
        font-size: 11px;
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
        font-size: 13px;

        > span:first-child {
          color: var(--si-fg-faint);
          font-size: 12px;
        }
      }
      .dp__kv-val {
        color: var(--si-fg);
        word-break: break-word;
      }
      .dp__kv-mono {
        font-family: var(--si-mono);
        font-size: 12.5px;
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
        font-size: 14px;
        color: var(--si-fg);
        margin-top: 4px;
      }
      .dp__empty-lede {
        font-size: 12.5px;
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

  protected readonly active = computed(() => this.layoutV2.dockActive())
  protected readonly selected = computed(() => this.dockRail.currentSelected())
  protected readonly headerLabel = computed(() => {
    const id = this.active()
    return this.dockRail.tabs().find((t) => t.id === id)?.label ?? ''
  })
}
