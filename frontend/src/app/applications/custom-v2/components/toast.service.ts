import { inject, Injectable, signal } from '@angular/core'
import { L10nTranslationService } from 'angular-l10n'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const AUTO_DISMISS_MS = 3200
const MAX_VISIBLE = 3

/**
 * Toast notifications. The `message` parameter is treated as an i18n key
 * (resolved against angular-l10n's loaded bundles); pass `args` to interpolate
 * `{{ placeholders }}` defined in the key's value.
 *
 * Strings that aren't registered as keys fall through to themselves, so
 * caller sites that pass plain English continue to work for English users;
 * Dutch users get the translation when the key is registered.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly translation = inject(L10nTranslationService)
  private nextId = 1
  readonly toasts = signal<Toast[]>([])

  success(message: string, args?: Record<string, any>): void {
    this.push('success', this.translate(message, args))
  }

  error(message: string, args?: Record<string, any>): void {
    this.push('error', this.translate(message, args))
  }

  info(message: string, args?: Record<string, any>): void {
    this.push('info', this.translate(message, args))
  }

  private translate(message: string, args?: Record<string, any>): string {
    if (!message) return message
    return this.translation.translate(message, args)
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
