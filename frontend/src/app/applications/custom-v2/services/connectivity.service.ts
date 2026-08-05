import { Injectable, signal } from '@angular/core'

/**
 * Whether the browser thinks it can reach the network.
 *
 * The design's third error level — "**Session** — a persistent strip under the top bar.
 * Offline switches it on, disables write actions, and queues local edits with a count" —
 * needs one signal, and this is it.
 *
 * **`navigator.onLine` is not a reachability check.** It is false only when the OS reports
 * no interface at all; a captive portal, a dead VPN or a stopped server all read as online.
 * That is precisely why the strip says what it says and nothing more: it reports the one
 * state the browser can actually observe, and the toasts that already exist report the rest
 * per action. A heartbeat poll would say more, and would also mean a request every N seconds
 * from every open tab forever — not something to add for a strip.
 *
 * The events are the authority once the page is up: `navigator.onLine` is a snapshot, and
 * Chrome sets it false during a laptop's sleep-and-wake even when the wake is instant.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  readonly online = signal(true)

  constructor() {
    if (typeof window === 'undefined') return
    this.online.set(window.navigator.onLine !== false)
    window.addEventListener('online', () => this.online.set(true))
    window.addEventListener('offline', () => this.online.set(false))
  }
}
