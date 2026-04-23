import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { CommentsService } from '../../../comments/services/comments.service'
import { FilesService } from '../../../files/services/files.service'
import { StoreService } from '../../../../store/store.service'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { isImageMime, mimeToGlyph } from '../../utils/mime-to-glyph'

const RECENT_LIMIT = 20

@Component({
  selector: 'app-v2-recents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recents.component.html',
  styleUrl: './recents.component.scss',
  imports: [IconV2Component, FileGlyphComponent, TimeAgoPipe]
})
export class RecentsComponent implements OnInit {
  private readonly filesService = inject(FilesService)
  private readonly commentsService = inject(CommentsService)
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  protected readonly files = computed(() => this.store.filesRecents().slice(0, RECENT_LIMIT))
  protected readonly comments = computed(() => this.store.commentsRecents().slice(0, RECENT_LIMIT))
  protected readonly user = toSignal(this.store.user)

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly nowLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  protected readonly greeting = computed(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  })

  protected readonly firstName = computed(() => {
    const full = this.user()?.fullName?.trim()
    if (full) return full.split(/\s+/)[0]
    return this.user()?.login ?? ''
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Recents', icon: 'clock' }])
    this.filesService.loadRecents(RECENT_LIMIT)
    this.commentsService.loadRecents(RECENT_LIMIT)
  }

  protected openFile(parentPath: string, fileName: string, mime: string | null | undefined): void {
    const fullPath = `${parentPath}/${fileName}`
    if (isImageMime(mime)) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.VIEWER], { queryParams: { path: fullPath } }).catch(console.error)
      return
    }
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }
}
