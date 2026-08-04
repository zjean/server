import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, inject, Input, OnChanges, Output, signal, SimpleChanges } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { API_COMMENTS_FROM_SPACE } from '@sync-in-server/backend/src/applications/comments/constants/routes'
import type { CreateOrUpdateCommentDto, DeleteCommentDto } from '@sync-in-server/backend/src/applications/comments/dto/comment.dto'
import type { Comment } from '@sync-in-server/backend/src/applications/comments/schemas/comment.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { userAvatarUrl } from '../../users/user.functions'
import { AvatarComponent, avatarInitials, avatarTone, AvatarUser } from './avatar.component'
import { ButtonComponent } from './button.component'
import { ConfirmDialogService } from './confirm-dialog.service'
import { IconButtonComponent } from './icon-button.component'
import { ToastService } from './toast.service'

/** What the host's tab strip and panel header label this thread with. */
export interface CommentsStats {
  count: number
}

interface CommentRow extends Comment {
  editing: boolean
  draft: string
  avatar: AvatarUser
}

/**
 * Comments panel for a single file. Consumed by the inspector's "Comments" tab.
 * Uses the classic /api/comments/spaces/{path} endpoints — no new backend.
 *
 * D5's shape: the thread scrolls and the composer is PINNED to the bottom on its
 * own surface band, with `⌘↵ to post` in mono and one filled button. The composer
 * used to sit above the thread, which put the newest comment furthest from the
 * reply to it.
 *
 * Two things D5 draws that are deliberately absent, because the API has nothing
 * behind them: the 24px reply indent (a comment has no parent — `Comment` carries
 * `fileId` and `userId` and no thread id, so every comment is top-level) and the
 * Reply / Resolve actions. Drawing an indent with no threading, or a Reply button
 * that can only post another top-level comment, would be a promise the server
 * does not keep.
 *
 * Permissions mirror classic: a comment row shows edit/delete controls only
 * when the viewer is the comment author OR the file owner (per
 * Comment.author.isAuthor / Comment.isFileOwner from the API).
 */
