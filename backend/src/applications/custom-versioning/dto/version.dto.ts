import { Transform } from 'class-transformer'
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator'
import { VERSIONS_ROOT_MAX_LENGTH } from '../constants/versioning'

export class SetVersionLabelDto {
  // null / omitted clears the label. Capped at the column width so a long
  // label is a 400 rather than a silent MySQL truncation.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string | null
}

export class DeleteVersionDto {
  // A labeled version is exempt from every automatic pruning rule, so removing
  // one has to be a deliberate act rather than a mis-click.
  //
  // This DTO is bound to @Query(), so the value arrives as the STRING 'true'.
  // The global pipe is `ValidationPipe({ transform: true, whitelist: true })`
  // with no `enableImplicitConversion`, so `@IsBoolean()` alone rejects that
  // string with a 400 — which made deleting a labeled version impossible.
  // Coerce here rather than globally: implicit conversion is process-wide and
  // would loosen every other DTO in the app.
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value))
  @IsBoolean()
  confirmLabeled?: boolean
}

export class PurgeVersionsRootDto {
  // The recorded root discriminator: 'user:<login>' or 'space:<alias>'. The
  // panel passes back exactly the string the storage summary gave it.
  //
  // The prefix rule is NOT restated here. It lives in parseVersionsRoot, which
  // is also what turns a root into a filesystem path — a copy in this DTO would
  // be a second definition of "valid root", and the weaker one would be the one
  // that mattered. The length cap is the COLUMN's width — 261, i.e. 'space:'
  // plus a 255-char alias, which the schema e2e pins — so a root that exists can
  // always be named, and anything longer is a 400 rather than a query that
  // matches nothing.
  @IsString()
  @MaxLength(VERSIONS_ROOT_MAX_LENGTH)
  versionsRoot: string
}

export class EditorVersionDto {
  // The caller's own TOKEN_TYPE.ONLY_OFFICE JWT, which the service echoes into
  // the `url` it hands the editor — because that url is fetched by the DOCUMENT
  // SERVER, server-to-server, where a browser session is worth nothing.
  //
  // Named `officeToken` rather than `token` deliberately. `token` is the query
  // parameter OnlyOfficeGuard authenticates FROM
  // (ONLY_OFFICE_TOKEN_QUERY_PARAM_NAME), and this route is not one of those —
  // it is an ordinary SpaceGuard route. Reusing the name would make a
  // token-authenticated and a session-authenticated route look identical at
  // every call site.
  @IsString()
  @IsNotEmpty()
  officeToken: string
}

export class VersionDiffDto {
  // `current` diffs the version against the live file; a numeric id diffs two
  // versions of the same file.
  @IsOptional()
  @IsString()
  against?: string
}
