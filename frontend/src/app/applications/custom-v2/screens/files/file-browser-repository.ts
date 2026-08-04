import type { Observable } from 'rxjs'
import type { BreadcrumbSegment } from '../../layout/breadcrumb.service'

// The seam between the ONE v2 file browser (FileBrowserBase +
// file-browser.component.html/scss) and the two screens that use it
// (personal, space-files). See issue #346.
//
// Browsing, selecting, filtering, dragging, renaming, uploading and every
// dialog flow are identical on both screens; they differ only in WHERE THE
// FILES COME FROM and, consequently, in how a file is addressed on the wire.
// Every one of those differences is a member below. Nothing else may diverge:
// if a future screen needs different *behaviour*, that is a signal the seam is
// in the wrong place, not licence to fork the base again.
//
// IMPORTANT — this is a preservation boundary, not a normalisation opportunity.
// The two screens address the backend differently in ways that are NOT
// guessable from the DTO types (the `space` descriptor, `ownerId`, the compress
// `rootAlias`). Those differences are reproduced here verbatim. Where one of
// them looks like an inconsistency it is flagged in the implementing class, and
// changing it is a separate, deliberate change with its own PR.
export interface FileBrowserRepository {
  // -- Wire identity -------------------------------------------------------

  /**
   * Repository alias — the second segment of every server path
   * (`files/<alias>/…`). Personal returns the SPACE_ALIAS.PERSONAL constant;
   * space-files reads it from the route and returns '' before it resolves.
   *
   * An empty alias means "cannot address the backend yet": the base skips
   * loading, navigation, breadcrumbs, starring and the dock context entirely.
   */
  alias(): string

  /**
   * `space` descriptor attached to the file passed to the link/share dialogs.
   *
   * Personal sends `null`; space-files sends `{ alias, name, root: {…} }`.
   * The dialogs' DTO types are wider than either value, so this cannot be
   * inferred — it is a runtime contract read from the classic UI.
   */
  dialogSpace(): unknown

  /**
   * `ownerId` passed to the link/share dialogs. Personal sends the logged-in
   * user's id; space-files sends `null` even when a user is logged in.
   */
  dialogOwnerId(): number | null

  /** `rootAlias` on each entry of the compress DTO. */
  compressRootAlias(): string

  /**
   * Whether this repository's files are, by construction, owned by the logged-in
   * user. Personal: true. A space: false — ownership is per-root there and comes
   * off the row (`file.root.owner.login`).
   *
   * This is the screen half of classic's file-owner test, verbatim:
   * `spacesBrowserService.inPersonalSpace || file.root?.owner?.login ===
   * userLogin` (files-lock-dialog.component.ts:37). It decides whether the
   * unlock dialog offers Unlock at all, and whether the unlock request carries
   * `forceAsFileOwner=true` (files.service.ts:239). It lives here rather than as
   * an `if` in the base because it is exactly the kind of per-screen wire fact
   * this seam exists for.
   */
  readonly filesAreOwnedByUser: boolean

  // -- Routing -------------------------------------------------------------

  /** Router commands addressing a directory inside this repository. */
  folderRoute(segments: readonly string[]): unknown[]

  /** The full breadcrumb trail for a path inside this repository. */
  breadcrumbs(segments: readonly string[]): BreadcrumbSegment[]

  /**
   * Emits whenever the browser must reload. Personal watches the url alone;
   * space-files must also watch the route params, because the alias lives
   * there and changing spaces keeps the same component instance.
   */
  navigation(): Observable<unknown>

  // -- Labels --------------------------------------------------------------

  /** Title shown at the repository root. */
  rootLabel(): string

  /** Whether `rootLabel()` is an i18n key (personal) or user data (space name). */
  readonly translateRootLabel: boolean

  /** Default archive name offered when compressing at the repository root. */
  rootArchiveName(): string

  /** Text of the keyboard hint badge inside the filter input. */
  filterHint(): string

  // -- Capabilities --------------------------------------------------------

  /** localStorage key for the view mode. Declared on the component instead —
   *  see FileBrowserBase.viewModeStorageKey() for why it cannot live here. */

  /** Whether cmd/ctrl-F focuses the filter input. */
  readonly filterShortcutEnabled: boolean

  /** Whether the toolbar shows a standalone "Download from URL" button. */
  readonly showDownloadFromUrlAction: boolean

  /** Whether a finished compress task auto-downloads its archive. */
  readonly autoDownloadTaskArchive: boolean

  /** Whether `onFabSheetSelect` clears `fabSheetOpen` itself. */
  readonly closeActionSheetOnSelect: boolean

  // -- Hooks ---------------------------------------------------------------

  /** Called after a listing lands, with the alias it was loaded for. */
  onListingLoaded?(alias: string): void

  /** Called from ngOnDestroy for repository-owned subscriptions. */
  onDestroy?(): void
}
