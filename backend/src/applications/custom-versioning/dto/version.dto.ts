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
  @IsOptional()
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
