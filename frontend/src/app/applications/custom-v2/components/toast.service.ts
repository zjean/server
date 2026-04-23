import { inject, Injectable, signal } from '@angular/core'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const AUTO_DISMISS_MS = 3200
const MAX_VISIBLE = 3

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1
  readonly toasts = signal<Toast[]>([])

  success(message: string): void {
    this.push('success', message)
  }

  error(message: string): void {
    this.push('error', message)
  }

  info(message: string): void {
    this.push('info', message)
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id))
  }

  dismissAll(): void {
    this.toasts.set([])
  }

  private push(kind: ToastKind, message: string): void {
    const id = this.nextId++
    this.toasts.update((list) => {
      const next = [...list, { id, kind, message }]
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
    })
    if (typeof window !== 'undefined') {
      window.setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS)
    }
  }
}

// Injection helper for templates / components that want the service without boilerplate.
export function injectToast(): ToastService {
  return inject(ToastService)
}
