# Folder Readme Banner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a folder's `Readme.md` above the file listing in the v2 browse screens, with an inline editor entered
by an explicit Edit button.

**Architecture:** One self-contained `<app-v2-folder-readme>` component plus one pure helper, wired into
`PersonalComponent` and `SpaceFilesComponent` with a single template line each. Detection is a pure function over the
`files[]` array the screens already load — no backend work, no new endpoint. Read mode renders through a TipTap editor
held in `editable: false`; Edit mode mounts the existing `MarkdownViewComponent`, whose lock-on-open behaviour is
correct precisely because it only mounts after a deliberate click.

**Tech Stack:** Angular 20 (standalone components, signals, `OnPush`), TipTap 3 (`@tiptap/core`, `@tiptap/markdown`,
already a dependency), `ngx-tiptap`, angular-l10n, SCSS with the `--si-*` token ramp.

**Spec:** [`2026-07-28-v2-folder-readme-design.md`](2026-07-28-v2-folder-readme-design.md). Where this plan and the
design disagree, **the design is right** — fix the plan.

---

## Global Constraints

- **No backend changes.** Nothing under `backend/` is touched. No new endpoint, no config key, no migration.
- **No upstream frontend files are modified.** All work lands under
  `frontend/src/app/applications/custom-v2/` plus the two custom i18n bundles. Do not edit
  `frontend/src/i18n/{en,nl}.json` — fork keys go in `frontend/src/i18n/custom/{en,nl}.json` (`CLAUDE.md`).
- **i18n key convention:** plain-English literal as the key for short static strings; `v2_`-prefixed snake_case only
  for parameterised strings. Every key added to `en.json` must also be added to `nl.json` — both files currently hold
  exactly 200 keys and must stay in lockstep.
- **There is no frontend test runner.** `frontend/src` contains zero `.spec.ts` files and `frontend/package.json` has
  no test script. **Do not introduce one** — it is explicitly out of scope. The verification cycle for every task is:

  ```bash
  npm run -w frontend lint
  npm run -w frontend build
  ```

  plus the task's named browser check. Task 7 runs the full matrix.
- **Browser verification** follows the `v2-dev-loop-verify` skill: build the frontend, let the backend serve it on
  `:8080` (single origin — **not** `ng serve`), drive with `agent-browser` (**not** the chrome-devtools MCP; Chrome is
  not installed). Login `sync-in` / `password`. Reach v2 via `/#/v2/<route>`.
- **Branch:** `feat/v2-folder-readme`, already created in the worktree at `.claude/worktrees/feat+v2-folder-readme`,
  based on `origin/main` @ `aa0648a1`. The design doc is already committed there as `2065463d`.
- **Commit prefixes:** `feat(v2): …` for new banner code, `mod(v2): …` for the `markdown-view.component.ts` edits
  (it is a fork-authored file, but the table in `CLAUDE.md` reserves `mod(` for edits to existing files — use
  `feat(v2):` since this file is fork-authored, not upstream).
- **Do not `git push` or open a PR** during task execution. The maintainer decides when.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `custom-v2/utils/folder-readme.ts` | **Create.** `pickFolderReadme(files)` — pure detection, no I/O. | 2 |
| `custom-v2/components/folder-readme.component.ts` | **Create.** The banner: detection → fetch → read render → collapse → edit swap. | 2, 3, 4 |
| `custom-v2/styles/_prose.scss` | **Create.** Shared `.v2-prose` markdown typography, `@use`d by `v2.scss`. | 2 |
| `custom-v2/styles/v2.scss` | **Modify.** One `@use './prose';` line. | 2 |
| `custom-v2/preview/markdown-view.component.ts` | **Modify.** Additive `inline` input, `(done)` + `(saved)` outputs. | 1 |
| `custom-v2/screens/personal/personal.component.{ts,html}` | **Modify.** `permissions` signal, `currentUploadRoute` → protected, `viewChild`, one template line, two `case`s. | 2, 5 |
| `custom-v2/screens/space/space-files.component.{ts,html}` | **Modify.** Same, but **one** `case` (its FAB delegates). | 2, 5 |
| `custom-v2/screens/files/new-entry-menu.ts` | **Modify.** `'new-folder-description'` in the type + both builders. | 5 |
| `frontend/src/i18n/custom/{en,nl}.json` | **Modify.** 6 keys. | 2, 3, 5 |

**Why the banner is one file, not three.** Detection is already split out as a pure helper (independently readable,
and the only part with branching logic worth reading in isolation). Splitting read-mode and edit-mode into separate
components would force the lock-release-on-folder-change logic (§5 of the design — the correctness crux) to live in a
parent coordinating two children, which is strictly harder to get right than one component owning both modes. The
finished file lands around 300 lines, well inside the range of the other `custom-v2/components/*` files.

---

## Task 1: Make `MarkdownViewComponent` embeddable

Additive only. `FileDetailComponent` must behave identically after this task — that is the thing being verified.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/preview/markdown-view.component.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: three new bindings on `<app-v2-preview-markdown-view>`, all optional:
  - `inline: boolean` (default `false`) — renders a Cancel control and relaxes the fill-the-stage sizing.
  - `(done)` → `void` — emitted after the user confirms leaving edit mode (Cancel accepted, or Save-then-Cancel).
  - `(saved)` → `void` — emitted on each successful save.
  - Public method `requestClose(): Promise<boolean>` — runs the existing `canClose()` confirm; resolves `true` if the
    caller may tear the component down. Task 4 calls this on folder change.

- [ ] **Step 1: Add the input, outputs, and `requestClose`**

In the class body, next to the existing inputs at `markdown-view.component.ts:454-456`:

```ts
  readonly path = input.required<string>()
  readonly file = input.required<FileProps | null>()
  readonly isWriteable = input<boolean>(true)
  // Inline mode: the component is embedded in a bounded container (the folder
  // readme banner) rather than filling the file-detail stage. Adds a Cancel
  // control and drops the height:100% assumption.
  readonly inline = input<boolean>(false)
  readonly done = output<void>()
  readonly saved = output<void>()
```

