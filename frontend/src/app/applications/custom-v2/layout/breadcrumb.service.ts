import { inject, Injectable, signal } from '@angular/core'
import { Title } from '@angular/platform-browser'
import { L10nTranslationService } from 'angular-l10n'
import { APP_NAME } from '../../../app.constants'
import { IconV2Name } from '../icons/icon-v2.component'

export interface BreadcrumbSegment {
  label: string
  icon?: IconV2Name
  route?: string | string[]
  // Absolute Sync-in path (e.g. 'files/personal/Photos') this segment maps to.
  // When set, the segment can act as a drop target for the v2 drag-and-drop
  // move feature — dropping files here moves them into this directory. Omit
  // on screens / segments that shouldn't accept drops (the terminal segment
  // is naturally a no-op since V2DragService.canDropOnPath rejects sourceDir
  // == targetPath).
  targetPath?: string
}

@Injectable({ providedIn: 'root' })
export class V2BreadcrumbService {
  private readonly title = inject(Title)
  private readonly translation = inject(L10nTranslationService)
  private readonly _segments = signal<BreadcrumbSegment[]>([])

  readonly segments = this._segments.asReadonly()

  setBreadcrumbs(segments: BreadcrumbSegment[]): void {
    this._segments.set(segments)
    this.updateTabTitle(segments)
  }

  clear(): void {
    this._segments.set([])
    this.title.setTitle(APP_NAME)
  }

  // Tab-title format: "<last-segment> · <app>". The last breadcrumb segment is
  // the current context (current folder, opened file, screen name), so it's the
  // single most useful disambiguator in a multi-tab strip.
  //
  // Folder/file names pass through angular-l10n's translate unchanged —
  // l10n returns the key as-is when no translation exists (identity-mapping),
  // which is the desired behaviour for arbitrary user-named entities. Static
  // breadcrumb labels like "Settings" / "Administration" / "Spaces" / "Users"
  // hit their entries in i18n/{en,nl}.json and come back localized.
  private updateTabTitle(segments: BreadcrumbSegment[]): void {
    const last = segments[segments.length - 1]?.label
    if (!last) {
      this.title.setTitle(APP_NAME)
      return
    }
    const translated = this.translation.translate(last)
    this.title.setTitle(`${translated} · ${APP_NAME}`)
  }
}
