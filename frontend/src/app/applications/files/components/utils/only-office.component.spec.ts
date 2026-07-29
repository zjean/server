// The `historyHooks` mod on the shared OnlyOffice editor component.
//
// This component is used by BOTH the classic viewer
// (files/components/viewers/files-viewer-only-office.component.ts) and the v2
// office view, and only v2 supplies history hooks. So the load-bearing assertion
// here is the NEGATIVE one: with the input absent, the events object is exactly
// what it was before the mod. That is what makes "the classic viewer is
// unchanged" a fact rather than a claim — and it is cheaper and more durable to
// pin here than to re-verify in a browser on every change.
//
// No TestBed: this component injects nothing, so it can simply be constructed.
// `onLoad` is private, so the spec casts to the surface it drives — the same
// device the other v2 specs use.

import { afterEach, describe, expect, it } from 'vitest'
import type { OnlyOfficeConfig } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.interface'
import type { OnlyOfficeHistoryHooks } from '../../../custom-v2/models/only-office-history.model'
import { OnlyOfficeComponent } from './only-office.component'

interface Loadable {
  id: string
  config: OnlyOfficeConfig
  historyHooks?: OnlyOfficeHistoryHooks
  onLoad: () => void
}

// The specs run in a DOM-less node environment (see test-setup.ts), so there is
// no `window` at all — and the component reads `window.DocsAPI` inside a
// try/catch, which means its absence is SWALLOWED into the -3 error path rather
// than failing loudly. Hence an explicit window, or every case below would pass
// its way to a vacuous truth.
function stubWindow(): { seen: OnlyOfficeConfig[] } {
  const seen: OnlyOfficeConfig[] = []
  const g = globalThis as unknown as { window?: unknown }
  g.window = {
    DocEditor: { instances: {} },
    // The document server's api.js, reduced to the one thing this spec cares
    // about: what config it is handed.
    DocsAPI: {
      DocEditor: (_id: string, config: OnlyOfficeConfig) => {
        seen.push(config)
        return {}
      }
    }
  }
  return { seen }
}

function mount(historyHooks?: OnlyOfficeHistoryHooks): { component: Loadable; seen: OnlyOfficeConfig[] } {
  const { seen } = stubWindow()
  const component = new OnlyOfficeComponent() as unknown as Loadable
  component.id = 'doc-1'
  component.config = { document: { title: 'a.docx' } } as unknown as OnlyOfficeConfig
  component.historyHooks = historyHooks
  return { component, seen }
}

const HOOKS: OnlyOfficeHistoryHooks = {
  onRequestHistory: () => undefined,
  onRequestHistoryData: () => undefined,
  onRequestRestore: () => undefined,
  onRequestHistoryClose: () => undefined
}

describe('OnlyOfficeComponent — historyHooks', () => {
  // The environment has no window of its own, so leaving the stub behind would
  // hand the next spec file a half-real global.
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  // THE regression guard for the classic viewer. It shares this component and
  // supplies no hooks, so its events object must be exactly the pre-mod one.
  it('supplies ONLY onDocumentStateChange when no hooks are given', () => {
    const { component, seen } = mount(undefined)

    component.onLoad()

    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0].events)).toEqual(['onDocumentStateChange'])
  })

  // The document server derives the affordance from the events it is handed:
  // `canUseHistory = _config.events && !!_config.events.onRequestHistory`
  // (documentserver 9.3 web-apps/apps/api/documents/api.js), and
  // `canHistoryClose` from onRequestHistoryClose. So all four have to arrive, and
  // onDocumentStateChange must survive alongside them.
  it('adds the four history events without displacing onDocumentStateChange', () => {
    const { component, seen } = mount(HOOKS)

    component.onLoad()

    expect(Object.keys(seen[0].events).sort()).toEqual(
      ['onDocumentStateChange', 'onRequestHistory', 'onRequestHistoryClose', 'onRequestHistoryData', 'onRequestRestore'].sort()
    )
  })

  // The hooks are FUNCTIONS on the far side of the config deep-clone. onLoad does
  // `JSON.parse(JSON.stringify(this.config))`, which is exactly why they cannot
  // travel inside `config` — and this asserts the spread happens after it, so
  // they are still callable.
  it('hands over callable functions, not clone-flattened values', () => {
    const { component, seen } = mount(HOOKS)

    component.onLoad()

    const events = seen[0].events as unknown as Record<string, unknown>
    expect(typeof events.onRequestHistory).toBe('function')
    expect(typeof events.onRequestRestore).toBe('function')
  })

  // An empty object is a legitimate value for the input and must not fabricate an
  // affordance: `!!events.onRequestHistory` on a missing key is false, so the
  // editor offers nothing — but the assertion is that we did not add stray keys.
  it('treats an empty hooks object as no hooks', () => {
    const { component, seen } = mount({})

    component.onLoad()

    expect(Object.keys(seen[0].events)).toEqual(['onDocumentStateChange'])
  })
})
