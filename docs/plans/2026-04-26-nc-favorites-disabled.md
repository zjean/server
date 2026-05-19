# NC mobile: favorites are disabled (omitted, not zero)

Date: 2026-04-26

## State

Sync-in doesn't model file/folder favorites — no DB column, no API
endpoint, no web UI. The only "favorite" hit in the codebase is an
unrelated OnlyOffice toolbar field.

To keep the NC mobile UX honest, we **omit** `<oc:favorite>` from PROPFIND
responses entirely. NC iOS / Android hide the star icon and the "Add to
favorites" file-menu action when the prop is absent — exactly the right
behavior for a server that doesn't support the feature.

## Why omit instead of emitting `0`

NC clients distinguish:

- `<oc:favorite>` **absent** → server doesn't advertise the feature → UI hides it.
- `<oc:favorite>0</oc:favorite>` → "this file isn't favorited yet, but you can star it" → UI shows star + action; tapping triggers a `PROPPATCH <oc:favorite>1` we'd have to 501. Confusing error toast.

We previously emitted `0`. The fix flips to absent.

## Lifting the disable

When upstream Sync-in adds favorites, re-add the prop in
`backend/src/applications/custom-mobile-compat/services/nc-propfind.service.ts`:

```ts
'oc:favorite': isFavoriteForUser(f, req.user) ? '1' : '0',
```

…and wire `PROPPATCH <oc:favorite>` in `nc-dav.controller.ts` to call the
upstream toggle endpoint.

## Adding favorites upstream — rough scope

Real effort: **2–4 days**, suitable for an `upstream-contrib/` branch
rooted at `upstream/main`. Pieces:

| Layer | Work |
|---|---|
| DB | `users_files_favorites(userId, fileId)` join table + migration |
| Backend API | `POST/DELETE /api/files/:id/favorite`, `GET /api/files/favorites` |
| Web UI (v2) | Star toggle on file rows + Favorites entry in sidebar |
| PROPFIND `<oc:favorite>` | Per-user lookup against the join table |
| `PROPPATCH <oc:favorite>` | Persist via the same join table |
| `REPORT <d:favorites>` | Lists favorited files (NC's own listing endpoint) |
| OCS capability | Advertise `files.favorites: true` |

A per-user join table (vs. a `files.is_favorite` column) is the right shape
because favorites are per-viewer — Alice and Bob can star the same shared
file independently.
