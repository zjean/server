import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { CommentsService } from '../../../comments/services/comments.service'
import { FilesService } from '../../../files/services/files.service'
import { FileRecentModel } from '../../../files/models/file-recent.model'
import { StoreService } from '../../../../store/store.service'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { AvatarComponent, avatarHue, avatarInitials, AvatarUser } from '../../components/avatar.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

const RECENT_LIMIT = 20
const PINNED_FILE_COUNT = 4
const PINNED_COMMENT_COUNT = 3

interface RecentBucket {
  key: 'today' | 'yesterday' | 'earlier'
  label: string
  items: FileRecentModel[]
}

@Component({
  selector: 'app-v2-recents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recents.component.html',
  styleUrl: './recents.component.scss',
  imports: [IconV2Component, FileGlyphComponent, AvatarComponent, TimeAgoPipe]
})
export class RecentsComponent implements OnInit {
  private readonly filesService = inject(FilesService)
  private readonly commentsService = inject(CommentsService)
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  private readonly files = computed(() => this.store.filesRecents().slice(0, RECENT_LIMIT))
  protected readonly comments = computed(() => this.store.commentsRecents().slice(0, RECENT_LIMIT))
  protected readonly user = toSignal(this.store.user)

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly nowLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  // Top of the recents list — surfaced as 4-up "Pick up where you left off"
  // cards. The remainder feeds the grouped activity list below so the user
  // still has access to everything that's loaded.
  protected readonly pinnedFiles = computed(() => this.files().slice(0, PINNED_FILE_COUNT))
  protected readonly restFiles = computed(() => this.files().slice(PINNED_FILE_COUNT))
  protected readonly pinnedComments = computed(() => this.comments().slice(0, PINNED_COMMENT_COUNT))

  // Group remaining files by mtime bucket (today / yesterday / earlier).
  // We can't show an action taxonomy ("Edited", "Commented") without an
  // activity-feed endpoint, so the grouping carries the time signal alone
  // and the row body stays neutral.
  protected readonly buckets = computed<RecentBucket[]>(() => {
    const items = this.restFiles()
    if (items.length === 0) return []

    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000

    const today: FileRecentModel[] = []
    const yesterday: FileRecentModel[] = []
    const earlier: FileRecentModel[] = []
    // mtime is stored as ms (consistent with classic widgets that pipe it
    // straight into amTimeAgo without scaling).
    for (const f of items) {
      const t = Number(f.mtime)
      if (!Number.isFinite(t)) {
        earlier.push(f)
        continue
      }
      if (t >= startOfToday) today.push(f)
      else if (t >= startOfYesterday) yesterday.push(f)
      else earlier.push(f)
    }

    const out: RecentBucket[] = []
    if (today.length) out.push({ key: 'today', label: 'Today', items: today })
    if (yesterday.length) out.push({ key: 'yesterday', label: 'Yesterday', items: yesterday })
    if (earlier.length) out.push({ key: 'earlier', label: 'Earlier', items: earlier })
    return out
  })

  protected readonly hasAny = computed(() => this.files().length > 0 || this.comments().length > 0)

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Recents', icon: 'clock' }])
    this.filesService.loadRecents(RECENT_LIMIT)
    this.commentsService.loadRecents(RECENT_LIMIT)
  }

  protected openFile(parentPath: string, fileName: string): void {
    const fullPath = `${parentPath}/${fileName}`
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  // Middle-click on a recents row → new tab with file-detail.
  protected onRowAuxClick(event: MouseEvent, parentPath: string, fileName: string): void {
    if (event.button !== 1) return
    event.preventDefault()
    if (typeof window !== 'undefined') {
      window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(`${parentPath}/${fileName}`)}`, '_blank', 'noopener')
    }
  }

  // AvatarUser projection for a comment author. Funnels into the same shared
  // <app-v2-avatar> renderer the left-nav user-card and Space cards use, so
  // the same person renders with the same gradient + initials everywhere.
  protected commentAvatar(author: { fullName?: string; login?: string; avatarUrl?: string } | null | undefined): AvatarUser {
    const seed = author?.login ?? author?.fullName ?? ''
    return {
      initials: avatarInitials(author?.fullName ?? author?.login ?? '?'),
      hue: avatarHue(seed),
      imageUrl: author?.avatarUrl ?? null
    }
  }
}
