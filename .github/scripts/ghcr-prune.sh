#!/usr/bin/env bash
#
# Prune old container versions from ghcr.io/<owner>/<package>.
#
# Every push to main/develop and every v* tag publishes an image (build-image.yml),
# and nothing ever removed them: by 2026-09-15 the package held 1068 versions from
# 356 builds. This script is the pruner, used both by .github/workflows/ghcr-cleanup.yml
# and by hand for one-off cleanups.
#
# What it keeps, always:
#   - every version carrying a tag that is not `sha-<hex>` (releases, :latest, :main,
#     :develop, :beta — the moving tags live on whichever build they currently point at)
#   - the newest KEEP_SHA versions whose ONLY tags are `sha-<hex>`
#   - every untagged version still referenced by a kept manifest (buildx attestation
#     children of a multi-manifest index — deleting one corrupts the image that points
#     at it)
#   - anything created in the last MIN_AGE_HOURS, so a build racing this run is safe
#
# Everything else is deleted. Dry run is the default; set DRY_RUN=0 to actually delete.
#
# Usage:
#   GH_TOKEN=<pat> .github/scripts/ghcr-prune.sh              # dry run
#   GH_TOKEN=<pat> DRY_RUN=0 .github/scripts/ghcr-prune.sh    # delete
#
# The token needs read:packages + delete:packages. A workflow GITHUB_TOKEN carries
# packages:write, which is NOT the same scope — if deletes come back 403, that is why,
# and the fix is a classic PAT in the GHCR_CLEANUP_TOKEN secret.
#
# Locally, `gh` goes through the rtk wrapper, which can reshape JSON: run with
# GH="rtk proxy gh" so the script sees real API responses.

set -euo pipefail

OWNER="${OWNER:-zjean}"
PACKAGE="${PACKAGE:-sync-in-server}"
KEEP_SHA="${KEEP_SHA:-20}"
MIN_AGE_HOURS="${MIN_AGE_HOURS:-24}"
DRY_RUN="${DRY_RUN:-1}"
GH="${GH:-gh}"

: "${GH_TOKEN:=${GITHUB_TOKEN:-}}"
if [[ -z "$GH_TOKEN" ]]; then
  echo "GH_TOKEN (or GITHUB_TOKEN) must be set" >&2
  exit 1
fi
export GH_TOKEN

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "package : ghcr.io/$OWNER/$PACKAGE"
echo "keep    : all non-sha tags, newest $KEEP_SHA sha-* builds, anything < ${MIN_AGE_HOURS}h old"
echo "mode    : $([[ "$DRY_RUN" == "0" ]] && echo DELETE || echo "dry run (set DRY_RUN=0 to delete)")"
echo

# ---------------------------------------------------------------- inventory ---
$GH api --paginate "/users/$OWNER/packages/container/$PACKAGE/versions?per_page=100" \
  | jq -s 'add' > "$work/versions.json"

total="$(jq 'length' "$work/versions.json")"
echo "found $total versions"

jq --argjson keep "$KEEP_SHA" --argjson minage "$MIN_AGE_HOURS" '
  def is_sha_tag: test("^sha-[0-9a-f]+$");

  [ .[] | {
      id,
      digest: .name,
      created: .created_at,
      tags: (.metadata.container.tags // []),
      old_enough: ((now - (.created_at | fromdateiso8601)) > ($minage * 3600))
    } ]
  | (map(select((.tags | length) > 0 and ((.tags | map(is_sha_tag) | all) | not)))) as $protected
  | (map(select((.tags | length) > 0 and  (.tags | map(is_sha_tag) | all)))
     | sort_by(.created) | reverse)                                                 as $sha_only
  | {
      protected: $protected,
      sha_keep:  ($sha_only[0:$keep]),
      sha_drop:  ($sha_only[$keep:] | map(select(.old_enough))),
      sha_young: ($sha_only[$keep:] | map(select(.old_enough | not))),
      untagged:  (map(select((.tags | length) == 0)))
    }
' "$work/versions.json" > "$work/classified.json"

jq -r '
  "protected (non-sha tags) : \(.protected | length)",
  "sha-* kept               : \(.sha_keep | length)",
  "sha-* prunable           : \(.sha_drop | length)",
  "sha-* too young to prune : \(.sha_young | length)",
  "untagged (to be checked) : \(.untagged | length)"
' "$work/classified.json"
echo

# ------------------------------------------------- referenced child digests ---
# An untagged version is usually a child manifest (buildx provenance/SBOM
# attestation) of a tagged index. Resolve every kept manifest before deleting
# anything untagged; a fetch failure aborts rather than guesses.
jq -r '(.protected + .sha_keep)[] | .digest' "$work/classified.json" > "$work/keep-digests.txt"

reg_token="$(curl -sf -u "$OWNER:$GH_TOKEN" \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:$OWNER/$PACKAGE:pull" | jq -r '.token')"
if [[ -z "$reg_token" || "$reg_token" == "null" ]]; then
  echo "could not obtain a registry pull token for $OWNER/$PACKAGE" >&2
  exit 1
