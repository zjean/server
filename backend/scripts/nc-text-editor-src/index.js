// Entry point for the NC text-editor CodeMirror bundle.
// Built by scripts/build-nc-text-editor.mjs into
// src/applications/custom-mobile-compat/assets/codemirror.bundle.js
//
// The bundle is loaded as an IIFE; esbuild exports `mountCodeMirror` on a
// `NcTextEditor` global. The page's bootstrap script in
// utils/text-editor-page.ts dynamic-imports the bundle and reads
// `mod.mountCodeMirror` (esbuild's IIFE format also exposes named exports
// when imported as a module via `import()` because the loader synthesizes
// a default-binding). To keep the page loader portable we *also* hang the
// function on `window.NcTextEditor.mountCodeMirror`, so the bootstrap can
// fall back to the global if module-import semantics differ.

import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'

// Map of language ids the server hands us → CM language extension.
// Page-side `inferLanguage()` (controllers/nc-text-editor.controller.ts)
// produces the keys; keep them in sync.
const LANGS = {
  markdown: () => markdown(),
  javascript: () => javascript(),
  // Treat TS as JS — `lang-javascript` includes JSX/TSX support; pulling in
  // a separate lang-typescript would double bundle size for marginal value
  // on a phone editor.
  typescript: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  xml: () => xml(),
  yaml: () => yaml(),
  python: () => python(),
  text: () => []
}

export function mountCodeMirror(host, opts) {
  const langFn = LANGS[opts.language] || LANGS.text
  const langCompartment = new Compartment()
  const themeCompartment = new Compartment()
  const readOnlyCompartment = new Compartment()
  const isDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches

  const changeListeners = new Set()
  const onUpdate = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      for (const fn of changeListeners) {
        try {
          fn()
        } catch {
          /* listener errors must not break the editor */
        }
      }
    }
  })

  const state = EditorState.create({
    doc: opts.initial ?? '',
    extensions: [
      basicSetup,
      keymap.of([...defaultKeymap, indentWithTab]),
      langCompartment.of(langFn()),
      themeCompartment.of(isDark ? oneDark : []),
      readOnlyCompartment.of(EditorState.readOnly.of(!!opts.readOnly)),
      onUpdate,
      EditorView.lineWrapping
    ]
  })

  const view = new EditorView({ state, parent: host })

  // React to color-scheme changes while the editor is open. Rare in practice
  // (user backgrounds the app, OS toggles dark mode, returns) but cheap to
  // support and feels jarring without it.
  const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  const onSchemeChange = (e) => {
    view.dispatch({ effects: themeCompartment.reconfigure(e.matches ? oneDark : []) })
  }
  if (mq?.addEventListener) {
    mq.addEventListener('change', onSchemeChange)
  } else if (mq?.addListener) {
    mq.addListener(onSchemeChange)
  }

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (v) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v ?? '' } })
    },
    setReadOnly: (ro) => {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!ro)) })
    },
    focus: () => view.focus(),
    onChange: (fn) => {
      changeListeners.add(fn)
    },
    destroy: () => {
      view.destroy()
      if (mq?.removeEventListener) {
        mq.removeEventListener('change', onSchemeChange)
      } else if (mq?.removeListener) {
        mq.removeListener(onSchemeChange)
      }
    }
  }
}

// Belt-and-suspenders: also expose the function on a global so callers
// using `<script src="…">` (or quirky dynamic-import semantics) can find it.
if (typeof window !== 'undefined') {
  window.NcTextEditor = window.NcTextEditor || {}
  window.NcTextEditor.mountCodeMirror = mountCodeMirror
}
