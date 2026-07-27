import type { NcSyncEvent } from '../services/nc-sync-log.service'
import { buildNcActivityEntry } from './nc-activity-entry'

// Wire-format tests for one activity entry.
//
// Every assertion traces to a specific line in the Android client, cited on the
// test, because this payload is consumed by a Kotlin data class of NON-NULL
// String properties parsed by Gson — and Gson bypasses Kotlin's null checks. A
// missing field does not fail at parse time; it throws on the render path, which
// is why "assert the field is present" is a real test here rather than a
// tautology.

const SERVER = 'https://cloud.example.test'
const LOGIN = 'alice'
const FILE_ID = 4242
const TS = 1_753_005_600_000 // 2025-07-20T10:00:00.000Z

function event(overrides: Partial<NcSyncEvent> = {}): NcSyncEvent {
  return {
    id: 77,
    ownerId: 7,
    repository: 'files',
    spaceAlias: 'personal',
    path: 'docs/report.txt',
    type: 'update',
    ts: TS,
    ...overrides
  }
}

describe('buildNcActivityEntry', () => {
  // Activity.kt declares activityId, datetime, date, app, type, user,
  // affecteduser, subject, message, icon, link, object_type, object_id,
  // object_name, previews and subject_rich. Gson leaves any omitted one null in
  // a non-null String property, and it surfaces as an NPE at first use.
  it('emits every field Activity.kt declares, none of them null or undefined', () => {
    const entry = buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER) as unknown as Record<string, unknown>

    const required = [
      'activity_id',
      'datetime',
      'date',
      'app',
      'type',
      'user',
      'affecteduser',
      'subject',
      'message',
      'icon',
      'link',
      'object_type',
      'object_id',
      'object_name',
      'previews',
      'subject_rich'
    ]
    for (const key of required) {
      expect(Object.keys(entry)).toContain(key)
      expect(entry[key]).not.toBeNull()
      expect(entry[key]).not.toBeUndefined()
    }
  })

  // ActivityAndVersionListAdapter sorts activities and file versions into one
  // list by `datetime.time`, so an unparseable date NPEs before anything
  // renders. Gson's default Date handling falls through to ISO8601Utils.
  it('emits datetime as an ISO 8601 instant Gson can parse, duplicated into the legacy date field', () => {
    const entry = buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER)

    expect(entry.datetime).toBe('2025-07-20T10:00:00.000Z')
    expect(new Date(entry.datetime).getTime()).toBe(TS)
    // `date` is the model's own legacy duplicate of `datetime`.
    expect(entry.date).toBe(entry.datetime)
  })

  // THE ONE THAT THROWS IF IT REGRESSES. RichElementTypeAdapter.read calls
  // in.beginArray() UNCONDITIONALLY — an object or a string there raises
  // IllegalStateException and kills the whole parse, which takes the version
  // list down with it.
  it('emits subject_rich as an ARRAY, because RichElementTypeAdapter calls beginArray unconditionally', () => {
    const entry = buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER)
    expect(Array.isArray(entry.subject_rich)).toBe(true)
  })

  // Deliberately empty rather than the upstream ["{file} was …", {file: {…}}]
  // shape: a populated rich element makes ActivityListAdapter take its
  // clickable-chip branch, which dereferences RichObject.name and .id — both
  // nullable. An empty array parses to RichElement("", []) via the adapter's own
  // default constructor, so bindSubject falls through to the plain-text branch.
  it('keeps subject_rich empty so the plain-text subject branch renders', () => {
    const entry = buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER)

    expect(entry.subject_rich).toEqual([])
    // …which means `subject` has to carry the human text, or bindSubject hides
    // the row entirely (its `else` branch sets visibility GONE).
    expect(entry.subject.length).toBeGreaterThan(0)
    expect(entry.subject).toContain('report.txt')
  })

  // bindPreviews only iterates previews when richObjectList is non-empty, which
  // the empty subject_rich guarantees it is not — but an ABSENT key would still
  // be a null list in the model.
  it('emits previews as an empty array rather than omitting it', () => {
    expect(buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER).previews).toEqual([])
  })

  // bindIcon calls activity.icon.endsWith(...) UNCONDITIONALLY, outside the
  // isNotEmpty() guard, so the value must be a string. Empty is correct: we
  // serve no activity icon assets and a URL that 404s would put a broken image
  // load in every row.
  it('emits icon as an empty string, never null', () => {
    expect(buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER).icon).toBe('')
  })

  it.each([
    ['create', 'file_created', 'created'],
    ['update', 'file_changed', 'changed'],
    ['delete', 'file_deleted', 'deleted']
  ] as const)('maps a %s event to NC type %s', (type, ncType, verb) => {
    const entry = buildNcActivityEntry(event({ type }), LOGIN, FILE_ID, SERVER)
    expect(entry.type).toBe(ncType)
    expect(entry.subject).toContain(verb)
  })

  it('names the file rather than its path in object_name and the subject', () => {
    const entry = buildNcActivityEntry(event({ path: 'a/b/c/deep.txt' }), LOGIN, FILE_ID, SERVER)
    expect(entry.object_name).toBe('deep.txt')
    expect(entry.subject).toContain('deep.txt')
    expect(entry.subject).not.toContain('a/b/c')
  })

  it('handles a root-level file with no directory component', () => {
    const entry = buildNcActivityEntry(event({ path: 'root.txt' }), LOGIN, FILE_ID, SERVER)
    expect(entry.object_name).toBe('root.txt')
  })

  it('carries the file id and the files object type through', () => {
    const entry = buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER)
    expect(entry.object_id).toBe(FILE_ID)
    expect(entry.object_type).toBe('files')
    expect(entry.app).toBe('files')
    expect(entry.activity_id).toBe(77)
  })

  // The log records the file's OWNER, not the actor, so both identity fields are
  // that one person. Guessing an actor would be worse than naming the identity
  // we actually have.
  it('uses the requester for both user and affecteduser', () => {
    const entry = buildNcActivityEntry(event(), LOGIN, FILE_ID, SERVER)
    expect(entry.user).toBe(LOGIN)
    expect(entry.affecteduser).toBe(LOGIN)
  })

  it('builds a DAV link on the advertised base url, percent-encoding each segment', () => {
    const entry = buildNcActivityEntry(event({ path: 'my docs/a b.txt' }), 'a b', FILE_ID, SERVER)
    expect(entry.link).toBe('https://cloud.example.test/remote.php/dav/files/a%20b/my%20docs/a%20b.txt')
    // Segment separators must survive; encoding the whole path would turn the
    // slashes into %2F and produce a link to a nonexistent file.
    expect(entry.link).not.toContain('%2F')
  })
})
