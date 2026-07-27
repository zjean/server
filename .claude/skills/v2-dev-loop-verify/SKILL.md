---
name: v2-dev-loop-verify
description: Browser-verify a custom-v2 frontend change against the local dev server using the agent-browser CLI (NOT the chrome-devtools MCP — Chrome is not installed on this machine). Use this skill whenever the user asks to "test in browser", "verify in the dev server", "load the v2 page and check", "does the rendering look right", "screenshot the change", "smoke-test the v2 viewer/dialog/screen", or when proposing a v2 frontend change that needs visual confirmation before reporting it complete. Also use proactively after editing any file under `frontend/src/app/applications/custom-v2/` if the change is visual or behavioral — the local dev server is the only way to catch v2-specific bugs like the design-token white-on-white from PR #202, which slipped past build and lint. Covers the loopback-hijack workaround, CSRF-authenticated file creation, the `make → PATCH → UNLOCK` dance, Angular debug access for poking signal-based editors, computed-style audits for token bugs, screenshot capture in MCP-allowed paths, and edit-then-save round-trip verification.
---

# Verifying custom-v2 changes against the local dev server

A v2 frontend change can pass `npm run build` and `npm run lint` and still ship broken. The two failure modes that bit us in this fork were both invisible to static checks:

1. **PR #201** — TipTap markdown viewer rendered white text on a white background in v2's dark navy palette, because the skill at the time referenced `var(--si-bg, #fff)` and the `--si-bg` token doesn't exist under `.v2-root`. Build was clean; only browser inspection revealed it.
2. **Subtle DTO/sentinel-id mismatches** in v2 versus the classic UI's contract (the classic-as-ground-truth note in CLAUDE.md exists because these slip past types — runtime values like `id: -1` for "new" are not encoded in the DTO).

This skill is the recipe for catching both classes by exercising the change end-to-end in a real browser.

> ## Read this before Steps 1–2 — the setup below is superseded (2026-07-27)
>
> **Use `agent-browser`, not the `chrome-devtools` MCP.** Google Chrome is not installed on this machine, so the MCP
> cannot launch a browser. `agent-browser` is installed (`/opt/homebrew/bin/agent-browser`) and ships its own Chromium.
> Start with `agent-browser skills get core`. The core loop is `open <url>` → `snapshot -i` → `click @eN`.
>
> **You can start the stack yourself, and it is simpler than Step 1 suggests:**
>
> ```bash
> npm run dev:db && npm run dev:migrate
> npm run -w frontend build      # → dist/static
> npm run dev:backend            # :8080 serves the API *and* the built frontend
> ```
>
> The backend serves `dist/static` via `useStaticAssets`, and the app uses hash routing, so **everything is reachable
> from `http://localhost:8080` on a single origin** — no proxy, no LAN-IP workaround, no `ng serve`. The trade is no
> HMR: rebuild (~8s) after a frontend change. `localhost` worked fine; the VS Code loopback hijack in Step 1 was not
> observed.
>
> **Two `agent-browser` gotchas that cost real time:**
> - **Refs go stale the instant the page changes.** Reading a ref from one snapshot and clicking it after another
>   snapshot opened the *delete* dialog when restore was intended. For destructive actions, click through a scoped
>   `eval` instead: `document.querySelectorAll('.vp-row')[2].querySelector('button[title="Restore this version"]').click()`.
> - **Screenshots intermittently fail** with `Resource temporarily unavailable (os error 35)` while `eval` and `get`
>   keep working; retry after a few seconds. For anything measurable, `eval` beats a screenshot anyway — measuring line
>   boxes caught a double-spacing bug that eyeballing an image did not.
>
> Steps 3–8 below (CSRF fixture creation, the `make → PATCH → UNLOCK` dance, the design-token audit, Angular debug
> access, round-trip verification) are still accurate — translate `evaluate_script` to `agent-browser eval` and
> `take_snapshot` to `agent-browser snapshot -i`.

## Step 1 — Find the dev server and dodge the loopback hijack

On the maintainer's machine, **VS Code's helper process listens on `127.0.0.1:8080`**, so `curl http://localhost:8080/` and `chrome-devtools new_page http://localhost:8080/` both time out. The sync-in dev server binds `*:8080` and is reachable via the LAN IP. The Code Helper hijacks loopback specifically; LAN addresses work.

