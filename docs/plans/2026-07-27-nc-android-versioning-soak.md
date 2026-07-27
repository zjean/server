# NC Android soak — file versioning on a real client

- **Date:** 2026-07-27
- **Client:** stock Nextcloud Android **34.1.0** (`nextcloud-340010090.apk`, official GitHub release), unmodified
- **Server:** this fork on `http://10.0.2.2:8080`, `files.versions.enabled: true`
- **Result:** **versioning works end to end in the stock client** — after one server-side bug fix, below.

This is the ADR §19 soak for Android, or the versioning part of it. Everything in PRs #325, #329, #331 and #333 was
derived from *reading* client source; this is the first time a real client drove it.

---

## 1. The bug the soak found, and why nothing else could have

**`user_status` was missing `supports_emoji`, and that made every capability-gated Android feature dead.**

NC Android reads both keys in that block with `getBoolean()` and **no `has()` guard**
(`GetCapabilitiesRemoteOperation.java:710-716`). A missing `supports_emoji` throws `org.json.JSONException`, which is
caught at the top of `parseResponse` — so the client abandons the **entire** capability object and persists nothing.
Its `capabilities` table stayed empty, every flag read back `UNKNOWN`, and:

```
D GetCapabilitiesRemoteOperation: Successful response: {...,"files":{...,"versioning":true,...},...}
D GetCapabilitiesRemoteOperation: *** Added version
D GetCapabilitiesRemoteOperation: *** Added core
D GetCapabilitiesRemoteOperation: *** Added files_sharing
D GetCapabilitiesRemoteOperation: *** Added files          ← our versioning flag WAS parsed
D GetCapabilitiesRemoteOperation: *** Added theming
E GetCapabilitiesRemoteOperation: Exception while getting capabilities
E GetCapabilitiesRemoteOperation: org.json.JSONException: No value for supports_emoji
```

**The symptom was in a different feature entirely.** The file-detail version list never appeared, because
`FileDetailActivitiesFragment` gates it on `capability.getFilesVersioning().isTrue()` and that value never reached
disk. `files.versioning: true` was in the payload and parsed correctly; the parse died three blocks later. Debugged by
reading `sqlite3 /data/data/com.nextcloud.client/databases/filelist "select count(*) from capabilities"` → `0`.

**Why unit tests could not find it.** Every assertion we had was about the keys we *do* emit. Nothing knew that a
consumer dereferences a key we *omit* — that is a fact about the client, and it is only observable when a client runs.
The lesson generalises past this one key: **a partially-specified capability block is worse than an absent one**,
because the client walks into it. The regression test now guards that family (`user_status`, `directEditing`,
`checksums`), not just the single key.

The block now mirrors upstream's `apps/user_status/lib/Capabilities.php` — all four keys, all `false`, describing a
feature this fork does not implement rather than half-describing it.

## 2. What was verified, in order

**Server side, over real HTTP with a real minted app-password** (the login-v2 flow driven by `curl`):

| Check | Result |
|---|---|
| `PROPFIND /remote.php/dav/versions/sync-in/versions/821` | 207, **3 responses** — mandatory self entry + 2 versions |
| node name vs `d:getlastmodified` | `…/1785176361` ↔ `18:19:21`, `…/1785176359` ↔ `18:19:19` — agree |
| `GET` a version | returned that revision's exact bytes |
| `MOVE` → `restore/821` | 204, live file reverted, new `restore`-origin version created |
| `oc:fileid` in the files PROPFIND | `821` — matches the versions-tree path |
| activity feed for `object_id=821` | 200, 4 entries |

**On the device, after the fix:**

1. Capabilities: 21 fetches, **0 parse exceptions**, one row persisted with `files_versioning = 1`.
2. The app requested the tree by itself:
   `PROPFIND /remote.php/dav/versions/sync-in/versions/821 → 207`, and logged
   `ReadFileVersionsRemoteOperation: Read file version for 821: … 207 (success)`.
3. The Activities tab rendered **three "New version was created / 32 B" rows with restore icons**, interleaved by
   timestamp with the activity rows.
4. Tapping Restore on the newest sent
   `MOVE /remote.php/dav/versions/sync-in/versions/821/1785176363 → 204`,
   and the live file went from `revision 1 of the demo document` to **`revision 3 of the demo document`** — the exact
   revision behind that button — with a new `restore`-origin version holding what it replaced.

**The revision-id decision is now validated by a real client, not by inference.** The app built
`…/versions/821/1785176363` purely from the parsed `d:getlastmodified` and never from the href, exactly as
`FileVersion.getFileName()` implies. Had we named nodes by our row id, every restore would have 404'd.

Our activity payload was also confirmed parsed on device (the full JSON appears in the app's own
`GetActivitiesRemoteOperation: Successful response:` log) — including `subject_rich: []` and `previews: []`, the two
deliberate simplifications.

## 3. Reproducing this, including the trap that costs an hour

**NC Android 34.1.0 crashes on launch on a 16 KB page-size emulator image.**

```
java.lang.UnsatisfiedLinkError: dlopen failed: ".../lib/arm64-v8a/libconscrypt_jni.so"
program alignment (4096) cannot be smaller than system page size (16384)
```

Android Studio's current default AVDs (e.g. Pixel 10 / API 37) use `..._ps16k` images — 16 KB pages — and NC's bundled
`libconscrypt_jni.so` is 4 KB-aligned. **`zipalign` cannot fix this**: the constraint is the ELF's own `p_align`, not
the zip entry's. Nothing to do with this server; it will hit anyone testing the NC client on a current AVD.

Use a 4 KB-page image:

```bash
sdkmanager "system-images;android-35;google_apis;arm64-v8a"   # accept licences FIRST or it stalls at 0 bytes
# avdmanager may refuse with "Package path is not valid … null" when a newer package.xml
# in the SDK defeats its repo scan; hand-writing the AVD is faster than fighting it:
#   ~/.android/avd/<name>.ini + <name>.avd/config.ini cribbed from a working AVD,
#   retargeted via image.sysdir.1 / tag.id / target.
emulator -avd <name> -no-snapshot-load
adb shell getconf PAGE_SIZE     # must print 4096
```

Then: `adb install nextcloud-*.apk`, add the account against `http://10.0.2.2:8080` (the emulator's host alias),
log in as `sync-in` / `password` through the login-v2 web flow, and open a file's **Activities** tab.

Two debugging notes worth keeping:

- **`adb root` works on `google_apis` (non-Play) images**, which is what makes
  `sqlite3 /data/data/com.nextcloud.client/databases/filelist` readable. That query — `select count(*) from
  capabilities` — is what turned "the version list is missing" into "capabilities were never persisted".
- **Give the app a reason to re-fetch capabilities.** It caches aggressively; `adb shell pm clear
  com.nextcloud.client` wipes the DB while leaving the account in AccountManager, so the next launch re-fetches
  without redoing the login flow.

## 4. Still owed

- **iOS remains untestable for versioning.** NextcloudKit has no versions endpoint and never surfaces the
  `versioning` capability, so there is no UI to soak. Unchanged from the Phase D findings' D2.5.
- **Collabora / OnlyOffice soak.** ADR §19 also asks for the editors against real document servers; this covered the
  NC client only.
- **Nothing here tested the desktop sync client.**
