# ADR §19 soak — the editor half, run against real OnlyOffice and Collabora

- **Date:** 2026-07-29
- **Status:** **Done for the editors.** The ADR §19 soak (#348) asked for a soak against real Collabora, OnlyOffice and
  NC clients before `files.versions.enabled` defaults on. This document is the OnlyOffice + Collabora half, run against
  real containers. The NC-client half is [`2026-07-27-nc-android-versioning-soak.md`](2026-07-27-nc-android-versioning-soak.md)
  (Android, done); NC iOS remains unrun.
- **Also closes:** the empirical confirmation D4.1 and D4.2 were owed
  ([`2026-07-27-file-versioning-phase-d-findings.md`](2026-07-27-file-versioning-phase-d-findings.md) §D4).
- **Software under test:** `main` at `3744a11a`; `onlyoffice/documentserver:9.3.1.2`; `collabora/code:latest`
  (COOL 25.x, pulled 2026-07-29).

Everything below is measured, not derived. Raw logs are not committed — the tables reproduce them in full.

---

## 1. Headline

| Claim | Verdict |
|---|---|
| D4.1 — OnlyOffice has **no** autosave path; it versions only on explicit save or session close | **Confirmed.** 5 idle periods of 40 s produced 0 versions; 5 explicit Ctrl+S produced exactly 5 |
| D4.2 — Collabora saves on **its own timer**, with no user action | **Confirmed**, and its own container config confirms `idlesave 30 / autosave 300 / always_save_on_exit false` |
| D4.2's *number* — "a PutFile can arrive as often as every 30 s" | **Corrected: faster.** Two clean measurements put the save **15 s and 16 s** after the last keystroke |
| ADR §5.1 — the 300 s window collapses an editing session's saves | **Confirmed.** 4 explicit saves inside 2 minutes produced **0** new versions |
| #378 — a restore drops the cached OnlyOffice document key | **Confirmed live**, key-by-key |
| The whole editor→version chain works against a real document server | **Confirmed** for both editors, including the WOPI round trip |

**The asymmetry ADR §5.1 rests on is real and now measured**: Collabora's saves are the document server's decision,
OnlyOffice's are a human's. That is the basis of the per-origin window — and also the reason the deferred question about
OnlyOffice's own 300 s value is a genuine product question, not a mechanical one (§6).

---

## 2. The rig, and why it was built this way

The dev-stack recipe in [`2026-07-27-file-versioning-phase-d-handoff.md`](2026-07-27-file-versioning-phase-d-handoff.md) §2
still holds. Three additions were needed, and the third is a rule, not a preference:

1. **A real document server per editor**, both isolated: `onlyoffice-soak` on `:8091`
   (`JWT_SECRET` matching `editors.onlyoffice.secret`, `JWT_IN_BODY=true`, `USE_UNAUTHORIZED_STORAGE=true`) and
   `collabora-soak` on `:9980` (`--o:ssl.enable=false --o:ssl.termination=false`, `aliasgroup1` = the app origin).
2. **A LAN-IP origin, not `localhost`.** The backend derives every URL it hands the document server from the request's
   Host header (`contextManager.headerOriginUrl()`). Drive the browser at `http://localhost:8090` and the document
   server resolves `localhost` to *itself* and cannot fetch the document. Drive it at `http://192.168.1.177:8090` and
   both the browser and the container reach the same server. Verified before touching the UI:
   `docker exec onlyoffice-soak curl <document.url>` → `200, 6994 bytes`.
3. **Process isolation, because two sibling agents' dev servers were running on the same machine** against the same
   MariaDB and the same `dataPath`. A soak that counts rows cannot share a database with anyone. This run used its own
   port (`8090`), its own database (`sync_in_soak`) and its own data root (`/tmp/sync-in-soak-data`), all via
   `SYNCIN_*` env vars on one process — no shared file edited, nothing of theirs touched, verified afterwards
   (their `:8081` still up, `environment.yaml` byte-identical to its pre-soak backup).

---

## 3. OnlyOffice

### 3.1 Pass 1 — the raw cadence, coalescing disabled

`minIntervalSecondsByOrigin.onlyoffice: 0`. Each round: type, idle **40 s**, record, explicit **Ctrl+S**, record.

| Round | after 40 s idle | after Ctrl+S |
|---|---|---|
| 1 | 1 | 2 |
| 2 | 2 | 3 |
| 3 | 3 | 4 |
| 4 | 4 | 5 |
| 5 | 5 | 6 |

**Five idle periods, zero versions. Five explicit saves, five versions.** The gaps between rows are ~47 s — the interval
*this test* imposed, not one the document server chose. There is no cadence of its own to measure, which is exactly what
D4.1 claimed from source.

The rows also confirm the snapshot semantics: sizes `6994, 25644, 25645, 25646, 25649, 25652` while the live file ended
at `25654`. Every version holds the content the save was about to destroy, so the newest version is always *smaller*
(older) than the live file, and the first is the pristine 6994-byte sample. All rows `origin=onlyoffice`,
`authorId=1` — the acting user resolved through the callback's own token, not a system id.

### 3.2 Why there is no autosave, from the document server's side

Our editor config is `autosave: false, forcesave: true` (`only-office-manager.service.ts:246-247`) — confirmed by
fetching the real config off the running server. The document server's own default completes the picture:
`autoAssembly.enable = false` (`/etc/onlyoffice/documentserver/default.json`, interval 5 m if enabled), and that is its
only periodic save-to-storage mechanism. So *neither side* has a timer. Persistence happens on session close (status 2)
or on an explicit forcesave (status 6) — the four callback arms D4.1 tabulated, and no others.

### 3.3 Pass 2 — the shipped 300 s window

Same session, `onlyoffice: 300`, four explicit Ctrl+S saves ~38 s apart:

| Save | at | versions |
|---|---|---|
| 1 | 00:15:42 | 6 |
| 2 | 00:16:20 | 6 |
| 3 | 00:16:58 | 6 |
| 4 | 00:17:37 | 6 |

**Four saves, zero new versions.** The window works. It also means what the design said it means: a user who presses
Save four times in two minutes keeps none of the intermediate states. That is the product question in §6.

---

## 4. Collabora

The WOPI round trip works end to end: `GET /wopi/files/<hash>` (CheckFileInfo), `GET .../contents` (GetFile), the LOCK
POST, and `POST .../contents` (PutFile) all arrive, and the editor opens the same `.docx` in edit mode.

**The container's own defaults, read out of the running image** — the numbers D4.2 could only take from documentation:

| Setting | Value in `coolwsd.xml` |
|---|---|
| `idlesave_duration_secs` | 30 |
| `autosave_duration_secs` | 300 |
| `always_save_on_exit` | false |

**Measured idle-save latency: 15 s and 16 s** (two runs; type once into a document nobody touches again, poll every 5 s
until a `collabora` version appears). Both are well under the configured 30 s. This document does not guess at the
mechanism — the honest statement is that **the observed latency was about half the configured `idlesave_duration_secs`**,
which strengthens rather than weakens D4.2's actual conclusion: the cadence belongs to the container, and no server-side
rule may assume a particular value.

Version rows `8, 9, 10` are `origin=collabora`, sizes `6994, 6525, 6532` — Collabora re-serialises the `.docx` smaller
than OnlyOffice did, and each version still holds the pre-save content.

**One cross-editor fact worth knowing, found by accident:** with an OnlyOffice session open on a file, Collabora opens
that file **read-only** — `/wopi/settings` returns `mode: view` and a `hasLock` naming `app: OnlyOffice`. The app lock is
honoured across editors, so a deployment with both enabled serialises editing rather than corrupting. Closing the
OnlyOffice session released it and Collabora came up in `edit`.

---

## 5. #378 verified live

The fix merged earlier the same day, exercised against a real document server rather than a stub:

```
cached doc key BEFORE restore: "1b52-19faac2e55c"
restore HTTP 201
cached doc key AFTER restore:  <none>
live file size after restore:  6994
new doc key on the next /settings: 1b52-19faace5576
```

The cache entry is dropped, the live file is back to the restored content, the safety snapshot is written
(`origin=restore`, 25665 bytes — the pre-restore live content), and the **next** editor config carries a key the
document server has never seen, which is what forces it to re-download instead of serving its own copy. That is the whole
of `CLAUDE.md` invariant 7, confirmed end to end.

The v2 surface agrees: `versions/list` returns all 10 rows with authors, and `versions/usage` reports
`{used: 180946, count: 10}`.

---

## 6. What this leaves for the maintainer

**The deferred coalescing-window decision (D4.3, design §5.3) now has its measurement.** Restating it with numbers
instead of reasoning:

- OnlyOffice: **no** automatic saves at all. Every save in the pass-1 table was a keystroke of mine. So the 300 s window
  is applied exclusively to *human* saves, which is the category ADR §5.1 assigns 60 s.
- Collabora: saves every ~15 s of idle, unprompted. This is the autosave storm the 300 s window was designed for, and
  for Collabora it is doing exactly its job — arguably it is *too small*, since 15 s idle-saves mean ~20 versions per
  300 s window boundary crossing over a long session.

Nothing here decides it: keeping 300 s for OnlyOffice trades intermediate revisions for retention budget, and the ADR's
`maxVersionsPerFile` argument (D4.3's RESOLVED note) still applies. But the premise stated in §5.1 — "the editors'
cadence is set by the document server" — is now known to be **false for OnlyOffice and true for Collabora**, so if the
window is revisited, that is the sentence to revisit with it.

**`forcesavetype` is the discriminator, and it is already on the wire.** The callback body distinguishes
`forcesavetype: 1` ("each time the saving is done, e.g. the Save button is clicked") from `2` (by timer). Nothing reads
it today. It is available at the snapshot site with no new plumbing, and it is what would let one rule treat a human Save
and an automatic save differently without a per-origin fudge.

---

## 7. Two defects this soak found

### 7.1 `applications.files.versions` cannot be configured by environment variable at all

> **FIXED 2026-07-29 in #395** — which added the `versions:` block to `environment.dist.yaml`, exactly the
> `mod(config)` this section's Impact paragraph asks for. Every `SYNCIN_APPLICATIONS_FILES_VERSIONS_*` name now
> resolves; re-verified by running `configLoader()` with `…_ENABLED=false` against a yaml saying `true` and getting
> `false`. The section is kept as the dated finding that motivated the fix — see `CLAUDE.md` for the current rule and
> the one naming trap that survives it (camelCase keys are a single `_`-delimited segment).

`environment.dist.yaml` — the file `getEnvOverrides` validates every `SYNCIN_*` name against
(`config.loader.ts:96-140`) — has **no `versions` block**. So every versioning env var is silently discarded:

```
$ SYNCIN_APPLICATIONS_FILES_VERSIONS_ENABLED=false ts-node <print the config>
Ignoring unknown environment variable: "SYNCIN_APPLICATIONS_FILES_VERSIONS_ENABLED".
RESULT versions.enabled = true
```

Control: the same probe with `SYNCIN_APPLICATIONS_FILES_EDITORS_ONLYOFFICE_ENABLED` emits no warning, because that path
does exist in the dist file.

**Impact.** Docker is this fork's shipped deployment, and on it the feature flag, `quotaShare`, `maxVersionsPerFile`,
`retentionDays` and both coalescing windows can only be set by mounting an `environment.yaml`. An operator following the
env-var convention every other setting uses gets no error and no effect — including when trying to turn the feature
**off**. That is a release-relevant gap for a flag-gated feature; a fix is a `mod(config)` adding the block to
`environment.dist.yaml` with the class defaults.

### 7.2 The soak recipe in the phase-D handoff no longer opens the window

D4.2's recipe step 2 says *"Set `applications.files.versions.minIntervalSeconds: 0` for the first pass, so every PutFile
mints a version and the raw cadence is visible."* **That is now insufficient and silently so.** Since ADR §5.1 shipped,
`coalescingWindow` reads `minIntervalSecondsByOrigin` first, and its class default is **300 for both editors**
(`files.config.ts:113-121`) — so a scalar `0` leaves the editors coalescing at 300 s and the "raw cadence" measurement
measures the window instead. Pass 1 above needed `minIntervalSecondsByOrigin.onlyoffice: 0` explicitly. This is the trap
the recipe's own step 2 warns about, one level down.

---

## 8. Reproducing it

1. `npm run dev:db`, create an isolated database if anything else is running against the dev one, `db:migrate`,
   `db:seed`.
2. `docker run -d --name onlyoffice-soak -p 8091:80 -e JWT_ENABLED=true -e JWT_SECRET=<editors.onlyoffice.secret> -e JWT_IN_BODY=true -e USE_UNAUTHORIZED_STORAGE=true onlyoffice/documentserver:9.3.1.2`
3. `docker run -d --name collabora-soak -p 9980:9980 -e "extra_params=--o:ssl.enable=false --o:ssl.termination=false" -e "aliasgroup1=http://<lan-ip>:8090" collabora/code:latest`
4. `externalServer` for each editor = `http://<lan-ip>:<port>`; **versions config in `environment.yaml`, not env vars**
   (§7.1), with `minIntervalSecondsByOrigin` set explicitly (§7.2).
5. `npm run -w frontend build`, then the backend on the LAN IP. Upload
   `backend/src/applications/files/assets/samples/sample.docx` over WebDAV as the test document.
6. Drive it with `agent-browser`. Three things cost time here:
   - **Screenshots hang.** A `screenshot` call blocked for the full 2-minute timeout while `eval` kept working. Verify
     through `eval` and through side effects (the database, the backend log), never a picture.
   - **OnlyOffice takes keys after a plain click on its iframe**; `agent-browser keyboard type` then reaches the editor.
   - **Collabora does not.** Its focus sits on an inner iframe and keystrokes go nowhere — silently, so it reads as "no
     autosave" rather than "no input". Focus `#clipboard-area` first
     (`eval "(document.querySelector('#clipboard-area')||document.querySelector('.clipboard')).focus()"`), then type.
     The first Collabora attempt in this soak sat idle for 141 s proving nothing for exactly this reason.
