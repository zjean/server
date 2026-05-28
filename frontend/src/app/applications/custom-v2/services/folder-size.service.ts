import { HttpErrorResponse } from '@angular/common/http'
import { Injectable, computed, inject, signal } from '@angular/core'
import { FilesService } from '../../files/services/files.service'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { ToastService } from '../components/toast.service'

export type FolderSizeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; bytes: number }
  | { status: 'error' }

const IDLE: FolderSizeState = { status: 'idle' }

@Injectable({ providedIn: 'root' })
export class FolderSizeService {
  private readonly filesService = inject(FilesService)
  private readonly toast = inject(ToastService)

  private readonly map = signal<ReadonlyMap<number, FolderSizeState>>(new Map())

  state(fileId: number): FolderSizeState {
    return this.map().get(fileId) ?? IDLE
  }

  compute(file: FileProps): void {
    if (!file.isDir) return
    const current = this.map().get(file.id)
    if (current?.status === 'loading' || current?.status === 'done') return
    this.set(file.id, { status: 'loading' })
    // FilesService.getSize expects a FileModel-shaped object; FileProps has the
    // required `path` already. Cast — the v2 FileProps is a superset wire shape
    // and only `.path` is read by the service.
    this.filesService.getSize(file as never).subscribe({
      next: (bytes: number) => this.set(file.id, { status: 'done', bytes }),
      error: (e: HttpErrorResponse) => {
        this.set(file.id, { status: 'error' })
        this.toast.error(e.error?.message ?? 'Size calculation failed')
      }
    })
  }

  clear(): void {
    if (this.map().size === 0) return
    this.map.set(new Map())
  }

  private set(id: number, state: FolderSizeState): void {
    const next = new Map(this.map())
    next.set(id, state)
    this.map.set(next)
  }
}