fi

accept='application/vnd.oci.image.index.v1+json'
accept+=', application/vnd.docker.distribution.manifest.list.v2+json'
accept+=', application/vnd.oci.image.manifest.v1+json'
accept+=', application/vnd.docker.distribution.manifest.v2+json'

: > "$work/referenced.txt"
while read -r digest; do
  [[ -n "$digest" ]] || continue
  if ! curl -sf -H "Authorization: Bearer $reg_token" -H "Accept: $accept" \
        "https://ghcr.io/v2/$OWNER/$PACKAGE/manifests/$digest" > "$work/manifest.json"; then
    echo "failed to read manifest $digest — aborting rather than risk deleting a child of it" >&2
    exit 1
  fi
  jq -r '.manifests[]?.digest, (.subject?.digest // empty)' "$work/manifest.json" >> "$work/referenced.txt"
done < "$work/keep-digests.txt"

sort -u "$work/referenced.txt" -o "$work/referenced.txt"
jq -R -s 'split("\n") | map(select(length > 0))' "$work/referenced.txt" > "$work/referenced.json"
echo "kept manifests reference $(jq 'length' "$work/referenced.json") child digests"

# ------------------------------------------------------------- delete plan ---
jq -r --slurpfile refs "$work/referenced.json" '
  ($refs[0] | INDEX(.)) as $referenced
  | (.untagged
     | map(select(.old_enough and ($referenced[.digest] | not))))                     as $orphans
  | (.sha_drop + $orphans)
  | .[] | "\(.id)\t\(.created)\t\(if (.tags | length) > 0 then (.tags | join(",")) else "<untagged>" end)"
' "$work/classified.json" > "$work/delete.tsv"

doomed="$(wc -l < "$work/delete.tsv" | tr -d ' ')"
echo "to delete: $doomed versions"
echo

if [[ "$doomed" == "0" ]]; then
  echo "nothing to do"
  exit 0
fi

# ------------------------------------------------------------------ delete ---
deleted=0
failed=0
streak=0
while IFS=$'\t' read -r id created tags; do
  [[ -n "$id" ]] || continue
  if [[ "$DRY_RUN" == "0" ]]; then
    if $GH api -X DELETE "/users/$OWNER/packages/container/$PACKAGE/versions/$id" --silent 2>"$work/err.txt"; then
      deleted=$((deleted + 1))
      streak=0
      echo "deleted $id  $created  $tags"
    else
      failed=$((failed + 1))
      streak=$((streak + 1))
      echo "FAILED  $id  $created  $tags: $(tr '\n' ' ' < "$work/err.txt")" >&2
      if [[ "$streak" -ge 3 ]]; then
        echo >&2
        echo "three consecutive failures — stopping. A 403 here means the token lacks" >&2
        echo "delete:packages (a workflow GITHUB_TOKEN does); use a classic PAT." >&2
        exit 1
      fi
    fi
  else
    echo "would delete $id  $created  $tags"
  fi
done < "$work/delete.tsv"

echo
if [[ "$DRY_RUN" == "0" ]]; then
  echo "deleted $deleted versions, $failed failures"
  [[ "$failed" == "0" ]]
else
  echo "dry run — nothing was deleted"
fi
