# PR screenshots

Verification screenshots for UI-facing PRs (issue #387). Capture with
agent-browser against the local dev server, name them
`YYYY-MM-DD-<topic>-<label>.png` (e.g. `2026-07-30-share-dialog-after.png`),
commit them on the PR branch, and embed them in the PR body with a raw URL
pinned to the head commit SHA so the image survives branch auto-deletion:

    https://github.com/zjean/server/raw/<head-sha>/docs/screenshots/<file>.png

Screenshots land on `develop` (and eventually `main`) with the squash merge —
that is intentional; they are the visual record of what was verified, same as
the PNGs under `docs/plans/`.
