# design-sync notes

## This repo is out of scope for `/design-sync` (checked 2026-07-29)

**Decision: do not sync. No Claude Design project was created; there is deliberately no `config.json`
and no `projectId` pin.**

Why, so a future run doesn't re-derive it:

- `frontend/` is **Angular 21** (`@angular/core ^21.2.16`, angular-l10n, ngx-bootstrap); `backend/` is
  NestJS. `grep -E '"(react|react-dom|vue|svelte)"' frontend/package.json` → no match. There is no React
  anywhere in the tree.
- The Claude Design runtime renders designs from a compiled bundle exposing **React** components on
  `window.<globalName>.*`, with `.jsx` preview cards and `<Name>Props` `.d.ts` contracts. The ~63 Angular
  components under `frontend/src/app/applications/custom-v2/` cannot mount in that runtime.
- This is an application, not a publishable component library: there is no component-library `dist/` for
  the converter to bundle.
- Shape detection, for the record: no `.storybook/` config and no `*.stories.*` files anywhere, so the
  package shape would have applied — but the React blocker above precedes that.

### The one partial option that was considered and declined

A **tokens-and-CSS-only** project was possible: `custom-v2/styles/_tokens.scss` plus
`src/styles/components/{_themes,_theme_light,_theme_dark}.scss` are a real token system, and
`custom-v2/screens/kit/` is an in-repo component gallery. That would have given the design agent the
palette/typography vocabulary, but every component it composed would still be generic, and the
previews / `.d.ts` / `.prompt.md` half of the pipeline would have been empty. The maintainer chose to
stop instead.

**If this changes:** the trigger is a separate React design-system repo (or one extracted from this
frontend). Run `/design-sync` there, not here.

## Note added 2026-08-03 — a design project now exists, but the flow is the OTHER direction

`4d96b99d-7b88-4478-bd57-7bfc169b5b0a` ("Sync-In Design System v1.0") is a hand-authored Claude Design
project that v2 **consumes**: it was read via the `claude_design` MCP and turned into
[`docs/plans/2026-08-03-v2-design-system-adoption-plan.md`](../docs/plans/2026-08-03-v2-design-system-adoption-plan.md).
Nothing is pushed to it. Everything above still holds — `/design-sync` (repo → project) remains out of
scope for exactly the reasons given, and no `config.json` or `projectId` pin has been added.