```bash
# Confirm sync-in is running (you want a `node` process, not just Code Helper).
lsof -nP -iTCP:8080 -sTCP:LISTEN
# Expect:  node  <PID>  ... TCP *:8080 (LISTEN)
# Sometimes also: Code Helper  <PID>  ... TCP 127.0.0.1:8080 (LISTEN)  ← the hijacker

# Discover the active LAN IP.
/sbin/ifconfig en0 | rtk proxy grep 'inet '
# Or scan all interfaces for the active one (status: active + inet a 192.168.x.x).
```

From here on every URL in the skill uses the LAN IP — `http://192.168.x.x:8080/...` — not `localhost`. Substitute the actual IP you found.

If neither process is listening, `lsof` will be empty. Tell the user the dev server isn't running and ask them to start it (e.g. `npm --prefix backend run start:dev` plus the frontend, depending on their setup). Don't guess at the command.

## Step 2 — Log in

```javascript
// chrome-devtools: new_page, take_snapshot, fill, click
// 1. new_page  → http://<LAN-IP>:8080/   (lands on /#/auth/login)
// 2. take_snapshot  → note the login + password textbox uids and Sign-in button uid
// 3. fill  → username textbox uid: "sync-in"      (from CLAUDE.md memory)
// 4. fill  → password textbox uid: "password"
// 5. click → Sign-in button uid (with includeSnapshot: true to advance and re-read)
```

Successful login lands you on `/#/recents` (classic UI by default). To reach v2, navigate directly to `/#/v2/<route>` — e.g. `/#/v2/file?path=files/personal/<name>` for the unified preview, `/#/v2/personal` for the file browser. Direct URL is more reliable than the "Probeer de nieuwe UI" toggle.

If `take_snapshot` shows `uid=X RootWebArea "Sync-in"` with a "Sign-in to your account" heading and two textboxes, you're at the login page. If it shows the sidebar with "Recente bestanden" / "Persoonlijk" / etc., you're already authenticated (the session cookie is sticky across `chrome-devtools` reloads).

## Step 3 — Create test fixtures via the authenticated API

`fetch()` calls inside `evaluate_script` inherit the browser's auth cookies, so they're the cleanest way to create test files. **All write methods require a CSRF header.** The token is in a cookie called `sync-in-csrf`, and the header name is also `sync-in-csrf` (URL-decode the cookie value first):

```javascript
const csrf = decodeURIComponent(
  (document.cookie.split('; ').find((c) => c.startsWith('sync-in-csrf=')) || '')
    .slice('sync-in-csrf='.length)
)
const headers = { 'sync-in-csrf': csrf }
```

The file-creation route is **non-obvious** and got me three 404s before I found it. Here's the actual flow.

### Why `POST upload` alone doesn't work

`POST /api/app/spaces/operation/upload/files/personal` returns `405 Resource already exists` — the server interprets `files/personal` as the *parent directory* and the multipart filename as the new file, but because `files/personal` exists as a tree, POST refuses. The right flow is:

1. `POST .../operation/make/files/personal/<filename>` — creates an empty file at that exact path (201).
2. `UNLOCK .../operation/files/personal/<filename>` — the `make` may leave a fresh exclusive lock; release it before continuing.
3. `PATCH .../operation/upload/files/personal/<filename>` — overwrites the (now empty) file with multipart-form content. Note: the URL goes to the full file path, **not** the parent dir; the multipart filename inside the form is ignored for this route.
4. `UNLOCK .../operation/files/personal/<filename>` — `PATCH upload` also locks; release again so the v2 viewer doesn't open the file in read-only mode.

A clean helper, all in one `evaluate_script`:

