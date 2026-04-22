import { Injectable, signal } from '@angular/core'
import { IconV2Name } from '../icons/icon-v2.component'

export interface BreadcrumbSegment {
  label: string
  icon?: IconV2Name
  route?: string | string[]
}

@Injectable({ providedIn: 'root' })
export class V2BreadcrumbService {
  private readonly _segments = signal<BreadcrumbSegment[]>([])

  readonly segments = this._segments.asReadonly()

  setBreadcrumbs(segments: BreadcrumbSegment[]): void {
    this._segments.set(segments)
  }

  clear(): void {
    this._segments.set([])
  }
}