@Component({
  selector: 'app-v2-comments-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, ButtonComponent, IconButtonComponent, FormsModule, TimeAgoPipe, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="cp">
      <div class="cp__scroll">
        @if (loading()) {
          <div class="cp__state" l10nTranslate>Loading…</div>
        } @else if (errorMessage(); as err) {
          <div class="cp__state cp__state--error">{{ err | translate: locale.language }}</div>
        } @else if (rows().length === 0) {
          <div class="cp__state" l10nTranslate>No comments yet.</div>
        } @else {
          <ul class="cp__list">
            @for (r of rows(); track r.id) {
              <li class="cp-comment">
                <app-v2-avatar [user]="r.avatar" [size]="26" />
                <div class="cp-comment__main">
                  <div class="cp-comment__head">
                    <span class="cp-comment__author">
                      {{ r.author.isAuthor ? ('Me' | translate: locale.language) : r.author.fullName }}
                    </span>
                    <span class="cp-comment__time" [attr.title]="r.modifiedAt">
                      {{ r.modifiedAt | amTimeAgo }}
                      @if (r.modifiedAt !== r.createdAt) {
                        <span class="cp-comment__edited" l10nTranslate>edited</span>
                      }
                    </span>
                    <span class="cp-comment__spacer"></span>
                    @if (canEdit(r) && !r.editing) {
                      <app-v2-icon-btn
                        iconName="pencil"
                        [size]="26"
                        [title]="'Edit' | translate: locale.language"
                        [ariaLabel]="'Edit' | translate: locale.language"
                        (click)="startEdit(r)"
                      />
                      <app-v2-icon-btn
                        iconName="trash"
                        [size]="26"
                        [title]="'Delete' | translate: locale.language"
                        [ariaLabel]="'Delete' | translate: locale.language"
                        (click)="remove(r)"
                      />
                    }
                  </div>
                  @if (r.editing) {
                    <textarea class="cp__field cp-comment__editor" rows="3" [(ngModel)]="r.draft"></textarea>
                    <div class="cp-comment__editor-actions">
                      <app-v2-btn kind="ghost" size="sm" (click)="cancelEdit(r)">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
                      <app-v2-btn kind="primary" size="sm" [disabled]="!r.draft.trim() || r.draft.trim() === r.content" (click)="saveEdit(r)">
                        {{ 'Save' | translate: locale.language }}
                      </app-v2-btn>
                    </div>
                  } @else {
                    <div class="cp-comment__content">{{ r.content }}</div>
                  }
                </div>
              </li>
            }
          </ul>
        }
      </div>

      <!-- Pinned, on its own band. The band is what makes it read as part of the
           panel's chrome rather than the last item in the thread. -->
      <div class="cp__compose">
        <textarea
          class="cp__field"
          rows="2"
          [placeholder]="'Write a comment…' | translate: locale.language"
          [(ngModel)]="draft"
          (keydown.meta.enter)="post()"
          (keydown.control.enter)="post()"
        ></textarea>
        <div class="cp__compose-actions">
          <span class="cp__hint">{{ 'v2_post_shortcut' | translate: locale.language : { key: postShortcutKey } }}</span>
          <app-v2-btn kind="primary" size="sm" [disabled]="!draft().trim() || submitting()" (click)="post()">
            {{ 'Comment' | translate: locale.language }}
          </app-v2-btn>
        </div>
      </div>
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
      .cp {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
      }
      .cp__scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: var(--si-space-9) var(--si-space-10);
      }
      .cp__state {
        padding: var(--si-space-9) var(--si-space-5);
        font-size: var(--si-text-6);
        color: var(--si-fg-tertiary);
        text-align: center;

        &--error {
          color: var(--si-rose-ink);
        }
      }
      .cp__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--si-space-9);
      }
      /* No card. A comment is prose by a person, and thirty framed boxes in a
         340px column read as a table of them. The avatar is the row's left edge. */
      .cp-comment {
        display: flex;
        gap: var(--si-space-6);
        min-width: 0;
      }
      .cp-comment__main {
        min-width: 0;
        flex: 1 1 auto;
      }
      .cp-comment__head {
        display: flex;
        align-items: baseline;
        gap: var(--si-space-4);
        min-width: 0;
      }
      .cp-comment__spacer {
        flex: 1 1 auto;
      }
      .cp-comment__author {
        font-size: var(--si-text-7);
        font-weight: 500;
        color: var(--si-fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cp-comment__time {
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        color: var(--si-fg-ghost);
        display: flex;
        align-items: center;
        gap: var(--si-space-3);
        white-space: nowrap;
      }
      .cp-comment__edited {
        font-style: italic;
      }
      .cp-comment__content {
        margin-top: var(--si-space-2);
        font-size: var(--si-text-8);
        line-height: 1.6;
        color: var(--si-fg-muted);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      /* Mirrors app-v2-input: filled, with a resting hairline, because the fill
         alone measures 1.10:1 against the plane it sits on. */
      .cp__field {
        width: 100%;
        resize: vertical;
        background: var(--si-bg3);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r2);
        padding: var(--si-space-5) var(--si-space-6);
        color: var(--si-fg);
        font-family: var(--si-sans);
        font-size: var(--si-text-8);
        line-height: 1.45;

        &:focus {
          border-color: var(--si-focus-ring);
          outline: 2px solid var(--si-focus-ring);
          outline-offset: 1px;
        }
        &::placeholder {
          color: var(--si-fg-tertiary);
        }
      }
      .cp-comment__editor {
        margin-top: var(--si-space-4);
        min-height: 60px;
      }
      .cp-comment__editor-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--si-space-3);
        margin-top: var(--si-space-4);
      }
      .cp__compose {
        flex: 0 0 auto;
        background: var(--si-bg2);
        padding: var(--si-space-7) var(--si-space-10) var(--si-space-9);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-5);
      }
      .cp__compose .cp__field {
        min-height: 44px;
        max-height: 160px;
      }
      .cp__compose-actions {
        display: flex;
        align-items: center;
        gap: var(--si-space-5);
      }
      /* A keystroke is machine vocabulary, so mono — and it is the hint, so it
         takes the quiet tone and the leftover width. */
      .cp__hint {
        flex: 1 1 auto;
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        color: var(--si-fg-ghost);
      }
    `
  ]
})
export class CommentsPanelComponent implements OnChanges {
  /** Full file path (e.g. `files/personal/docs/plan.md`) and numeric file id. */
  @Input({ required: true }) filePath!: string
  @Input({ required: true }) fileId!: number
  /** Emits new `hasComments` state after post/delete. Lets the host update its `file()` signal. */
  @Output() hasCommentsChange = new EventEmitter<boolean>()
  /** How many comments there are, for the host's tab count and panel header. */
  @Output() statsChange = new EventEmitter<CommentsStats>()

  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastService)
  private readonly confirm = inject(ConfirmDialogService)
  private readonly destroyRef = inject(DestroyRef)

  protected readonly rows = signal<CommentRow[]>([])
  protected readonly loading = signal(false)
  protected readonly submitting = signal(false)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly draft = signal('')

  // The keystroke only; the sentence around it is translated. Spelling it as one
  // English string is how '⌘F' ended up hard-coded for every Linux user in #368.
  protected readonly postShortcutKey: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl ↵'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘↵' : 'Ctrl ↵'
  })()

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['filePath'] || changes['fileId']) {
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || !this.fileId) return
    this.loading.set(true)
    this.errorMessage.set(null)
    this.http
      .get<Comment[]>(`${API_COMMENTS_FROM_SPACE}/${this.filePath}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cs) => {
          this.rows.set(cs.map((c) => this.buildRow(c)))
          this.loading.set(false)
          this.announce(cs.length)
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.error?.message ?? 'Failed to load comments')
          this.loading.set(false)
        }
      })
  }

  private announce(count: number): void {
    this.hasCommentsChange.emit(count > 0)
    this.statsChange.emit({ count })
  }

  private buildRow(c: Comment): CommentRow {
    const login = c.author?.login ?? ''
    return {
      ...c,
      editing: false,
      draft: c.content,
      // The shared avatar renderer, so the same person looks the same here as in
      // the version list and the top bar — this used to be a bare <img> with an
      // '@' fallback, which was the one place a missing avatar rendered as a
      // punctuation mark.
      avatar: {
        initials: avatarInitials(c.author?.fullName || login || '?'),
        tone: avatarTone(login),
        imageUrl: login ? userAvatarUrl(login) : null
      }
    }
  }

  protected canEdit(r: CommentRow): boolean {
    return r.author.isAuthor || r.isFileOwner
  }

  protected post(): void {
    const content = this.draft().trim()
    if (!content || this.submitting()) return
    this.submitting.set(true)
    const dto: CreateOrUpdateCommentDto = { fileId: this.fileId, content }
    this.http.post<Comment>(`${API_COMMENTS_FROM_SPACE}/${this.filePath}`, dto).subscribe({
      next: (c) => {
        this.rows.update((list) => [this.buildRow(c), ...list])
        this.draft.set('')
        this.submitting.set(false)
        this.announce(this.rows().length)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to post comment')
        this.submitting.set(false)
      }
    })
  }

  protected startEdit(r: CommentRow): void {
    this.rows.update((list) => list.map((row) => (row.id === r.id ? { ...row, editing: true, draft: row.content } : { ...row, editing: false })))
  }

  protected cancelEdit(r: CommentRow): void {
    this.rows.update((list) => list.map((row) => (row.id === r.id ? { ...row, editing: false, draft: row.content } : row)))
  }

  protected saveEdit(r: CommentRow): void {
    const content = r.draft.trim()
    if (!content || content === r.content) return
    const dto: CreateOrUpdateCommentDto = { fileId: r.fileId, content, commentId: r.id }
    this.http.patch<Comment>(`${API_COMMENTS_FROM_SPACE}/${this.filePath}`, dto).subscribe({
      next: (updated) => {
        this.rows.update((list) => list.map((row) => (row.id === r.id ? this.buildRow(updated) : row)))
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to update comment')
      }
    })
  }

  protected async remove(r: CommentRow): Promise<void> {
    const ok = await this.confirm.open({
      title: 'Delete comment',
      message: 'v2_delete_comment',
      confirmLabel: 'Delete',
      kind: 'danger'
    })
    if (!ok) return
    const dto: DeleteCommentDto = { fileId: r.fileId, commentId: r.id }
    this.http.request<void>('delete', `${API_COMMENTS_FROM_SPACE}/${this.filePath}`, { body: dto }).subscribe({
      next: () => {
        this.rows.set(this.rows().filter((row) => row.id !== r.id))
        this.announce(this.rows().length)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to delete comment')
      }
    })
  }
}