Add `output` to the existing `@angular/core` import at line 3.

Then add the public close hook next to `canClose` (which is at `:668` and stays `private`):

```ts
  // Lets an embedding parent run the unsaved-changes confirm without
  // reimplementing it. Returns true when the parent may destroy this view.
  async requestClose(): Promise<boolean> {
    return this.canClose()
  }
```

- [ ] **Step 2: Emit `saved` on a successful save**

In `save()`, inside the `next` handler (currently ends with the `toast.success` call):

```ts
      next: () => {
        this.savedContent = content
        if (this.sourceMode()) this.sourceContent.set(content)
        this.saving.set(false)
        this.isModified.set(false)
        this.toast.success('v2_saved_one', { name: this.stub!.name })
        this.saved.emit()
      },
```

- [ ] **Step 3: Add the Cancel control, shown only in inline mode**

In the template header, immediately before the existing Save button:

```html
        @if (inline()) {
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ 'Cancel' | translate: locale.language }}
          </app-v2-btn>
        }
```

And the handler, next to `save()`:

```ts
  protected async cancel(): Promise<void> {
    if (!(await this.canClose())) return
    this.done.emit()
  }
```

**Add no i18n key for `Cancel`, and do not go looking for one in `custom/en.json` — it is not there.** The only
definition anywhere is upstream `frontend/src/i18n/nl.json:19` (`"Cancel": "Annuleren"`). English has no entry, so the
lookup misses and angular-l10n's missing-translation handler returns the key literal — which is already correct
English. Both languages therefore render properly with no new key. **Do not add `Cancel` to the upstream bundles** to
"fix" the asymmetry; editing `frontend/src/i18n/{en,nl}.json` is forbidden by Global Constraints.

- [ ] **Step 4: Make the sizing inline-aware**

The host currently hard-codes `height: 100%` (`:243`) and the source editor is absolutely positioned (`:334`), both of
which assume a filling parent. Add a modifier class rather than changing the existing rules:

In the template, on the root `div.md-view`:

```html
    <div class="md-view" [class.md-view--inline]="inline()">
```

And in `styles`, appended after the existing `.md-view__source` rules:

```css
      /* Inline mode (folder readme banner): the parent sets a bounded height, so
         the source editor must drop out of absolute positioning — inset:0
         against a bounded parent collapses it to zero height. */
      .md-view--inline .md-view__source {
        position: static;
        inset: auto;
        min-height: 180px;
      }
```

