# custom-v2 mobile sidebars — design

> **Status (2026-05-26):** Shipped. `layout/layout-v2.service.ts` carries the `isMobile`/`leftNavOpen`/`dockActive` signals, the Escape handler and the resize sync; `layout-v2.component.scss` has the `.layout-v2--mobile` rules; `left-nav.component.ts` wires the drawer open class, dialog-mode aria, and close-on-navigate. A `bottom-tab-bar.component.ts` was added on top of the original scope.

The custom-v2 UI (`frontend/src/app/applications/custom-v2/`) is currently a desktop-only layout with no media queries. Three vertical regions stack to the left of content (a 56px app-rail and a ~240px left-nav) and a 48px dock-rail (plus a 320px dock-panel when active) sits to the right. On a 375px phone the chrome alone outsizes the content area, and there is no way to collapse anything.

This document specifies the changes required to make the v2 layout usable on phone-sized viewports, modelled on how the classic UI behaves on mobile (logo button toggles a collapsible left sidebar).

## Decisions

| # | Decision |
|---|----------|
| 1 | Below the breakpoint, the **app-rail stays visible** as an icon column. Only the **left-nav** menu becomes a drawer. Mirrors classic. |
| 2 | The **dock-rail stays visible**. The **dock-panel** becomes a slide-over sheet over content. |
| 3 | All mobile behavior is gated to **<768px**. Desktop layout is byte-for-byte unchanged. |
| 4 | Drawer dismiss: tap logo (toggle), tap backdrop, **and auto-close on any nav-item navigation**. |
| 5 | Title bar on mobile is aggressively trimmed: only logo, last breadcrumb segment, bell, avatar. Brand text, back/forward arrows, intermediate breadcrumb segments are hidden. |
| 6 | Dock-panel sheet is **right-anchored, ~85vw, capped at 360px**, with a thin tap-outside backdrop on the left. Symmetric with the left drawer. |

Out of scope (deferred): swipe gestures, drawer-open persistence across reloads, full focus-trap with restore-on-close, tablet-specific layout (768–1024 gets desktop).

## Breakpoint and layout regions

