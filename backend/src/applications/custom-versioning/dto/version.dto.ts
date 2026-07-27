import { Transform } from 'class-transformer'
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator'

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

export class VersionDiffDto {
  // `current` diffs the version against the live file; a numeric id diffs two
  // versions of the same file.
  @IsOptional()
  @IsString()
  against?: string
}
