import { Transform, Type } from 'class-transformer'
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNotEmptyObject,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested
} from 'class-validator'
import type { SampleDocumentGroup } from './constants/samples'
import { SAMPLE_DOCUMENT_GROUPS } from './constants/samples'
import { CollaboraOnlineConfig } from './editors/collabora-online/collabora-online.config'
import { OnlyOfficeConfig } from './editors/only-office/only-office.config'

export class FilesContentIndexingOCRConfig {
  @IsBoolean()
  enabled: boolean = true

  @ValidateIf((o: FilesContentIndexingOCRConfig) => o.enabled)
  @ArrayNotEmpty()
  @IsArray()
  @IsString({ each: true })
  languages: string[] = ['eng']

  @IsBoolean()
  offline: boolean = false

  @IsOptional()
  @IsString()
  languagesPath?: string
}

export class FilesContentIndexingConfig {
  @IsBoolean()
  enabled: boolean = true

  @ValidateIf((o: FilesContentIndexingConfig) => o.enabled)
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesContentIndexingOCRConfig)
  ocr: FilesContentIndexingOCRConfig = new FilesContentIndexingOCRConfig()
}

export class FilesTrashRetentionConfig {
  @Transform(({ value }) => (value === 0 ? false : value))
  @ValidateIf((o: FilesTrashRetentionConfig) => o.users !== false)
  @IsInt()
  @Min(1)
  users: number | false = false

  @Transform(({ value }) => (value === 0 ? false : value))
  @ValidateIf((o: FilesTrashRetentionConfig) => o.spaces !== false)
  @IsInt()
  @Min(1)
  spaces: number | false = false
}

// Fork-owned. Mirrors FilesTrashRetentionConfig above, including its
// `0 -> false` Transform idiom, so that `0` means "off" rather than
// "expire everything immediately".
export class FilesVersionsRetentionConfig {
  @Transform(({ value }) => (value === 0 ? false : value))
  @ValidateIf((o: FilesVersionsRetentionConfig) => o.users !== false)
  @IsInt()
  @Min(1)
  users: number | false = false

  @Transform(({ value }) => (value === 0 ? false : value))
  @ValidateIf((o: FilesVersionsRetentionConfig) => o.spaces !== false)
  @IsInt()
  @Min(1)
  spaces: number | false = false
}

// Fork-owned. Per-origin overrides for the coalescing window (ADR §5).
//
// WHY THE EDITORS NEED THEIR OWN NUMBER. The window is a RATE LIMIT, not a
// session collapser: the versions minted during an editing session are
// roughly `session_length / max(window, save_interval)`, and a session is
// unbounded. The two kinds of writer have cadences two orders of magnitude
// apart, so one scalar cannot serve both:
//
//   - An EDITOR's cadence is set by the document server, not by a human.
//     Collabora's own coolwsd.xml defaults are `idlesave_duration_secs: 30`
//     and `autosave_duration_secs: 300`, so a PutFile can arrive every 30
//     seconds of edit-then-pause. At a 60-second window an hour of active
//     editing mints ~10 versions — which under the FIFO cap this config used to
//     carry would have evicted about half of the file's genuinely distinct older
//     revisions. Age-tiered thinning is what removed that trade-off; the window
//     now bounds only the write rate, not the reach of history.
//   - An INTERACTIVE write is a human pressing Save. Each one is a decision,
//     and collapsing four of them into one leaves the intermediate states
//     unrecoverable. 60 seconds is right there.
//
// 300 matches Collabora's `autosave_duration_secs`, so a continuously-edited
// document mints at most one version per autosave cycle. OnlyOffice gets the
// same value for symmetry, though it barely needs one: it saves only from
// callback statuses 2/3/6/7 and has no autosave-per-keystroke path at all
// (ADR §5), so coalescing rarely fires there.
//
// AMENDED after the ADR §19 soak (#389). "Barely needs one" was too generous:
// OnlyOffice has no automatic save AT ALL, so its 300 was being applied
// exclusively to HUMAN saves, and four Ctrl+S presses inside two minutes
// minted zero versions. #395 first routed a
// save OnlyOffice reports as human-triggered (`forcesavetype` 1/3) through the
// scalar instead of this override — better, but still a rate limit on an
// explicit user request, and two deliberate Ctrl+S presses 34s apart could
// still land in the same 60s bucket and lose one. §5.3's later fix: a PROVEN
// human save (forcesavetype 1/3) now skips coalescing entirely (window 0,
// never rate-limited); a save that cannot be proven either way (no
// discriminator on the wire) still falls back to the scalar; only a save an
// editor PROVES its own timer made uses the override below. Collabora reports
// no discriminator at all, so every one of its saves keeps the override. See
// docs/plans/2026-07-29-coalescing-forcesavetype-design.md and §5.3 of
// docs/plans/2026-07-25-file-versioning-design.md.
//
// `0` means "never coalesce this origin" and is distinguishable from "not
// configured" — the lookup tests for a number, not for truthiness. Any origin
// without a field here falls back to the scalar `minIntervalSeconds`.
export class FilesVersionsOriginIntervalsConfig {
  @IsInt()
  @Min(0)
  collabora: number = 300

