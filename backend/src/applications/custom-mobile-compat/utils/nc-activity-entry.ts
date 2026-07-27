// Build one entry of /ocs/v2.php/apps/activity/api/v2/activity.
//
// EVERY FIELD HERE IS MANDATORY AND MUST BE NON-NULL, and that is not a style
// preference — it is forced by how the Android client parses and renders.
//
// The authorities, all read before writing this:
//
//   - nextcloud/android-library .../activities/GetActivitiesRemoteOperation.java
//     — the endpoint, the query params, the `ocs.data` navigation, and the
//       X-Activity-Last-Given paging header.
//   - nextcloud/android-library .../activities/model/Activity.kt — the model.
//     It is a Kotlin data class of NON-NULL `String` properties parsed by Gson,
//     and GSON BYPASSES KOTLIN'S NULL CHECKS. A field missing from the JSON
//     lands as `null` in a `String` property and does not fail at parse time —
//     it throws at the first `.isNotEmpty()` on the render path instead, which
//     is why "just omit the ones we don't have" is not an option.
//   - nextcloud/android-library .../activities/model/RichElementTypeAdapter.java
//     — `subject_rich` is read with an UNCONDITIONAL `in.beginArray()`. Send an
//       object or a string there and it throws IllegalStateException.
//   - nextcloud/android .../activities/adapter/ActivityListAdapter.kt — the
//     render path: `activity.datetime.time`, `activity.subject.isNotEmpty()`,
//     `activity.message.isNotEmpty()`, `activity.icon.endsWith(...)` (called
//     UNCONDITIONALLY, so `icon` must be a string even when empty).
//   - nextcloud/android .../activities/adapter/ActivityAndVersionListAdapter.kt
//     — sorts activities and file versions into one list by
//       `datetime.time` / `modifiedTimestamp`, which is why this endpoint
//       existing at all is what makes the versions list render (see below).
//
// WHY THIS ENDPOINT EXISTS IN THIS FORK. It is not for the activity feed. NC
// Android's file-detail Activities tab fetches activities AND file versions in
// one task, then calls populateList only inside
// `if (result.isSuccess() && result.getData() != null)` on the ACTIVITIES
// result. Without a parseable response there, the version list from the NC
// versions DAV tree never renders. Note the failure is subtler than "the call
// 404s": GetActivitiesRemoteOperation.isSuccess() deliberately ACCEPTS 404
// (200, 304 and 404 all count), so a server without the activity app still
// works — but it then parses the body unconditionally, and
// `jo.getAsJsonObject("ocs").getAsJsonArray("data")` throws NullPointerException
// on any body without an `ocs` key. Nest's own 404 JSON is exactly such a body,
// and RemoteOperation.execute does not catch it. So the fix is not "return 200"
// — it is "return an OCS-shaped body".
//
// TWO DELIBERATE SIMPLIFICATIONS, both to avoid nullable dereferences on the
// render path:
//
//   1. `subject_rich` is always the EMPTY ARRAY, and the human text goes in
//      `subject`. Real NC sends `["{file} was changed", { file: {...} }]`, which
//      makes ActivityListAdapter take its clickable-chip branch —
//      `applyClickableNameSpan` / `applyMentionSpan`, which dereference
//      `RichObject.name` and `.id` (both `String?`). An empty array parses to
//      `RichElement("", [])` via the adapter's own default constructor, so
//      `bindSubject` falls through to the plain-text branch and `bindPreviews`
//      hides the thumbnail grid. Plain text, zero null risk.
//   2. `previews` is always empty. It is only iterated when richObjectList is
//      non-empty, which (1) guarantees it never is — but an absent field would
//      still be a null list, so the key is emitted.

import type { NcSyncEvent } from '../services/nc-sync-log.service'

// NC's own `type` values for the files app, from the activity app's
// FileProvider. The Android adapter does not switch on them, but the iOS
// client and any third-party reader do, and inventing values would be a lie
// about what happened.
const ACTIVITY_TYPE_BY_EVENT: Record<NcSyncEvent['type'], string> = {
  create: 'file_created',
  update: 'file_changed',
  delete: 'file_deleted'
}

// The human-readable subject. Upstream localizes these server-side; this fork
// has no server-side i18n for NC clients (the whole compat surface is
// English-only), so they are plain English, matching how the rest of
// custom-mobile-compat emits user-facing strings.
const SUBJECT_BY_EVENT: Record<NcSyncEvent['type'], string> = {
  create: 'created',
  update: 'changed',
  delete: 'deleted'
}

export interface NcActivityEntry {
  activity_id: number
  datetime: string
  date: string
  app: string
  type: string
  user: string
  affecteduser: string
  subject: string
  message: string
  icon: string
  link: string
  object_type: string
  object_id: number
  object_name: string
  previews: unknown[]
  subject_rich: unknown[]
}

// `login` is both `user` and `affecteduser`: the sync log records the file's
// OWNER, not the actor (see nc-sync-events.schema.ts), so for the personal-space
// scope this endpoint serves they are the same person. Emitting a guessed actor
// would be worse than emitting the one identity we actually know.
export function buildNcActivityEntry(event: NcSyncEvent, login: string, fileId: number, serverUrl: string): NcActivityEntry {
  const name = fileName(event.path)
  // ISO 8601 with an explicit offset. Gson's default Date deserialization tries
  // the locale DateFormat first and then ISO8601Utils, which parses this form;
  // `datetime` must parse or `datetime.time` NPEs in the adapter's sort.
  const datetime = new Date(event.ts).toISOString()
  return {
    activity_id: event.id,
    datetime,
    // `date` is the legacy duplicate of `datetime`, per the model's own comment.
    date: datetime,
    app: 'files',
    type: ACTIVITY_TYPE_BY_EVENT[event.type],
    user: login,
    affecteduser: login,
    subject: `You ${SUBJECT_BY_EVENT[event.type]} ${name}`,
    message: '',
    // Empty rather than a URL: bindIcon skips the Glide load when this is empty
    // and still calls .endsWith() on it, so '' is the safe value. We serve no
    // activity icon assets, and pointing at one that 404s would put a broken
    // load in every row.
    icon: '',
    link: `${serverUrl}/remote.php/dav/files/${encodeURIComponent(login)}/${event.path.split('/').map(encodeURIComponent).join('/')}`,
    object_type: 'files',
    // The model types this as String; Gson coerces a JSON number to String
    // happily, and every other endpoint in this module emits real DB ids as
    // numbers. Kept a number for consistency with those.
    object_id: fileId,
    object_name: name,
    previews: [],
    // See simplification (1) in the header comment. MUST be an array.
    subject_rich: []
  }
}

function fileName(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}