**Do not also add `.md-view--inline .md-view__body { overflow: auto }`.** An earlier revision of this plan did, and it
was dead code: `.md-view__body` already sets `overflow: auto` unconditionally at `:331-337`, so the inline-scoped rule
changed nothing while its comment claimed to enable internal scrolling. The `.md-view__source` rule is the only
load-bearing part. (Corrected after Task 1's review caught it.)

**Do not add a `height` to `.md-view__source` either.** It is deliberately left with only `min-height`, and the
consequence is a known open question rather than a settled design: `.cm-editor { height: 100% }` at `:343-345` needs a
definite height on its containing block, which `min-height` does not establish, so CodeMirror's source mode may render
oddly short or tall once inline mode has a real consumer. **Task 4's browser check must exercise source mode inside the
banner explicitly** and report what it sees; picking a height before observing it would be guesswork.

- [ ] **Step 5: Verify nothing regressed for `file-detail`**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Then browser-verify per the `v2-dev-loop-verify` skill, confirming the **unchanged** path:

1. Navigate to a folder containing any `.md` file and open it (this reaches `FileDetailComponent`, which mounts
   `<app-v2-preview-markdown-view>` at `file-detail.component.html:61` without `inline`).
2. Expected: no Cancel button (it is gated on `inline()`, default `false`); editor fills the stage as before; the
   source-mode toggle still shows a full-height CodeMirror.
3. Edit a character, Save. Expected: "Saved" status, success toast.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/applications/custom-v2/preview/markdown-view.component.ts
git commit -m "feat(v2): make the markdown editor embeddable

Adds an optional inline input plus done/saved outputs and a public
requestClose() that runs the existing unsaved-changes confirm. All
additive and defaulted, so file-detail is unaffected.

Prepares the editor for the folder readme banner, which needs a Cancel
control, a save notification to refresh the listing row, and a way to
release the lock when the user changes folder."
```

---

## Task 2: Detection + read-only banner

Ends with a rendered readme above the listing in both browse screens. No Edit button yet, no collapse yet.

**Files:**
- Create: `frontend/src/app/applications/custom-v2/utils/folder-readme.ts`
- Create: `frontend/src/app/applications/custom-v2/components/folder-readme.component.ts`
- Create: `frontend/src/app/applications/custom-v2/styles/_prose.scss`
- Modify: `frontend/src/app/applications/custom-v2/styles/v2.scss`
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts` (+`.html`)
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts` (+`.html`)
- Modify: `frontend/src/i18n/custom/{en,nl}.json`

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces:
  - `pickFolderReadme(files: readonly FileProps[]): FileProps | null`
  - `FOLDER_README_NAMES: readonly string[]` — the precedence list, exported for the menu-gating check in Task 5.
  - `<app-v2-folder-readme>` with inputs `dirPath: string`, `files: readonly FileProps[]`, `permissions: string`, and
    output `(changed)` → `void` (emitted when the listing needs reloading; wired in Task 4, declared now so the host
    template line is written once).

- [ ] **Step 1: Write the detection helper**

Create `custom-v2/utils/folder-readme.ts`:

```ts
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'

// Nextcloud's list and precedence order, from nextcloud/text
// lib/Service/WorkspaceService.php (SUPPORTED_STATIC_FILENAMES), minus two
// entries — see the design doc §2:
//   - '.Readme.md' is omitted: spaces-browser.service.ts:137 strips dotfiles
//     unless files.showHiddenFiles is on, and it defaults to false, so a hidden
//     readme is never in the browse response to be found.
//   - the l10n-translated 'Readme.md' variant is omitted: nobody names the file
//     'Leesmij.md'.
// Comparison is exact-case, matching upstream.
export const FOLDER_README_NAMES: readonly string[] = ['Readme.md', 'README.md', 'readme.md']

// Returns the folder's readme, or null. Directories are excluded: a directory
// named README.md is legal, and upstream guards the same case
// (getMimeType() !== ICacheEntry::DIRECTORY_MIMETYPE).
export function pickFolderReadme(files: readonly FileProps[]): FileProps | null {
  for (const name of FOLDER_README_NAMES) {
    const hit = files.find((f) => f.name === name && !f.isDir)
    if (hit) return hit
  }
  return null
}
```

- [ ] **Step 2: Extract the shared prose typography**

Create `custom-v2/styles/_prose.scss`. **Every declaration below is a faithful transcription of the `::ng-deep
.ProseMirror` block at `markdown-view.component.ts:349-432`** — same `em`-relative sizes, same tokens (note `--si-bg3`
for code backgrounds, not `bg2`), same fallback values. Do not "improve" them: Task 8 later points the editor at this
partial, and any drift here becomes a visual regression in `file-detail`.

```scss
// Markdown typography shared by the folder readme banner (read mode) and,
// eventually, the markdown editor itself (see the implementation plan's Task 8).
// Global under .v2-root because v2.scss is loaded with encapsulation:None by
// LayoutV2Component — so no ::ng-deep is needed to reach ProseMirror's
// generated DOM.
//
// Transcribed from markdown-view.component.ts:349-432. Keep the two in sync
// until Task 8 removes the duplicate.
.v2-root .v2-prose {
  outline: none;
  font-size: 15px;
  line-height: 1.6;
  color: var(--si-fg);

  h1 {
    font-size: 1.9em;
    margin: 0.8em 0 0.4em;
    font-weight: 700;
  }

  h2 {
    font-size: 1.5em;
    margin: 0.8em 0 0.4em;
    font-weight: 700;
  }

  h3 {
    font-size: 1.25em;
    margin: 0.7em 0 0.3em;
    font-weight: 600;
  }

  p {
    margin: 0.5em 0;
  }

  ul,
  ol {
    padding-left: 1.4em;
    margin: 0.5em 0;
  }

  ul[data-type='taskList'] {
    list-style: none;
    padding-left: 0.2em;

    li {
      display: flex;
      gap: 0.4em;
      align-items: flex-start;

      > label {
        flex-shrink: 0;
        margin-top: 0.2em;
      }
    }
  }

  blockquote {
    margin: 0.5em 0;
    padding-left: 1em;
    border-left: 3px solid var(--si-border, rgba(0, 0, 0, 0.18));
    color: var(--si-fg-muted, #555);
  }

  code {
    background: var(--si-bg3, rgba(0, 0, 0, 0.06));
    padding: 1px 4px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
  }

  pre {
    background: var(--si-bg3, rgba(0, 0, 0, 0.06));
    padding: 12px;
    border-radius: 6px;
    overflow: auto;

    code {
      background: none;
      padding: 0;
    }
  }

  a {
    color: var(--si-accent, #0a5fb8);
    text-decoration: underline;
  }

  table {
    border-collapse: collapse;
    margin: 0.6em 0;
    width: 100%;

    th,
    td {
      border: 1px solid var(--si-border, rgba(0, 0, 0, 0.18));
      padding: 6px 8px;
    }
  }

  img {
    max-width: 100%;
    height: auto;
  }
}
```

`min-height: 200px` from the original is deliberately **not** transcribed — it is editor-specific (it keeps an empty
editor clickable) and would give the banner a 200px floor for a one-line readme. Task 8 keeps it on the editor.

Then add the `@use` to `custom-v2/styles/v2.scss`, directly under the existing `@use './tokens';`:

```scss
@use './tokens';
@use './prose';
```

**Do not** change `markdown-view.component.ts`'s own copy of these styles in this task. Consolidating it is optional
Task 8, sequenced after browser-verify has confirmed the two renderings actually match.

- [ ] **Step 3: Write the read-only banner**

Create `custom-v2/components/folder-readme.component.ts`:

```ts
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
        untracked(() => this.setContent(''))
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
      this.setContent(text ?? '')
    } catch (e) {
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
```

`ngOnDestroy` for the editor is added in Task 4 together with the edit-mode teardown, so the destroy path is written
once, in one place.

- [ ] **Step 4: Capture `permissions` in both host screens**

Neither screen currently keeps `SpaceFiles.permissions`. In `personal.component.ts`, next to the `files` signal at
`:150`:

```ts
  protected readonly files = signal<FileProps[]>([])
  // Kept for the folder readme banner's writeability check. SpaceFiles carries
  // it on every browse response (space-files.interface.ts:3-7).
  protected readonly permissions = signal<string>('')
```

And in `loadFiles()` (`:1077-1081`), set it on success and clear it on error:

```ts
      next: (result) => {
        this.files.set(result.files)
        this.permissions.set(result.permissions ?? '')
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.files.set([])
        this.permissions.set('')
```

Apply the identical change to `space-files.component.ts` (signal next to `files` at `:~150`, assignment in
`loadFiles()` at `:1074-1081` — note its `next` handler also calls `loadSpaceName`, leave that alone).

- [ ] **Step 5: Expose the folder path to the templates**

Both screens already build exactly the string the banner needs, but privately. Change the modifier only:

- `personal.component.ts:1067` — `private currentUploadRoute(): string` → `protected currentUploadRoute(): string`
- `space-files.component.ts:1056` — same change

- [ ] **Step 6: Add the banner to both templates**

In `personal.component.html`, insert at line 91 — inside `.personal__body`, after the drop-overlay block's closing
`</div>` and before `@if (loading())`:

```html
    <app-v2-folder-readme
      [dirPath]="currentUploadRoute()"
      [files]="files()"
      [permissions]="permissions()"
      (changed)="refresh()"
    />
```

Insert the identical block in `space-files.component.html` at line 89 (same position; that file reuses the
`personal__*` class names).

Placing it **inside** `.personal__body` means it scrolls away with the listing rather than pinning vertical space —
matching Nextcloud, where the workspace scrolls with the file list.

Register the import in both component classes' `imports` arrays:

```ts
    FolderReadmeComponent,
```

with `import { FolderReadmeComponent } from '../../components/folder-readme.component'`.

- [ ] **Step 7: Add the i18n key**

Both `frontend/src/i18n/custom/en.json` and `nl.json` gain one key in this task (keep the files' key order aligned):

`en.json`:
```json
  "Failed to load folder description": "Failed to load folder description",
```

`nl.json`:
```json
  "Failed to load folder description": "Kan de mapbeschrijving niet laden",
```

- [ ] **Step 8: Verify**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Browser-verify:

1. In Personal, create `README.md` with a few lines of markdown including a heading, a bullet list and a link.
2. Navigate away and back. Expected: banner above the listing, heading rendered large, list bulleted, link styled with
   the accent colour — **not** raw markdown, and not white-on-white. The `--si-*` tokens are why: v2's palette is a
   navy ramp scoped under `.v2-root`, so any hard-coded light background here reads as white-on-white in the default
   theme. Check the dark theme too.
3. `README.md` is still a normal row in the listing.
4. Navigate into a subfolder with no readme. Expected: no banner, no gap, no console error.
5. Repeat 1–4 inside a space (`/#/v2/spaces/<alias>`).
6. Rename `README.md` → `notes.md`. Expected: banner disappears after the listing refreshes.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/applications/custom-v2/utils/folder-readme.ts \
        frontend/src/app/applications/custom-v2/components/folder-readme.component.ts \
        frontend/src/app/applications/custom-v2/styles/_prose.scss \
        frontend/src/app/applications/custom-v2/styles/v2.scss \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.html \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.html \
        frontend/src/i18n/custom/en.json frontend/src/i18n/custom/nl.json
git commit -m "feat(v2): render a folder's readme above the listing

Detection is a pure function over the files[] the browse response already
returns, so no backend endpoint is needed. Read mode renders through a
TipTap editor held editable:false — the same pipeline edit mode will use,
so entering edit mode won't reflow the text.

Names and precedence follow nextcloud/text's WorkspaceService, minus the
hidden .Readme.md variant (the browse response strips dotfiles by
default) and the translated filename."
```

---

## Task 3: Collapse, expand, and the fade

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/components/folder-readme.component.ts`
- Modify: `frontend/src/i18n/custom/{en,nl}.json`

**Interfaces:**
- Consumes: `FolderReadmeComponent` from Task 2.
- Produces: no new public surface. Internal only.

- [ ] **Step 1: Add the storage helpers and state**

At module scope, above the `@Component` decorator:

```ts
// Follows the established ui.<scope>.<setting> convention: 'ui.version'
// (v2.constants.ts:33), 'ui.personal.viewMode' (personal.component.ts:74).
const EXPANDED_STORAGE_KEY = 'ui.folderReadme.expanded'

function readStoredExpanded(): boolean {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return false
  return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === 'true'
}

function writeStoredExpanded(expanded: boolean): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  window.localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? 'true' : 'false')
}
```

In the class:

```ts
  protected readonly expanded = signal<boolean>(readStoredExpanded())
  // True once the rendered content is taller than the collapsed cap. Drives
  // both the fade and whether the Show more control renders at all.
  protected readonly overflowing = signal(false)

  protected toggleExpanded(): void {
    const next = !this.expanded()
    this.expanded.set(next)
    writeStoredExpanded(next)
  }
```

- [ ] **Step 2: Measure overflow after each content swap**

The cap is a CSS `max-height`, so overflow is a DOM measurement. Add `ElementRef` and `viewChild` to the existing
`@angular/core` import, then add this — the final form, no follow-up edits:

```ts
  private readonly readHost = viewChild<ElementRef<HTMLElement>>('readHost')

  // scrollHeight exceeds clientHeight only while the collapsed cap is actually
  // clipping, so this is only measurable in the collapsed state — when expanded,
  // keep the previous verdict rather than measuring an uncapped element and
  // concluding "not overflowing", which would hide the Show less control.
  // Deferred a frame so ProseMirror has laid the content out.
  private measureOverflow(): void {
    requestAnimationFrame(() => {
      const host = this.readHost()?.nativeElement
      if (!host) {
        this.overflowing.set(false)
        return
      }
      if (this.expanded()) return
      this.overflowing.set(host.scrollHeight > host.clientHeight + 1)
    })
  }
```

Call it at the end of `setContent`:

```ts
  private setContent(markdown: string): void {
    if (this.editor.isDestroyed) return
    this.editor.commands.setContent(markdown, { emitUpdate: false, contentType: 'markdown' })
    this.measureOverflow()
  }
```

- [ ] **Step 3: Update the template**

Replace the read block from Task 2 with:

```html
        @if (loadError(); as err) {
          <div class="fr__error">{{ err | translate: locale.language }}</div>
        } @else {
          <div
            #readHost
            class="fr__read v2-prose"
            [class.fr__read--collapsed]="!expanded()"
            [class.fr__read--faded]="!expanded() && overflowing()"
            [class.fr__read--expanded]="expanded()"
          >
            <tiptap-editor [editor]="editor"></tiptap-editor>
          </div>

          @if (overflowing() || expanded()) {
            <button type="button" class="fr__toggle" (click)="toggleExpanded()">
              {{ (expanded() ? 'Show less' : 'Show more') | translate: locale.language }}
            </button>
          }
        }
```

- [ ] **Step 4: Add the styles**

Append to the component's `styles`:

```css
      .fr__read {
        position: relative;
        overflow: hidden;
      }
      /* 30vh collapsed matches Nextcloud's RichWorkspace.vue. */
      .fr__read--collapsed {
        max-height: 30vh;
      }
      /* Expanded is capped at 60vh with internal scroll rather than unbounded:
         a 200-line readme would otherwise push the file list off-screen even
         after the user expanded it — the problem the collapse exists to solve.
         This is a deliberate divergence from NC (design doc §7). */
      .fr__read--expanded {
        max-height: 60vh;
        overflow-y: auto;
      }
      .fr__read--faded::after {
        content: '';
        position: absolute;
        inset-inline: 0;
        bottom: 0;
        height: 4em;
        pointer-events: none;
        background: linear-gradient(to bottom, transparent, var(--si-bg1));
      }
      .fr__toggle {
        appearance: none;
        background: none;
        border: none;
        padding: 6px 0 0;
        margin: 0;
        font: inherit;
        font-size: 12px;
        color: var(--si-fg-muted);
        cursor: pointer;
      }
      .fr__toggle:hover {
        color: var(--si-fg);
        text-decoration: underline;
      }
```

The gradient resolves against `--si-bg1` — the same token `.fr` uses as its background — so it fades to the card, not
to white. Hard-coding a colour here breaks dark mode.

- [ ] **Step 5: Add the i18n keys**

`en.json`:
```json
  "Show more": "Show more",
  "Show less": "Show less",
```

`nl.json`:
```json
  "Show more": "Meer weergeven",
  "Show less": "Minder weergeven",
```

- [ ] **Step 6: Verify**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Browser-verify:

1. Short readme (3 lines). Expected: no fade, **no** Show more control.
2. Long readme (60+ lines). Expected: clipped at roughly a third of the viewport, fade at the bottom, Show more
   present.
3. Click Show more. Expected: grows to at most 60% of viewport height and scrolls internally; the file list stays
   reachable by scrolling the page; label reads Show less.
4. Navigate to another folder with a long readme, then reload the page. Expected: still expanded — the preference is
   global, not per folder.
5. Toggle the layout to dark theme. Expected: the fade blends into the card, no white band.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/components/folder-readme.component.ts \
        frontend/src/i18n/custom/en.json frontend/src/i18n/custom/nl.json
git commit -m "feat(v2): collapse long folder readmes with a fade and a toggle

Collapsed at 30vh with a bottom fade, matching NC's RichWorkspace.
Expanded caps at 60vh with internal scroll rather than going unbounded,
so a long readme can't push the file list off-screen even once expanded.
State persists under ui.folderReadme.expanded."
```

---

## Task 4: Edit mode, and the lock-leak fix

**The correctness crux of the feature.** Design §5 is the reason this task is shaped the way it is — read it first.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/components/folder-readme.component.ts`
- Modify: `frontend/src/i18n/custom/{en,nl}.json`

**Interfaces:**
- Consumes: `inline`, `(done)`, `(saved)`, `requestClose()` from Task 1; the component from Tasks 2–3.
- Produces: public `startEdit(): void` on `FolderReadmeComponent` — enters edit mode, queueing the intent if the
  readme has not resolved yet. Task 5 calls it through a `viewChild`.

- [ ] **Step 1: Add edit state and the Edit control**

In the class:

```ts
  protected readonly editing = signal(false)
  // Set when startEdit() is called before the readme has resolved — e.g. the
  // "Folder description" menu entry creates the file and asks for edit mode
  // before the listing refresh has landed.
  private pendingEdit = false

  // Called by the host screen (via viewChild) right after it creates a readme.
  startEdit(): void {
    if (!this.readme()) {
      this.pendingEdit = true
      return
    }
    if (this.writeable()) this.editing.set(true)
  }

  protected onEditClick(): void {
    this.editing.set(true)
  }

  protected onEditorSaved(): void {
    // uploadFileContent issues a bare HTTP request and emits no filesOnEvent
    // (files-upload.service.ts:57-64), so the listing row's size and mtime stay
    // stale until we ask the host to reload.
    this.changed.emit()
  }

  protected onEditorDone(): void {
    // MarkdownViewComponent already ran its unsaved-changes confirm before
    // emitting. Unmounting it triggers its ngOnDestroy, which releases the lock.
    this.editing.set(false)
    this.changed.emit()
  }
```

In the header block of the template, after `.fr__name`:

```html
          <span class="fr__spacer"></span>
          @if (!editing() && writeable()) {
            <app-v2-btn kind="ghost" size="sm" icon="pencil" (click)="onEditClick()">
              {{ 'Edit' | translate: locale.language }}
            </app-v2-btn>
          }
```

Add to the component's `imports`: `ButtonComponent` from `'./button.component'`. Add the spacer style:

```css
      .fr__spacer {
        flex: 1 1 auto;
      }
```

- [ ] **Step 2: Mount the editor in edit mode**

Wrap the existing read/error block so exactly one mode renders. The full body becomes:

```html
        @if (editing()) {
          <div class="fr__edit">
            <app-v2-preview-markdown-view
              [path]="dirPath() + '/' + file.name"
              [file]="file"
              [isWriteable]="true"
              [inline]="true"
              (saved)="onEditorSaved()"
              (done)="onEditorDone()"
            />
          </div>
        } @else if (loadError(); as err) {
          <div class="fr__error">{{ err | translate: locale.language }}</div>
        } @else {
          <div
            #readHost
            class="fr__read v2-prose"
            [class.fr__read--collapsed]="!expanded()"
            [class.fr__read--faded]="!expanded() && overflowing()"
            [class.fr__read--expanded]="expanded()"
          >
            <tiptap-editor [editor]="editor"></tiptap-editor>
          </div>

          @if (overflowing() || expanded()) {
            <button type="button" class="fr__toggle" (click)="toggleExpanded()">
              {{ (expanded() ? 'Show less' : 'Show more') | translate: locale.language }}
            </button>
          }
        }
```

Add to `imports`: `MarkdownViewComponent` from `'../preview/markdown-view.component'`.

The `[path]` value must be the file's full repository path — `dirPath()` is the folder
(`files/personal/docs`), so appending `/` + the name yields what `buildFileModelStub` expects, matching what
`file-detail` passes as `currentPath()`.

The wrapper supplies the bounded height that Task 1's inline mode relies on:

```css
      .fr__edit {
        height: min(60vh, 520px);
        display: flex;
        flex-direction: column;
        border: 1px solid var(--si-border);
        border-radius: 8px;
        overflow: hidden;
      }
```

- [ ] **Step 3: Consume the queued edit intent**

Extend the existing `effect` in the constructor so a resolved readme picks up a pending request. Replace the effect
body's success path:

```ts
      const key = `${file.id}:${file.mtime}`
      untracked(() => {
        this.load(dir, file, key)
        if (this.pendingEdit) {
          this.pendingEdit = false
          if (this.writeable()) this.editing.set(true)
        }
      })
```

- [ ] **Step 4: Release the lock when the folder changes — the actual fix**

Add a `viewChild` on the embedded editor and a dedicated effect. Import `ViewChild`-equivalent signal API
(`viewChild`) — already imported in Task 3 — and `MarkdownViewComponent`.

```ts
  private readonly editorView = viewChild(MarkdownViewComponent)
  private lastDirPath: string | null = null
```

```ts
    // The host screens reload in place on folder change (personal.component.ts:327,
    // space-files.component.ts:311) — they are NOT destroyed, so the embedded
    // editor's ngOnDestroy never fires on navigation and the exclusive lock would
    // leak. CloseGuardService can't help: it's a single-slot manual guard that
    // only file-detail's close() consults, not a router guard. So drop edit mode
    // explicitly whenever dirPath changes. See design §5.
    effect(() => {
      const dir = this.dirPath()
      const previous = this.lastDirPath
      this.lastDirPath = dir
      if (previous === null || previous === dir) return
      untracked(() => this.leaveEditOnNavigate())
    })
```

```ts
  private async leaveEditOnNavigate(): Promise<void> {
    if (!this.editing()) return
    const view = this.editorView()
    // requestClose runs MarkdownViewComponent's own unsaved-changes confirm.
    // Declining keeps edit mode — and keeps the lock, which is correct: the
    // user chose to stay with unsaved work.
    if (view && !(await view.requestClose())) return
    this.editing.set(false)
  }
```

Because the effect writes `lastDirPath` before the guard, a first render never triggers the teardown path.

- [ ] **Step 5: Destroy the read-mode editor**

The read editor has been leaking since Task 2 by design (single destroy path, written once). Add it now:

```ts
export class FolderReadmeComponent implements OnDestroy {
  …
  ngOnDestroy(): void {
    if (!this.editor.isDestroyed) this.editor.destroy()
  }
```

Import `OnDestroy` from `@angular/core`. The **embedded** editor needs no handling here — Angular destroys it when
`@if (editing())` goes false or the host is torn down, and its own `ngOnDestroy` (`markdown-view.component.ts:517-526`)
releases the lock.

- [ ] **Step 6: Add the i18n key**

`Edit` is not in either bundle. `en.json`:
```json
  "Edit": "Edit",
```
`nl.json`:
```json
  "Edit": "Bewerken",
```

- [ ] **Step 7: Verify**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Browser-verify — the last two cases are the ones that matter:

0. **Carried over from Task 1's review — check this first.** Enter edit mode, then toggle the source-mode button
   (the `code` icon) to put CodeMirror inside the banner. Inline mode sets `.md-view__source { position: static;
   min-height: 180px }` with no definite height, so the unchanged `.cm-editor { height: 100% }`
   (`markdown-view.component.ts:343-345`) may go inert. Expected: a usable editor roughly 180px tall or taller, with
   the text visible and editable. **If it renders collapsed, or absurdly tall, report it** — the fix is a definite
   height on `.md-view--inline .md-view__source`, but do not guess at one before observing the actual failure.
1. Folder with a readme, writeable space. Click Edit. Expected: formatting toolbar appears, text becomes editable,
   status reads "Saved".
2. Type, click Save. Expected: success toast; the listing row's Modified column updates (proving `(changed)` →
   `refresh()` fired).
3. Click Cancel with no changes. Expected: returns to read mode immediately, showing the saved content.
4. Type, click Cancel. Expected: discard confirm. Decline → still editing. Accept → read mode, edit discarded.
5. **Read-only check:** open a space where your user lacks `m` in permissions. Expected: banner renders, **no** Edit
   button.
6. **Lock-release check:** enter edit mode, type nothing, then navigate to another folder. Now open the first folder
   as a **second user** and confirm the Edit button is available (no stale lock). Repeat having typed something:
   expect the discard prompt, accept it, and confirm the lock is likewise released.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/applications/custom-v2/components/folder-readme.component.ts \
        frontend/src/i18n/custom/en.json frontend/src/i18n/custom/nl.json
git commit -m "feat(v2): edit a folder readme inline

Edit mounts the existing markdown editor, whose lock-on-open behaviour is
right precisely because it only mounts on a deliberate click. Save asks
the host to reload the listing, since uploadFileContent emits no file
event and the row's size/mtime would otherwise stay stale.

Drops edit mode explicitly when dirPath changes: the browse screens
reload in place rather than being destroyed, so the editor's ngOnDestroy
never fires on folder navigation and the exclusive lock would leak to
every other user of that folder."
```

---

## Task 5: Create a readme from the New menu

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.{ts,html}`
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.{ts,html}`
- Modify: `frontend/src/i18n/custom/{en,nl}.json`

**Interfaces:**
- Consumes: `startEdit()` from Task 4; `pickFolderReadme` / `FOLDER_README_NAMES` from Task 2.
- Produces: nothing consumed later.

- [ ] **Step 1: Add the menu entry**

In `new-entry-menu.ts`, extend the id union:

```ts
export type NewEntryId =
  | 'new-docx'
  | 'new-xlsx'
  | 'new-pptx'
  | 'new-folder'
  | 'new-text'
  | 'new-markdown'
  | 'new-folder-description'
  | 'new-diagram'
  | 'new-download-url'
```

The builders take a flag so the entry is hidden when the folder already has one:

```ts
interface BuildOpts {
  onSelect: (id: NewEntryId) => void
  // Hides the "Folder description" entry when the folder already has a readme.
  hasFolderReadme?: boolean
}
```

In `buildNewEntryMenu`, after the `new-markdown` entry:

```ts
    ...(opts.hasFolderReadme
      ? []
      : [
          {
            id: 'new-folder-description',
            label: 'Folder description',
            icon: 'info',
            action: () => opts.onSelect('new-folder-description')
          } as ContextMenuEntry
        ]),
```

`buildNewEntrySheetItems` gains a parameter and the same conditional:

```ts
export function buildNewEntrySheetItems(hasFolderReadme = false): ActionSheetEntry[] {
```

with, after the `new-markdown` sheet item:

```ts
    ...(hasFolderReadme ? [] : [{ id: 'new-folder-description', label: 'Folder description', icon: 'info' } as ActionSheetEntry]),
```

`'info'` is a real icon in `IconV2Name` (`icons/icon-v2.component.ts`) — do not invent names.

- [ ] **Step 2: Gate the entry in both screens**

In `personal.component.ts`, the menu is built in a `computed` at `:172-177` and the sheet items in a `computed` at
`:161-165`. Both need the flag. Add a derived signal next to `permissions`:

```ts
  protected readonly hasFolderReadme = computed(() => pickFolderReadme(this.files()) !== null)
```

with `import { pickFolderReadme } from '../../utils/folder-readme'`. Then:

```ts
  protected readonly newMenuItems = computed<ContextMenuEntry[]>(() =>
    buildNewEntryMenu({
      onSelect: (id) => this.dispatchNewEntry(id),
      hasFolderReadme: this.hasFolderReadme()
    })
  )
```

```ts
  protected readonly fabSheetItems = computed<readonly ActionSheetEntry[]>(() => [
    ...buildNewEntrySheetItems(this.hasFolderReadme()),
    { id: 'sep-fab', kind: 'divider' },
    { id: 'upload', label: 'Upload', icon: 'upload' }
  ])
```

Apply the same two changes in `space-files.component.ts`.

- [ ] **Step 3: Add the creation handler**

In `personal.component.ts`, next to `newMarkdownFile` (`:943`):

```ts
  // Creates the folder description with a fixed name and no prompt, then hands
  // straight to the banner's editor — no navigation to file-detail, unlike
  // newMarkdownFile. FOLDER_README_NAMES[0] is 'Readme.md', NC's default.
  protected newFolderDescription(): void {
    const name = FOLDER_README_NAMES[0]
    const dirPath = this.currentUploadRoute()
    this.filesService.make('file', name, dirPath, true).subscribe({
      next: () => {
        this.toast.success('v2_file_created', { name })
        this.refresh()
        // The banner queues this until the refreshed listing resolves the file.
        this.readmeBanner()?.startEdit()
      },
      error: (e: HttpErrorResponse) => this.toast.error(e?.error?.message ?? 'Creation failed')
    })
  }
```

Extend the import to `import { FOLDER_README_NAMES, pickFolderReadme } from '../../utils/folder-readme'`.

`filesService.make('file', name, dirPath, true)` creates an **empty** file; the fourth argument means "return the
observable instead of self-subscribing" (`files.service.ts:163-177`). `v2_file_created` already exists in both i18n
bundles.

- [ ] **Step 4: Add the `viewChild` and wire the dispatchers**

In `personal.component.ts`:

```ts
  private readonly readmeBanner = viewChild(FolderReadmeComponent)
```

importing `viewChild` from `@angular/core`.

Add the `case` to `dispatchNewEntry` (`:817`), after the `new-markdown` case:

```ts
      case 'new-folder-description':
        this.newFolderDescription()
        return
```

**And the same `case` again** in `onFabSheetSelect` (`:1012`) — that method duplicates the entire switch rather than
delegating.

In `space-files.component.ts`, add the `viewChild`, the handler, and the `case` in `dispatchNewEntry` (`:820`)
**only** — its `onFabSheetSelect` (`:854`) delegates via `this.dispatchNewEntry(id as NewEntryId)`, so it is covered
already. Adding a second case there is harmless but dead; leave it out.

- [ ] **Step 5: Add the i18n key**

`en.json`:
```json
  "Folder description": "Folder description",
```
`nl.json`:
```json
  "Folder description": "Mapbeschrijving",
```

- [ ] **Step 6: Verify**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Browser-verify:

1. Folder with no readme → open + New. Expected: "Folder description" between Markdown and Diagram.
2. Click it. Expected: `Readme.md` created with no name prompt, banner appears **already in edit mode**, no navigation
   away from the folder.
3. Type, Save, Cancel. Expected: read mode shows the text; `Readme.md` is a row in the listing.
4. Open + New again. Expected: "Folder description" is **gone**.
5. Narrow the window to mobile width and repeat 1–2 via the FAB — **on both Personal and a space** (this is where the
   asymmetric dispatchers bite).
6. Read-only space. Expected: creation fails with an error toast, no half-state.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts \
        frontend/src/i18n/custom/en.json frontend/src/i18n/custom/nl.json
git commit -m "feat(v2): create a folder description from the New menu

Fixed name, no prompt, no navigation — the banner takes over in edit
mode. The entry hides itself once the folder has a readme.

Note the asymmetry between the two screens: space-files' FAB delegates to
dispatchNewEntry while personal's duplicates the whole switch, so the
case has to be added twice in personal and once in space-files."
```

---

## Task 6: Hide the banner while filtering

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.html`
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.html`

**Interfaces:**
- Consumes: the banner from Task 2.
- Produces: nothing.

- [ ] **Step 1: Wrap the banner in both templates**

Filtering is a find-in-folder action and wants rows, not prose (design §7). Both screens already expose a `filter()`
signal used by the toolbar input:

```html
    @if (!filter()) {
      <app-v2-folder-readme
        [dirPath]="currentUploadRoute()"
        [files]="files()"
        [permissions]="permissions()"
        (changed)="refresh()"
      />
    }
```

**Consequence to accept:** the `@if` destroys the component while a filter is active, so an in-progress edit is torn
down — which is safe, because destruction runs the embedded editor's `ngOnDestroy` and releases the lock. Unsaved text
is lost without a prompt, though. Verify step 2 covers it; if it feels wrong in practice, the fix is to gate on
`[class.fr--hidden]` instead of `@if`, and that is a design change, so raise it rather than deciding alone.

- [ ] **Step 2: Verify**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Browser-verify:

1. Folder with a readme. Type in the filter box. Expected: banner disappears; rows filter.
2. Clear the filter. Expected: banner returns with its content, no refetch flicker.
3. Enter edit mode, type something, then type in the filter box. Expected: banner disappears and the text is lost with
   no prompt. Confirm the lock is released by checking as a second user. **If this feels unacceptable, stop and raise
   it** — see the note above.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/personal/personal.component.html \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.html
git commit -m "feat(v2): hide the folder readme while a filter is active

Filtering is a find-in-folder action; it wants rows, not prose."
```

---

## Task 7: Full browser-verify matrix

No code unless a case fails. This is the gate before the PR.

**Files:**
- Modify (only if a case fails): whichever file the failure implicates.
- Modify: `docs/plans/2026-07-28-v2-folder-readme-design.md` — record verified/failed status.

- [ ] **Step 1: Run the complete matrix from design §9**

Build and serve per the `v2-dev-loop-verify` skill, then walk all twelve cases. Record the outcome of each; do not
mark a case passed without having actually observed it.

1. Folder with no readme → no banner, listing unchanged.
2. Each of `Readme.md`, `README.md`, `readme.md` **alone** → banner renders. (Three separate checks — this is the only
   thing that exercises `FOLDER_README_NAMES` end to end, since there is no unit test.)
3. `README.md` **and** `readme.md` coexisting → the banner shows `README.md` (earlier in the precedence list).
4. A **directory** named `README.md` → no banner. (Create it with + New → Folder.)
5. Long readme → collapsed 30vh + fade; Show more → 60vh + internal scroll; survives navigation and reload.
6. Edit → modify → Save → banner and the listing row both reflect the new content and mtime.
7. Edit → modify → Cancel → discard prompt; declining keeps edit mode.
8. Edit → **navigate to another folder** → prompt fires; lock released (verify as a second user).
9. Read-only space (no `m` in `permissions`) → banner renders, no Edit button.
10. Readme exclusively locked by another user → no Edit button.
11. + New → Folder description in an empty folder → creates `Readme.md`, banner opens in edit mode, entry then hidden.
12. Filter active → banner hidden; clearing restores it.

Additionally, because these are cheap and catch the two bug classes this codebase has hit before:

13. Dark theme, all of the above visible states. Expected: no white-on-white, fade blends into the card.
14. Browser console across the whole matrix. Expected: no errors, and no `Failed to load folder description` toast
    except where deliberately provoked.

- [ ] **Step 2: Record the outcome in the design doc**

Append a short section to `2026-07-28-v2-folder-readme-design.md`:

```markdown
## 11. Verification record

Matrix from §9 run on <date> against <commit>, dev stack on :8080.

| Case | Result |
|---|---|
| 1 … 14 | pass / fail + what happened |
```

State failures plainly. A case that could not be tested (e.g. no second user available for 8 and 10) is recorded as
**not tested**, never as passed.

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-07-28-v2-folder-readme-design.md
git commit -m "docs(v2): record the folder readme verification matrix"
```

---

## Task 8 (optional): Consolidate the prose styles

Do this **only** after Task 7 confirms read mode and edit mode render identically. Skip it if the maintainer prefers a
smaller diff — nothing depends on it.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/preview/markdown-view.component.ts`

- [ ] **Step 1: Point the editor at the shared partial**

`markdown-view.component.ts:349-432` holds a `::ng-deep .ProseMirror` copy of the typography that Task 2 extracted to
`styles/_prose.scss`. Add `v2-prose` to the editor host element:

```html
          <div class="md-view__editor v2-prose">
```

and delete the duplicated declarations from the component's `styles`, keeping only the rules that are genuinely
editor-specific (`.ProseMirror` outline/min-height, the task-list checkbox affordances if they differ).

- [ ] **Step 2: Verify**

```bash
npm run -w frontend lint
npm run -w frontend build
```

Browser-verify: open a `.md` in file-detail and compare against the banner's read mode side by side — headings, lists,
code blocks, tables and images must match. Check both themes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/applications/custom-v2/preview/markdown-view.component.ts
git commit -m "feat(v2): share one markdown typography partial

The banner and the editor rendered the same markdown through two copies
of the same CSS. Now both use .v2-prose from styles/_prose.scss."
```

---

## Self-review notes

**Spec coverage.** Design §1 → Task 2 steps 3–6. §2 → Task 2 step 1 (+ matrix cases 2–4). §3 → Task 2 step 3
(`writeable` computed) + Task 4 step 1 (gating) + matrix 9–10. §4 → Task 1 (embeddability), Task 2 step 3 (read
render), Task 4 step 2 (edit mount). §5 → Task 4 step 4 + matrix 8. §6 → Task 5. §7 → Task 3 (collapse) + Task 6
(filter) + Task 2 step 6 (placement) + Task 3 step 5/Task 4 step 6/Task 5 step 5 (i18n). §8 → nothing to build; it
records divergences. §9 → Task 7. §10 → nothing to build.

**Known gaps, deliberate.** The two items in design §10 are not tasks: `.Readme.md` is out of scope by decision, and
v2 file-detail's missing `isWriteable` is a separate bug on a separate surface — do not fix it here, it would widen
this PR into `file-detail` with no test coverage to catch a regression.

**One judgement call flagged for the maintainer rather than decided:** Task 6's `@if` destroys an in-progress edit
when a filter is typed. Lock safety is preserved but unsaved text is lost silently. Raise it after observing it rather
than redesigning mid-execution.