  @IsInt()
  @Min(0)
  onlyoffice: number = 300
}

// Fork-owned file versioning. See docs/plans/2026-07-25-file-versioning-design.md.
// Disabled by default: every hook site is a one-line call that no-ops while
// `enabled` is false.
//
// Configured through the environment/yaml only — there is deliberately no admin
// screen. `trashRetention` above, the closest precedent, is also env-only
// (it appears nowhere under applications/admin), and inventing a UI for
// versions alone would put this fork ahead of upstream's own config surface for
// no benefit. Match the precedent; don't invent.
export class FilesVersionsConfig {
  @IsBoolean()
  enabled: boolean = false

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesVersionsRetentionConfig)
  retentionDays: FilesVersionsRetentionConfig = new FilesVersionsRetentionConfig()

  // Max fraction of a space's quota that version history may consume. Enforced
  // eagerly inside the snapshot path (oldest unlabeled evicted first), not just
  // by the scheduler. Versions DO count toward quota — see ADR §7 for why
  // excluding them was rejected, and why this feature cannot promise that a
  // save is never blocked.
  @Transform(({ value }) => (value === 0 ? false : value))
  @ValidateIf((o: FilesVersionsConfig) => o.quotaShare !== false)
  @IsNumber()
  @Min(0.01)
  @Max(1)
  quotaShare: number | false = 0.5

  // Coalescing window per (fileId, authorId, origin). 0 disables coalescing.
  //
  // This is the FALLBACK, applied to any origin without an entry in
  // `minIntervalSecondsByOrigin` below — i.e. to every interactive write, where
  // a save is a human decision and 60 seconds is the right granularity.
  @IsInt()
  @Min(0)
  minIntervalSeconds: number = 60

  // Per-origin overrides. See FilesVersionsOriginIntervalsConfig for why the
  // editors cannot share the interactive number.
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesVersionsOriginIntervalsConfig)
  minIntervalSecondsByOrigin: FilesVersionsOriginIntervalsConfig = new FilesVersionsOriginIntervalsConfig()
}

export class FilesEditorsConfig {
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => OnlyOfficeConfig)
  onlyoffice: OnlyOfficeConfig = new OnlyOfficeConfig()

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => OnlyOfficeConfig)
  eurooffice: OnlyOfficeConfig = new OnlyOfficeConfig()

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => CollaboraOnlineConfig)
  collabora: CollaboraOnlineConfig = new CollaboraOnlineConfig()
}

export class FilesConfig {
  @IsNotEmpty()
  @IsString()
  dataPath: string

  @IsNotEmpty()
  @IsString()
  usersPath: string

  @IsNotEmpty()
  @IsString()
  spacesPath: string

  @IsNotEmpty()
  @IsString()
  tmpPath: string

  @IsInt()
  maxUploadSize: number = 5368709120 // 5 GB

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesContentIndexingConfig)
  contentIndexing: FilesContentIndexingConfig = new FilesContentIndexingConfig()

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesTrashRetentionConfig)
  trashRetention: FilesTrashRetentionConfig = new FilesTrashRetentionConfig()

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesVersionsConfig)
  versions: FilesVersionsConfig = new FilesVersionsConfig()

  @IsBoolean()
  showHiddenFiles: boolean = false

  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v: string) => v.trim())
          .filter(Boolean)
      : value
  )
  @ArrayUnique()
  @IsArray()
  @IsIn(SAMPLE_DOCUMENT_GROUPS, { each: true })
  sampleDocuments: SampleDocumentGroup[] = [...SAMPLE_DOCUMENT_GROUPS]

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FilesEditorsConfig)
  editors: FilesEditorsConfig = new FilesEditorsConfig()
}
