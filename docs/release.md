# Releasing

Releases are automatic. Merge a reviewed PR into `main` and the
`Build & Release` workflow (`.github/workflows/release.yml`) does the rest:

1. Computes the next version (patch by default; put `[minor]` or `[major]` in
   the merge commit message to bump those, or `[skip release]` to skip).
2. Bumps `package.json`, commits `chore: bump version to vX.Y.Z [skip ci]` to
   `main`, and creates the matching tag.
3. Builds the Windows, Linux (x64), Linux ARM (Raspberry Pi), and macOS
   packages.
4. Publishes a GitHub Release with those installers attached.

You can also run it manually from the Actions tab (`workflow_dispatch`) with an
explicit version or bump type.

## One-time setup: let the release commit land on protected `main`

`main` is protected (every human change lands via a reviewed PR), so the
workflow needs permission to push just its version-bump commit. This does NOT
loosen protection for anyone else: outside contributors still cannot push or
merge; they fork and open a PR, and only a maintainer merges it. Fork PRs never
receive repository secrets and never run with this bypass.

Grant the bump commit a path to `main` in one of two ways:

**Option A - dedicated release token (recommended, works on every plan):**
1. Create a fine-grained Personal Access Token (your GitHub *Settings >
   Developer settings > Fine-grained tokens*) scoped to this repository with
   **Contents: Read and write**.
2. Add it as a repository secret named **`RELEASE_TOKEN`**
   (*repo Settings > Secrets and variables > Actions > New repository secret*).
3. In the `main` ruleset (*Settings > Rules > Rulesets > Protect Main*), add a
   **Bypass** entry for the token's owner (add the **Repository admin** role, or
   your user). Save.

The workflow prefers `RELEASE_TOKEN` when present and falls back to the built-in
`GITHUB_TOKEN` otherwise. The bump commit carries `[skip ci]` so pushing it does
not re-trigger the workflow.

**Option B - allow the built-in Actions token:** if your ruleset's *Add bypass*
dialog lets you add **GitHub Actions** as a bypass actor, add it and skip the
PAT. The default `GITHUB_TOKEN` will then push, and its pushes never re-trigger
a workflow.

## Notes
- The version of record is the git tag; the workflow keeps `package.json` on
  `main` in step with it on every release.
- If a release ever half-completes and leaves a tag without a matching release,
  delete that tag and re-run the workflow.
