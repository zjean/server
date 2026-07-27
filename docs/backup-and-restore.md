# Backup and restore

What to back up, and the one thing that is easy to miss.

## The backup set

Four things. Miss any one and a restore is incomplete.

| # | What | Where |
|---|---|---|
| 1 | **The database** | MariaDB, the schema `mysql.url` points at |
| 2 | **User homes** | `<applications.files.usersPath>/<login>/` |
| 3 | **Space homes** | `<applications.files.spacesPath>/<alias>/` |
| 4 | **The config** | `environment/environment.yaml` |

`usersPath` and `spacesPath` default to `<dataPath>/users` and `<dataPath>/spaces`.

Each home contains three directories that all matter, plus one that does not:

```
<usersPath>/<login>/
├── files/       the live files
├── trash/       deleted files, restorable until the retention window expires
├── versions/    ← FILE HISTORY. Easy to miss, and losing it is silent.
└── tmp/         in-flight uploads and task scratch — do NOT back up
```

Space homes have the same `files/`, `trash/` and `versions/` layout.

## Why `versions/` needs saying out loud

**It is a sibling of `files/`, not a subdirectory of it.** That placement is deliberate and load-bearing — it is the
only reason version blobs are invisible to WebDAV, the content indexer and the desktop sync client, none of which has
any exclusion filter (see the file-versioning ADR §1). The consequence for backups is that **a rule written as "back up
`files/`" silently excludes every file's history.**

Nothing warns you. The database still lists every version, the UI still shows the history, and each entry fails only
when someone tries to download or restore it — possibly months later.

File versioning ships **disabled** (`applications.files.versions.enabled`, default `false`), so on a default install
`versions/` does not exist and there is nothing to lose. **Add it to the backup set before you enable the feature**, not
after.

## Filesystem and database must be consistent

Version rows and version blobs are separate halves of one fact:

- **Database restored, `versions/` not** — rows point at blobs that are not there. History lists but cannot be
  downloaded or restored.
- **`versions/` restored, database not** — the blobs are orphans. The retention sweep removes them the day after they
  age past its one-day grace window, so the disk recovers on its own; the history does not.

Snapshot the database and the filesystem **as close together as possible**. A version created between the two snapshots
has a row in the newer half and no blob in the older one. If your tooling cannot do both at once, take the filesystem
snapshot *after* the database dump: an extra blob with no row is self-healing, a row with no blob is not.

The blob store is content-addressed and deduplicated **per home** (`<digest[0:2]>/<digest>`), and blobs are shared
between versions with identical content. Copy it as ordinary files; there is nothing to reconstruct, and no per-file
metadata lives outside the database.

## Restoring

1. Restore `environment/environment.yaml` first — the paths in it determine where everything else belongs.
2. Restore the database.
3. Restore the user and space homes, preserving ownership and mtimes.
4. Do **not** recreate `tmp/`; it is rebuilt on demand.

**Preserve mtimes** (`rsync -a`, `tar -p`). File versioning identifies a revision to Nextcloud mobile clients by its
mtime in whole seconds, so rewriting mtimes on restore changes the identity those clients use to request and restore a
version.

Inodes are *not* preserved by a copy-based restore, and that is expected. Trash retention keys its records on inodes, so
a restored trash entry may be re-dated by the next sweep — it is not lost, and it does not affect version history, which
keys on `files.id`.

## What is not in the backup set

- `tmp/` under any home, and `<applications.files.tmpPath>` — in-flight uploads and task scratch.
- Guest and link homes under `<tmpPath>/{guests,links}/<login>` — ephemeral by design. Versioning skips them entirely
  (ADR §8), so there is no history there to lose.
- `dist/`, `node_modules/`, logs.
