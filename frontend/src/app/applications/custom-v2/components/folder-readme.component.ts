import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { SPACE_OPERATION } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { TiptapEditorDirective } from 'ngx-tiptap'
import { firstValueFrom } from 'rxjs'
import { buildFileModelStub } from '../utils/file-model-stub'
import { pickFolderReadme } from '../utils/folder-readme'

// Renders a folder's Readme.md above the file listing, like Nextcloud's Rich
// Workspaces. Detection is a pure function over the files[] the host screen
// already loaded, so this costs one content GET and no extra listing request.
// See docs/plans/2026-07-28-v2-folder-readme-design.md.
@Component({
  selector: 'app-v2-folder-readme',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TiptapEditorDirective, L10nTranslatePipe],
  template: `
    @if (readme(); as file) {
      <section class="fr">
        <header class="fr__head">
          <span class="fr__name">{{ file.name }}</span>
        </header>

        @if (loadError(); as err) {
          <div class="fr__error">{{ err | translate: locale.language }}</div>
        } @else {
          <div class="fr__read v2-prose">
            <tiptap-editor [editor]="editor"></tiptap-editor>
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .fr {
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 12px;
        padding: 12px 16px;
        margin-bottom: 12px;
      }
      .fr__head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .fr__name {
        font-size: 12px;
        color: var(--si-fg-muted);
        /* --si-mono is the token (_tokens.scss:114). There is no
           --si-font-mono. */
        font-family: var(--si-mono, ui-monospace, monospace);
      }
      .fr__error {
        font-size: 13px;
        /* --si-rose is v2's error colour (_tokens.scss:95, used the same way in
           action-sheet.component.ts). There is no --si-danger. */
        color: var(--si-rose, #ff6c5d);
      }
      .fr__read ::ng-deep .ProseMirror {
        outline: none;
      }
    `
  ]
})
export class FolderReadmeComponent {
  private readonly http = inject(HttpClient)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  readonly dirPath = input.required<string>()
  readonly files = input.required<readonly FileProps[]>()
  readonly permissions = input.required<string>()
  // Emitted when the host listing is stale and should reload (wired in Task 4).
  readonly changed = output<void>()

  protected readonly readme = computed(() => pickFolderReadme(this.files()))
  protected readonly loadError = signal<string | null>(null)

  // One editor for the component's lifetime, content swapped on navigation.
  // The host screens reload in place on folder change (personal.component.ts:327,
  // space-files.component.ts:311) so this component is NOT recreated per folder —
  // constructing a ProseMirror instance per folder visit would be wasted work.
  protected readonly editor = new Editor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: true }),
      Markdown
    ],
    editable: false,
    content: '',
    contentType: 'markdown'
  })

  protected readonly writeable = computed(() => {
    const file = this.readme()
    if (!file) return false
    // Classic's contract, verbatim: files.service.ts:314.
    return this.permissions().includes(SPACE_OPERATION.MODIFY) && !file.lock?.isExclusive
  })

  constructor() {
    effect(() => {
      const file = this.readme()
      const dir = this.dirPath()
      if (!file || !dir) {
        untracked(() => {
          // Reset the cache key too: without this, re-entering a folder whose
          // readme is unchanged hits the early-return in load() while the
          // content has already been blanked, leaving an empty banner.
          this.lastLoadKey = null
          this.setContent('')
        })
        return
      }
      // Re-fetch when the resolved file changes identity OR content: mtime
      // moves on every save, including saves made elsewhere.
      const key = `${file.id}:${file.mtime}`
      untracked(() => this.load(dir, file, key))
    })
  }

  private lastLoadKey: string | null = null

  private async load(dir: string, file: FileProps, key: string): Promise<void> {
    if (key === this.lastLoadKey) return
    this.lastLoadKey = key
    this.loadError.set(null)
    const stub = buildFileModelStub(file, `${dir}/${file.name}`)
    try {
      const text = await firstValueFrom(this.http.get(stub.dataUrl, { responseType: 'text' }))
      // Superseded while in flight — a newer folder's load already owns the view.
      if (this.lastLoadKey !== key) return
      this.setContent(text ?? '')
    } catch (e) {
      if (this.lastLoadKey !== key) return
      const err = e as HttpErrorResponse
      this.setContent('')
      this.loadError.set(err?.error?.message ?? err?.statusText ?? 'Failed to load folder description')
    }
  }

  private setContent(markdown: string): void {
    if (this.editor.isDestroyed) return
    this.editor.commands.setContent(markdown, { emitUpdate: false, contentType: 'markdown' })
  }
}
