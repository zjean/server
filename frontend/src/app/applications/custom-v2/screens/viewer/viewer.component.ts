import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, HostListener, inject, OnInit, signal, viewChild } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { isImageMime } from '../../utils/mime-to-glyph'

@Component({
  selector: 'app-v2-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './viewer.component.html',
  styleUrl: './viewer.component.scss',
  imports: [IconV2Component, IconButtonComponent, ToBytesPipe, TimeAgoPipe]
})
export class ViewerComponent implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly destroyRef = inject(DestroyRef)
  private readonly imageEl = viewChild<ElementRef<HTMLImageElement>>('imageEl')

  protected readonly path = signal<string>('')
  protected readonly siblings = signal<FileProps[]>([])
  protected readonly current = computed<FileProps | null>(() => {
    const p = this.path()
    return this.siblings().find((f) => `${f.path}/${f.name}` === p) ?? null
  })
  protected readonly currentIndex = computed(() => {
    const p = this.path()
    return this.siblings().findIndex((f) => `${f.path}/${f.name}` === p)
  })
  protected readonly infoOpen = signal(false)
  protected readonly resolution = signal<string>('')
  protected readonly loadError = signal<string | null>(null)

  protected readonly imageUrl = computed(() => {
    const p = this.path()
    return p ? `${API_FILES_OPERATION}/${encodeUrl(p)}` : ''
  })

  protected readonly fileName = computed(() => {
    const c = this.current()
    if (c) return c.name
    const p = this.path()
    return p.split('/').filter(Boolean).pop() ?? ''
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Viewer', icon: 'image' }])
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const path = params.get('path')
      if (!path) {
        this.loadError.set('No image path supplied.')
        return
      }
      this.path.set(path)
      this.loadSiblings(path)
    })
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowRight') {
      this.next()
      ev.preventDefault()
    } else if (ev.key === 'ArrowLeft') {
      this.previous()
      ev.preventDefault()
    } else if (ev.key === 'Escape') {
      this.close()
      ev.preventDefault()
    }
  }

  protected next(): void {
    const imgs = this.siblings()
    if (!imgs.length) return
    const idx = (this.currentIndex() + 1 + imgs.length) % imgs.length
    this.path.set(`${imgs[idx].path}/${imgs[idx].name}`)
    this.resolution.set('')
  }

  protected previous(): void {
    const imgs = this.siblings()
    if (!imgs.length) return
    const idx = (this.currentIndex() - 1 + imgs.length) % imgs.length
    this.path.set(`${imgs[idx].path}/${imgs[idx].name}`)
    this.resolution.set('')
  }

  protected fullscreen(): void {
    this.imageEl()?.nativeElement.requestFullscreen().catch(console.error)
  }

  protected toggleInfo(): void {
    this.infoOpen.update((v) => !v)
  }

  protected close(): void {
    if (window.history.length > 1) {
      window.history.back()
    } else {
      this.router.navigate(['/v2']).catch(console.error)
    }
  }

  protected onImageLoad(): void {
    const img = this.imageEl()?.nativeElement
    if (img) this.resolution.set(`${img.naturalWidth} × ${img.naturalHeight}`)
    this.loadError.set(null)
  }

  protected onImageError(): void {
    this.loadError.set('Failed to load image.')
  }

  private loadSiblings(path: string): void {
    const parts = path.split('/').filter(Boolean)
    if (parts.length < 2) {
      this.siblings.set([])
      return
    }
    const parentPath = parts.slice(0, -1).join('/')
    const url = `${API_SPACES_BROWSE}/${parentPath}`
    this.http
      .get<SpaceFiles>(url)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          const images = result.files.filter((f) => !f.isDir && isImageMime(f.mime))
          this.siblings.set(images)
        },
        error: (e: HttpErrorResponse) => {
          // Not fatal — single image still renders; prev/next just won't work.
          console.warn('v2 viewer: could not list siblings', e)
          this.siblings.set([])
        }
      })
  }
}