Single breakpoint at **768px** (matches classic's `LayoutService.screenMediumSize = 767`). Above it the layout is identical to today. Below it:

```
┌────────────────────────────────────────┐
│  [logo]    last-crumb       [🔔][AV]  │  40px title bar
├──────┬──────────────────────────┬──────┤
│      │                          │      │
│ app- │      content             │ dock │
│ rail │      (router-outlet)     │ rail │
│ 56px │                          │ 48px │
└──────┴──────────────────────────┴──────┘
       ← 280px drawer slides over     85vw / max 360px sheet
         from left                    slides over from right →
```

Content gets `viewport − 104px` of width (~271px on a 375px phone). Drawer and sheet are `position: fixed`, slid in over content. The narrow icon rails (app-rail, dock-rail) remain in the document flow at all sizes.

## State management

A new `LayoutV2Service` co-located with the layout components owns the mobile state. Signal-based (v2 is signal-first; classic's `LayoutService` uses BehaviorSubject only because it predates Angular signals).

```ts
// custom-v2/layout/layout-v2.service.ts
@Injectable({ providedIn: 'root' })
export class LayoutV2Service {
  readonly isMobile = signal(window.innerWidth < 768);
  readonly leftNavOpen = signal(false);
  readonly dockActive = signal<DockTabId | null>(null);

  toggleLeftNav() {
    this.leftNavOpen.update(v => !v);
    if (this.leftNavOpen()) this.dockActive.set(null);
  }
  closeLeftNav() { this.leftNavOpen.set(false); }
  setDock(id: DockTabId | null) {
    this.dockActive.set(id);
    if (id !== null) this.leftNavOpen.set(false);
  }
}
```

The drawer and the sheet auto-close each other; we never have both overlays open simultaneously.

### Wiring

- `LayoutV2Component` listens to `window:resize` (debounced via `requestAnimationFrame`), updates `isMobile`. On any transition across the breakpoint, force `leftNavOpen=false` and `dockActive=null` to avoid stranded fixed-position elements when the CSS rules flip.
- `LayoutV2Component` host gets `[class.layout-v2--mobile]="layoutV2.isMobile()"` and `[class.layout-v2--overlay-open]="layoutV2.leftNavOpen() || layoutV2.dockActive() !== null"`.
- `TitleBarComponent`'s brand block becomes a `<button>` with `(click)="layoutV2.toggleLeftNav()"`, `aria-expanded`, `aria-controls="v2-left-nav"`, `aria-label="Toggle navigation"`. Only acts on mobile (the desktop styling makes the button look like the existing static brand block).
- `LeftNavComponent` reads `leftNavOpen()` for the open class, subscribes to `Router.events` filtering on `NavigationEnd`, and calls `closeLeftNav()` on each navigation.
- `LayoutV2Component`'s existing local `dockActive` signal moves to the service; the dock-panel template reads `layoutV2.dockActive()` and the dock-rail's `(dockChange)` calls `layoutV2.setDock($event)`.
- A single `Escape` keydown listener (registered on the service) closes whichever overlay is open.

## CSS / drawer mechanics

All mobile rules are gated by the `.layout-v2--mobile` host class so desktop is untouched.

### Left-nav drawer

```scss
.layout-v2--mobile :host /* in left-nav.component.scss */ {
  position: fixed;
  top: 40px;
  left: 56px;          /* right of app-rail */
  bottom: 0;
  width: 280px;
  z-index: 40;
  transform: translateX(-110%);
  transition: transform 200ms ease-out;
  box-shadow: 4px 0 16px rgba(0, 0, 0, 0.18);

  &.left-nav--open { transform: translateX(0); }
}
```

### Dock-panel sheet

```scss
.layout-v2--mobile .layout-v2__dock-panel {
  position: fixed;
  top: 40px;
  right: 48px;         /* left of dock-rail */
  bottom: 0;
  width: 85vw;
  max-width: 360px;
  z-index: 40;
  transform: translateX(110%);
  transition: transform 200ms ease-out;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.18);

  &.layout-v2__dock-panel--open { transform: translateX(0); }
}
```

### Backdrop

A single shared `<div class="layout-v2__backdrop">` element rendered conditionally when `isMobile() && (leftNavOpen() || dockActive() !== null)`, full viewport, `z-index: 39`, semi-transparent. Click handler: if `leftNavOpen()` is true, close it; otherwise clear `dockActive`.

### Title-bar trim

```scss
.layout-v2--mobile {
  .title-bar__brand-text,
  .title-bar__nav,
  .title-bar__crumb-sep { display: none; }
  .title-bar__crumb:not(.title-bar__crumb--last) { display: none; }
  .title-bar__brand { width: auto; padding: 0 12px; cursor: pointer; }
}
```

### Body scroll lock and reduced motion

`.layout-v2--overlay-open .layout-v2__content { overflow: hidden; }` — locks only the content region, not `<body>`, so iOS Safari bounce stays well-behaved.

`@media (prefers-reduced-motion: reduce) { .layout-v2--mobile { transition: none; } }` short-circuits transitions while keeping open/closed state.

## Accessibility

- Logo button: `<button type="button" aria-expanded="…" aria-controls="v2-left-nav" aria-label="Toggle navigation">`.
- Drawer root: `id="v2-left-nav"`. On mobile when open, set `role="dialog" aria-modal="true" aria-label="Navigation"`. On desktop it's a plain nav region.
- `Escape` closes whichever overlay is open (document-level listener).
- Focus trap is deferred — drawer items are tab-reachable and Escape closes.

Touch targets in the app-rail must hit ≥44×44px on mobile (WCAG 2.5.5). Bump inside `.layout-v2--mobile` only so desktop density is unchanged.

## Testing

Manual smoke on real devices and in DevTools device toolbar:

- iOS Safari and Chrome Android: log in, drawer toggles via logo, backdrop, and nav-item tap; dock sheet opens via dock-rail icon and closes via backdrop; swap dock tabs without closing; resize across breakpoint leaves no stranded overlay.
- Three widths: 375px (iPhone SE), 414px (iPhone Plus), 768px (boundary — desktop layout takes over).
- macOS "Reduce motion" toggled on: overlays open/close instantly.

No unit tests — this is presentation-only state with no business logic worth mocking; manual smoke catches regressions cheaper than a Karma harness for CSS state.

## File touch list

New:
- `frontend/src/app/applications/custom-v2/layout/layout-v2.service.ts`

Modified:
- `frontend/src/app/applications/custom-v2/layout/layout-v2.component.ts` (host bindings, resize listener, inject service, remove local `dockActive` signal)
- `frontend/src/app/applications/custom-v2/layout/layout-v2.component.html` (backdrop element, dock-panel open class)
- `frontend/src/app/applications/custom-v2/layout/layout-v2.component.scss` (mobile rules)
- `frontend/src/app/applications/custom-v2/layout/title-bar.component.html` (brand block becomes button, aria attributes)
- `frontend/src/app/applications/custom-v2/layout/title-bar.component.ts` (toggle handler, inject service)
- `frontend/src/app/applications/custom-v2/layout/title-bar.component.scss` (mobile trim)
- `frontend/src/app/applications/custom-v2/layout/left-nav.component.html` (drawer id, conditional aria attrs, open class)
- `frontend/src/app/applications/custom-v2/layout/left-nav.component.ts` (read open signal, NavigationEnd auto-close, close-on-Escape)
- `frontend/src/app/applications/custom-v2/layout/left-nav.component.scss` (mobile drawer rules)
