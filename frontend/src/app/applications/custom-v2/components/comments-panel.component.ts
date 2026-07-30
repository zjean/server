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
import { ButtonComponent } from './button.component'
import { ConfirmDialogService } from './confirm-dialog.service'
import { IconV2Component } from '../icons/icon-v2.component'
import { ToastService } from './toast.service'

interface CommentRow extends Comment {
  editing: boolean
  draft: string
  avatarUrl: string | null
}

/**
 * Comments panel for a single file. Consumed by the file-detail "Comments"
 * tab. Uses the classic /api/comments/spaces/{path} endpoints — no new
 * backend.
 *
 * Permissions mirror classic: a comment row shows edit/delete controls only
 * when the viewer is the comment author OR the file owner (per
 * Comment.author.isAuthor / Comment.isFileOwner from the API).
 */
@Component({
  selector: 'app-v2-comments-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconV2Component, FormsModule, TimeAgoPipe, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="cp">
      <div class="cp__compose">
        <textarea
          class="cp__compose-input"
          rows="2"
          [placeholder]="'Write a comment…' | translate: locale.language"
          [(ngModel)]="draft"
          (keydown.meta.enter)="post()"
          (keydown.control.enter)="post()"
        ></textarea>
        <div class="cp__compose-actions">
          <app-v2-btn kind="primary" size="sm" [disabled]="!draft().trim() || submitting()" (click)="post()">
            {{ 'Post' | translate: locale.language }}
          </app-v2-btn>
        </div>
      </div>

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
              <div class="cp-comment__head">
                @if (r.avatarUrl) {
                  <img class="cp-comment__avatar" [src]="r.avatarUrl" alt="" />
                } @else {
                  <span class="cp-comment__avatar cp-comment__avatar--placeholder">@</span>
                }
                <div class="cp-comment__meta">
                  <div class="cp-comment__author">
                    {{ r.author.isAuthor ? ('Me' | translate: locale.language) : r.author.fullName }}
                  </div>
                  <div class="cp-comment__time" [attr.title]="r.modifiedAt">
                    {{ r.modifiedAt | amTimeAgo }}
                    @if (r.modifiedAt !== r.createdAt) {
                      <span class="cp-comment__edited" l10nTranslate>edited</span>
                    }
                  </div>
                </div>
                @if (canEdit(r) && !r.editing) {
                  <button class="cp-comment__action" type="button" (click)="startEdit(r)" [attr.title]="'Edit' | translate: locale.language">
                    <app-v2-icon name="pencil" [size]="12" />
                  </button>
                }
                @if (canEdit(r) && !r.editing) {
                  <button
                    class="cp-comment__action cp-comment__action--danger"
                    type="button"
                    (click)="remove(r)"
                    [attr.title]="'Delete' | translate: locale.language"
                  >
                    <app-v2-icon name="trash" [size]="12" />
                  </button>
                }
              </div>
              <div class="cp-comment__body">
                @if (r.editing) {
                  <textarea class="cp-comment__editor" rows="3" [(ngModel)]="r.draft"></textarea>
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
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .cp {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px 14px;
      }
      .cp__compose {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .cp__compose-input {
        resize: vertical;
        min-height: 44px;
        max-height: 160px;
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: 8px 10px;
        color: var(--si-fg);
        font: inherit;
        font-size: var(--si-text-7);
        line-height: 1.35;

        &:focus {
          outline: none;
          border-color: var(--si-nav);
        }
        &::placeholder {
          color: var(--si-fg-faint);
        }
      }
      .cp__compose-actions {
        display: flex;
        justify-content: flex-end;
      }
      .cp__state {
        padding: 18px 10px;
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
        text-align: center;

        &--error {
          color: var(--si-rose);
        }
      }
      .cp__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .cp-comment {
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: 8px 10px;
      }
      .cp-comment__head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cp-comment__avatar {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        flex-shrink: 0;
        object-fit: cover;

        &--placeholder {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--si-bg4);
          color: var(--si-fg-muted);
          font-size: var(--si-text-4);
        }
      }
      .cp-comment__meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1 1 auto;
      }
      .cp-comment__author {
        font-size: var(--si-text-6);
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
      }
      .cp-comment__time {
        font-size: var(--si-text-3);
        color: var(--si-fg-faint);
        font-family: var(--si-mono);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cp-comment__edited {
        font-style: italic;
      }
      .cp-comment__action {
        width: 22px;
        height: 22px;
        border-radius: 5px;
        background: transparent;
        border: none;
        cursor: pointer;
        color: var(--si-fg-faint);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;

        &:hover {
          background: var(--si-bg4);
          color: var(--si-fg);
        }

        &--danger:hover {
          color: var(--si-rose);
        }
      }
      .cp-comment__body {
        margin-top: 6px;
      }
      .cp-comment__content {
        font-size: var(--si-text-7);
        line-height: 1.4;
        color: var(--si-fg);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .cp-comment__editor {
        width: 100%;
        resize: vertical;
        min-height: 60px;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: 6px 8px;
        color: var(--si-fg);
        font: inherit;
        font-size: var(--si-text-7);
        line-height: 1.35;

        &:focus {
          outline: none;
          border-color: var(--si-nav);
        }
      }
      .cp-comment__editor-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 6px;
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
          this.hasCommentsChange.emit(cs.length > 0)
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.error?.message ?? 'Failed to load comments')
          this.loading.set(false)
        }
      })
  }

  private buildRow(c: Comment): CommentRow {
    return {
      ...c,
      editing: false,
      draft: c.content,
      avatarUrl: c.author?.login ? userAvatarUrl(c.author.login) : null
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
        this.hasCommentsChange.emit(true)
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
        const remaining = this.rows().filter((row) => row.id !== r.id)
        this.rows.set(remaining)
        this.hasCommentsChange.emit(remaining.length > 0)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to delete comment')
      }
    })
  }
}
