// Where a file came from, and how to say so on one line.
//
// The v2 lists render `FileRecentModel.showedPath`, which is the file's path with
// its REPOSITORY PREFIX STRIPPED — and the prefix is exactly the part that says
// whether you are looking at your own file, a file in a shared Space, or
// something someone sent you. So the recents list showed 'benchmarks',
// 'Projects' and 'company-handbook/Policies' as if they were the same kind of
// address, and rendered a generic folder icon beside every one of them.
//
// The origin is already known: the model derives its own icon from `shareId` and
// `spaceId` (file-recent.model.ts), and those two fields are in every payload.
// This reads the same two fields, so the label and that icon cannot disagree.
//
// ─── Why this is a glyph and not a badge, and not a word either ────────────
// A coloured badge was the obvious move and it is wrong twice over. Origin is a
// property of EVERY row, and v2's colour budget exists to prevent exactly that
// kind of ubiquity: `--si-violet` — the tone that actually means Space identity
// and "shared with others" — is documented "CAPPED AT ONE INSTANCE PER VIEW", so
// sixteen violet badges is not a near-miss, it is the inverse of the rule. A
// neutral badge on all sixteen rows keeps the budget but spends an element and a
// column on styling rather than on information.
//
// Prefixing the label as TEXT was the second attempt, and rendering it proved it
// wrong for a different reason: almost every file on a given instance shares one
// origin, so the list read "Space · …" sixteen times down the column. Same
// ubiquity problem, in words instead of colour — and it pushed the part that
// actually varies (the path) to the right, behind a constant.
//
// So the origin is carried by the glyph the location line ALREADY had, which was
// a hard-coded `folder` on every row regardless of where the file came from. The
// mapping below is the left nav's own vocabulary — Personal is `folder`, Spaces
// is `box`, Shared is `share` — so the glyph beside a path matches the sidebar
// entry that file lives under, and the row spends no extra width and no colour.
// The words remain as the accessible name for the glyph, and as the fallback for
// a file sitting at a repository root where there is no path to show.

import { IconV2Name } from '../icons/icon-v2.component'

export type FileOrigin = 'personal' | 'space' | 'share'

// i18n keys. 'Shared' rather than 'Share' because the label describes how the
// file reached you, not the object type.
export const FILE_ORIGIN_LABELS: Record<FileOrigin, string> = {
  personal: 'Personal',
  space: 'Space',
  share: 'Shared'
}

export interface FileOriginSource {
  shareId?: number | null
  spaceId?: number | null
}

// Order matters and mirrors FileRecentModel's own icon expression exactly
// (`shareId ? SHARES : spaceId ? SPACES : PERSONAL`): a file reached through a
// share carries BOTH ids, and in that case the share is the truthful answer —
// it is how the user got to the file, and the space it happens to live in may
// not even be one they can open.
export function fileOriginOf(file: FileOriginSource): FileOrigin {
  if (file.shareId) return 'share'
  if (file.spaceId) return 'space'
  return 'personal'
}

// The left nav's own icon vocabulary, so a row's origin glyph and the sidebar
// entry that file lives under are the same mark. Typed as IconV2Name rather than
// string, so an icon renamed in the set breaks this at compile time instead of
// rendering an empty square.
export const FILE_ORIGIN_ICONS: Record<FileOrigin, IconV2Name> = {
  personal: 'folder',
  space: 'box',
  share: 'share'
}

// The location text: the path with its repository prefix stripped, tidied of
// stray slashes. Returns '' for a file at a repository root — the caller
// substitutes the origin label there, because a row that shows nothing at all
// where every sibling shows a path reads as a rendering fault rather than as "this
// file is at the top".
export function fileLocationPath(showedPath: string | null | undefined): string {
  return (showedPath ?? '').replace(/^\/+|\/+$/g, '')
}

// ─── For screens that hold a full repository path rather than a split one ───
// A recents row arrives pre-split: `path` is the parent directory and the model
// has already computed `showedPath` with the repository prefix removed. Favorites,
// shares and the trash bins do not — they carry one addressable `navPath` like
// `files/personal/Projects/notes.md`, and each was doing its own ad-hoc slicing of
// it. Favorites' version kept the prefix, so it displayed
// `files/product-team/Roadmap` where recents displayed `product-team/Roadmap` for
// the same file, and returned a bare '/' at a root.
//
// These two mirror `FileRecentModel`'s own derivation so the two families of
// screen describe one file the same way.

// Origin from an addressable path. The same three answers as fileOriginOf, read
// from the prefix instead of from the ids, for callers that have no ids.
export function fileOriginFromPath(path: string | null | undefined, repositories: { files: string; shares: string }, personalAlias: string): FileOrigin {
  const [repo, alias] = (path ?? '').split('/').filter(Boolean)
  if (repo === repositories.shares) return 'share'
  if (repo === repositories.files && alias === personalAlias) return 'personal'
  return 'space'
}

// Drops the repository prefix, exactly as FileRecentModel does: two segments for
// a personal path (the repository AND the `personal` alias, which is not a folder
// the user recognises), one segment otherwise (keeping the space or share alias,
// which they do). Pass `dropLast` for a path that ends in the file's own name.
export function stripRepositoryPrefix(path: string | null | undefined, personalAlias: string, dropLast = false): string {
  const segs = (path ?? '').split('/').filter(Boolean)
  if (dropLast) segs.pop()
  return segs.slice(segs[1] === personalAlias ? 2 : 1).join('/')
}
