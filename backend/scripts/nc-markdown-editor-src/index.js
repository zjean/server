// Entry point for the NC markdown-editor TipTap bundle.
// Built by scripts/build-nc-markdown-editor.mjs into
// src/applications/custom-mobile-compat/assets/tiptap.bundle.js
//
// Mirrors the CodeMirror bundle's contract (see nc-text-editor-src/index.js):
// the page dynamic-imports the bundle and calls `mountTipTap(host, opts)`.
// The returned object exposes the same { getValue, setValue, setReadOnly,
// focus, onChange, destroy } shape the page bootstrap already uses for
// CodeMirror, so save/load wiring in markdown-editor-page.ts can stay
// editor-agnostic.
//
// Markdown round-trip is provided by @tiptap/markdown: the editor accepts
// markdown via setContent(..., { contentType: 'markdown' }) and emits markdown
// via editor.getMarkdown().

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TaskItem } from '@tiptap/extension-list'
import { TaskList } from '@tiptap/extension-task-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'

export function mountTipTap(host, opts) {
  const changeListeners = new Set()

  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: true }),
      Markdown
    ],
    editable: !opts.readOnly,
    content: opts.initial ?? '',
    contentType: 'markdown',
    onUpdate: () => {
      for (const fn of changeListeners) {
        try {
          fn()
        } catch {
          /* listener errors must not break the editor */
        }
      }
    }
  })

  // Notify host whenever an editor transaction lands so the page can refresh
  // toolbar active states without re-querying every keystroke from a timer.
  const selectionListeners = new Set()
  editor.on('selectionUpdate', () => {
    for (const fn of selectionListeners) {
      try {
        fn()
      } catch {
        /* listener errors must not break the editor */
      }
    }
  })
  editor.on('transaction', () => {
    for (const fn of selectionListeners) {
      try {
        fn()
      } catch {
        /* listener errors must not break the editor */
      }
    }
  })

  // Belt-and-suspenders: expose the editor on a global the page's toolbar
  // bootstrap can grab. Avoids threading a ref through the page closure.
  if (typeof window !== 'undefined') {
    window.NcMarkdownEditor = window.NcMarkdownEditor || {}
    window.NcMarkdownEditor.activeEditor = editor
  }

  return {
    // The editor itself is exposed for richer integrations (toolbar wiring).
    editor,
    getValue: () => editor.getMarkdown(),
    setValue: (v) => {
      editor.chain().setMeta('addToHistory', false).setContent(v ?? '', { emitUpdate: false, contentType: 'markdown' }).run()
    },
    setReadOnly: (ro) => {
      editor.setEditable(!ro, false)
    },
    focus: () => editor.commands.focus(),
    onChange: (fn) => {
      changeListeners.add(fn)
    },
    onSelectionChange: (fn) => {
      selectionListeners.add(fn)
    },
    isActive: (name, attrs) => (attrs ? editor.isActive(name, attrs) : editor.isActive(name)),
    can: () => editor.can(),
    destroy: () => {
      editor.destroy()
      if (typeof window !== 'undefined' && window.NcMarkdownEditor?.activeEditor === editor) {
        window.NcMarkdownEditor.activeEditor = null
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.NcMarkdownEditor = window.NcMarkdownEditor || {}
  window.NcMarkdownEditor.mountTipTap = mountTipTap
}
