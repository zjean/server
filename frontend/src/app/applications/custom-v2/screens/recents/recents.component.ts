import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { CommentsService } from '../../../comments/services/comments.service'
import { FilesService } from '../../../files/services/files.service'
import { FileRecentModel } from '../../../files/models/file-recent.model'
import { StoreService } from '../../../../store/store.service'
import { AvatarComponent, avatarTone, avatarInitials, AvatarUser } from '../../components/avatar.component'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileRowComponent } from '../../components/file-row.component'
import { FileThumbComponent } from '../../components/file-thumb.component'
import { SectionHeadComponent } from '../../components/section-head.component'
import { TimestampComponent } from '../../components/timestamp.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { DateBucket, groupByDateBucket } from '../../utils/date-buckets'
import { FILE_ORIGIN_ICONS, FILE_ORIGIN_LABELS, fileLocationPath, fileOriginOf } from '../../utils/file-origin'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

const RECENT_LIMIT = 20
const PINNED_FILE_COUNT = 4
const PINNED_COMMENT_COUNT = 3

@Component({
  selector: 'app-v2-recents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recents.component.html',
  styleUrl: './recents.component.scss',
  imports: [
    AvatarComponent,
    EmptyStateComponent,
    FileRowComponent,
    FileThumbComponent,
    IconV2Component,
    SectionHeadComponent,
    TimestampComponent,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class RecentsComponent implements OnInit {
  private readonly filesService = inject(FilesService)
  private readonly commentsService = inject(CommentsService)
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  // protected, not private: the header's meta line counts it.
  protected readonly files = computed(() => this.store.filesRecents().slice(0, RECENT_LIMIT))
  protected readonly comments = computed(() => this.store.commentsRecents().slice(0, RECENT_LIMIT))
  protected readonly user = toSignal(this.store.user)

  protected readonly mimeToGlyph = mimeToGlyph

  // ONE instant for the whole render, passed down to every timestamp and used to
  // bucket every row. Letting each of twenty cells call `Date.now()` separately
  // would let a render that straddles midnight put two rows from the same second
  // in different buckets — and, more mundanely, it is twenty clock reads for one
  // answer.
  //
  // Read at construction rather than per-computation on purpose: the list is
  // re-rendered on navigation, which is when a stale value would be noticed, and
  // pinning it means the buckets cannot reshuffle under the user mid-scroll.
  protected readonly renderedAt = Date.now()

  // Top of the list, surfaced as the "pick up where you left off" band. The
  // remainder feeds the grouped list below, so nothing loaded is unreachable.
  protected readonly pinnedFiles = computed(() => this.files().slice(0, PINNED_FILE_COUNT))
  protected readonly restFiles = computed(() => this.files().slice(PINNED_FILE_COUNT))
  protected readonly pinnedComments = computed(() => this.comments().slice(0, PINNED_COMMENT_COUNT))

  // Grouped by date, on the five-rung ladder in ../../utils/date-buckets.ts.
  // The three-rung ladder this replaces had an unbounded bottom bucket, so every
  // row of a fortnight-old dataset landed under one "Earlier" header — a grouping
  // that grouped nothing. The bucketing itself now lives in a tested pure
  // function rather than inline here.
  protected readonly buckets = computed<DateBucket<FileRecentModel>[]>(() =>
    groupByDateBucket(this.restFiles(), (f) => Number(f.mtime), this.renderedAt)
  )

  protected readonly hasAny = computed(() => this.files().length > 0 || this.comments().length > 0)

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Recents', icon: 'clock' }])
    this.filesService.loadRecents(RECENT_LIMIT)
    this.commentsService.loadRecents(RECENT_LIMIT)
  }

  // The addressable path FileThumb needs, and the one `openFile` navigates to.
  // `path` on a recents row is the PARENT directory, repository-qualified — so the
  // file's address is parent + name. Handing FileThumb the bare `path` would make
  // every tile request its parent directory (issue #428).
  protected serverPath(f: FileRecentModel): string {
    return `${f.path}/${f.name}`
  }

  // The i18n key for this row's origin. Translated in the template by the pipe
  // rather than here by L10nTranslationService, deliberately: this component is
  // OnPush, and `| translate: locale.language` takes the language as a pipe
  // ARGUMENT, which is what makes the expression re-evaluate when the user
  // switches language. An imperative `translate()` call inside a
  // template-invoked method would return the old string until something else
  // happened to mark the view dirty. It is also the pattern every other v2
  // template already uses.
  protected originKey(f: FileRecentModel): string {
    return FILE_ORIGIN_LABELS[fileOriginOf(f)]
  }

  // The glyph that says where this file came from, in the left nav's own
  // vocabulary. Replaces the hard-coded `folder` every row used to show
  // regardless of origin.
  protected originIcon(f: FileRecentModel): IconV2Name {
    return FILE_ORIGIN_ICONS[fileOriginOf(f)]
  }

  // The path with its repository prefix stripped. Empty at a repository root, in
  // which case the template substitutes the translated origin label — a row that
  // shows nothing where its siblings show a path reads as a fault, not as "top
  // level".
  protected locationPath(f: FileRecentModel): string {
    return fileLocationPath(f.showedPath)
  }

  protected openFile(parentPath: string, fileName: string): void {
    const fullPath = `${parentPath}/${fileName}`
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  // Middle-click → file-detail in a new tab. The button-number guard lives in
  // FileRowComponent now, so this only runs for an actual middle click.
  protected openFileInNewTab(parentPath: string, fileName: string): void {
    if (typeof window === 'undefined') return
    window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(`${parentPath}/${fileName}`)}`, '_blank', 'noopener')
  }

  // Kept for the comment cards, which are still plain buttons rather than rows.
  protected onCardAuxClick(event: MouseEvent, parentPath: string, fileName: string): void {
    if (event.button !== 1) return
    event.preventDefault()
    this.openFileInNewTab(parentPath, fileName)
  }

  // AvatarUser projection for a comment author. Funnels into the same shared
  // <app-v2-avatar> renderer the left-nav user-card and Space cards use, so the
  // same person renders with the same tone and initials everywhere.
  protected commentAvatar(author: { fullName?: string; login?: string; avatarUrl?: string } | null | undefined): AvatarUser {
    const seed = author?.login ?? author?.fullName ?? ''
    return {
      initials: avatarInitials(author?.fullName ?? author?.login ?? '?'),
      tone: avatarTone(seed),
      imageUrl: author?.avatarUrl ?? null
    }
  }
}