```javascript
async () => {
  const csrf = decodeURIComponent(
    (document.cookie.split('; ').find((c) => c.startsWith('sync-in-csrf=')) || '')
      .slice('sync-in-csrf='.length)
  )
  const path = 'files/personal/tiptap-test.md'
  const base = '/api/app/spaces/operation'
  const headers = { 'sync-in-csrf': csrf }

  // 1. Create empty file (idempotent — 201 first time, 405 "already exists" later).
  await fetch(`${base}/make/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'file' })
  })

  // 2. Release any lock left by make.
  await fetch(`${base}/${path}`, { method: 'UNLOCK', headers })

  // 3. PATCH content. The URL targets the full file path; multipart wraps content.
  const content = `# Hello v2\n\nSome **bold** content.\n`
  const form = new FormData()
  form.append('file', new File([new Blob([content])], 'tiptap-test.md', { type: 'text/markdown' }))
  const upload = await fetch(`${base}/upload/${path}`, { method: 'PATCH', body: form, headers })

  // 4. Release the lock PATCH left behind.
  await fetch(`${base}/${path}`, { method: 'UNLOCK', headers })

  return { uploadStatus: upload.status }
}
```

Expected response: `{ uploadStatus: 200 }`. Anything else means the dev server is rejecting the write — re-check CSRF, check the user's space is provisioned (recents in classic UI should list at least one file before you trust the API).

For non-write reads — listing the personal space, reading file content back, listing recents — no CSRF needed, just a same-origin `fetch()`. The endpoints I confirmed today:

- `GET /api/app/spaces/browse/files/personal` → `{ files: [...], hasRoots: bool, permissions: '...' }`
- `GET /api/app/spaces/recents` → `[{ id, ownerId, path, name, mime, mtime }, ...]`
- `GET /api/app/spaces/operation/<full-path>` → raw file content as `text/plain` / file mime
- `GET /api/app/spaces/list` → list of spaces the user belongs to

## Step 4 — Navigate to the change and snapshot

```
navigate_page → http://<LAN-IP>:8080/#/v2/file?path=files/personal/tiptap-test.md
wait_for      → any string you expect on the rendered page (e.g. "TipTap test file" for a markdown viewer, or "Opgeslagen" for the saved status)
take_snapshot → structural confirmation; check the right viewer mounted (selector like .ProseMirror for TipTap, .cm-editor for CodeMirror, .office-iframe for OnlyOffice, etc.)
```

Use `take_screenshot` for visual confirmation. **Path gotcha**: chrome-devtools enforces workspace roots; `/tmp/foo.png` is rejected. Save under `$TMPDIR` (which on macOS resolves to something like `/var/folders/zc/.../T/`) or under the repo. The repo path keeps screenshots reviewable later but bloats the workspace; `$TMPDIR` is fine for throwaway smoke tests. Then `Read` the file path to surface it inline for the user.

## Step 5 — Audit computed styles (the v2 design-token check)

This step catches the PR #202 class of bug: the build is clean, the page renders, but a token resolves to its `var()` fallback and paints a light surface under dark text.

Walk from the leaf element up to `.v2-root` and dump `color` + `background-color` at each step. Anything where the leaf is `oklch(0.9x ...)` (near-white text) on an `rgb(255,255,255)` ancestor is a smoking gun.

```javascript
() => {
  const pm = document.querySelector('.ProseMirror') || document.querySelector('.cm-editor')
  if (!pm) return { error: 'no editor leaf found — adjust the selector' }
  const trail = []
  let el = pm
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el)
    trail.push({
      tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/).slice(0, 3).join('.') : ''),
      color: cs.color,
      bg: cs.backgroundColor,
      siBg0: cs.getPropertyValue('--si-bg0').trim(),
      siFg: cs.getPropertyValue('--si-fg').trim()
    })
    el = el.parentElement
  }
  return trail
}
```

What to look for:
- `--si-bg0` and `--si-fg` should be set somewhere along the chain — usually at `.v2-root`. If both are empty all the way up, the component isn't under `.v2-root` (wrong mount) or the token bundle didn't load.
- The leaf `color` should be near-white in v2 (`oklch(0.9x ...)`) and the closest `backgroundColor` should be navy (`oklch(0.22 0.028 255)` or one of the `--si-bg0`–`--si-bg6` variants).
- `rgb(255, 255, 255)` anywhere as a background under navy text = the bug. The component is reaching for a token that doesn't exist (commonly `--si-bg` or `--si-danger`) and the `var()` fallback fired.

If you find a token bug, refer to the **Style token translation** section of `sync-in-fork-maintenance` — it has the rewrite table.

## Step 6 — Drive the editor (signals + ProseMirror edition)

Synthetic `InputEvent('beforeinput', ...)` and `document.execCommand` **do not trigger TipTap's `onUpdate`** in headless browsing. The text changes in the DOM but the editor's transaction system never fires, so `isModified` stays false and Save stays disabled. Don't waste time on synthetic events.

The reliable path: reach the Angular component instance through the dev-mode debug API, then call its underlying TipTap editor directly. This requires a dev build (Angular strips `window.ng` from production bundles).

```javascript
() => {
  const ng = window.ng
  if (!ng) return { error: 'window.ng not available — production build?' }
  const host = document.querySelector('app-v2-preview-markdown-view')
  const component = ng.getComponent(host)
  // For TipTap: drive the editor directly through the chain API.
  component.editor.chain().focus('end').insertContent('\n\n[smoke-test edit]').run()
  return { modified: component.isModified() }
}
```

For CodeMirror-backed `text-code-view`, the equivalent is `component.content.set('new content')` — the `content` signal is what `ngModel` is bound to, and updating it dirties the form. Adapt the selector and the method to the component you're testing.

After the edit, take a fresh snapshot — the status pill should now read "Aangepast" (Modified) and the Save button should be enabled. If it doesn't, the component's reactivity isn't wired correctly.

## Step 7 — Save and verify the round-trip

```javascript
() => {
  // Find the Save button in the v2 toolbar by visible label.
  const btn = Array.from(document.querySelectorAll('app-v2-btn button'))
    .find((b) => /Opslaan|Save/i.test(b.textContent || ''))
  if (!btn || btn.disabled) return { error: 'no enabled save button' }
  btn.click()
  return { ok: true }
}
```

Then `wait_for ["Opgeslagen", "Saved"]` (typically <1s), and finally fetch the file back to confirm the new content actually persisted:

```javascript
async () => {
  const r = await fetch('/api/app/spaces/operation/files/personal/tiptap-test.md')
  const text = await r.text()
  return { length: text.length, tail: text.slice(-200) }
}
```

If the tail contains your edit, the round-trip works. If it doesn't, the editor's serializer is producing different output from what's being PATCHed — that's a serializer bug, not a save bug, and worth a deeper look.

## Step 8 — Clean up

Test files left in `/files/personal/` aren't destructive but they accumulate. At the end of a session:

```javascript
async () => {
  const csrf = decodeURIComponent(
    (document.cookie.split('; ').find((c) => c.startsWith('sync-in-csrf=')) || '')
      .slice('sync-in-csrf='.length)
  )
  // Delete uses the DELETE method on the operation path; the same lock release applies.
  await fetch('/api/app/spaces/operation/files/personal/tiptap-test.md', { method: 'UNLOCK', headers: { 'sync-in-csrf': csrf } })
  return await fetch('/api/app/spaces/operation/files/personal/tiptap-test.md', { method: 'DELETE', headers: { 'sync-in-csrf': csrf } }).then((r) => r.status)
}
```

Or leave the file — it doesn't hurt anything and may be useful for the next verification round.

## Reporting back to the user

If a human is watching the session: surface a screenshot via `Read` after `take_screenshot` so the rendered state appears inline. Pair it with the computed-style trail for any layout/contrast issue. Quote concrete uids when describing what's on the page; don't say "the editor area" without anchoring it.

If the smoke run found a real bug (token mismatch, save failure, missing dispatch branch), state it clearly with the smoking-gun evidence — the white-bg + near-white-fg pair for the PR #202 family, or the un-changed file content for save failures. Don't bury it in a list of things-that-worked.

## When this skill doesn't apply

- The change is purely backend / non-visual: just unit tests are sufficient. This skill is overkill.
- The dev server isn't running and the user is mid-flow: ask before spending tool calls trying to start it. Spin-up needs DB + config knowledge that's user-specific.
- The change is in `frontend/src/app/applications/` outside `custom-v2/` (i.e., classic UI): the LAN-IP / login / API helpers all still work, but the design-token check (Step 5) is specific to `.v2-root`'s navy palette. Skip it for classic.
