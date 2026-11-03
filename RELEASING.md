# Releasing SetupGuard

The procedure for a release. Nothing here runs automatically.

Every step is done by a maintainer, from a clean clone, on a commit of `main`
whose CI is green.

## Versioning

- All packages share one version (`0.1.0` today). Bump every `package.json`
  together, and `--out setupguard-<version>.vsix` in `packages/vscode/package.json`.
- Tags are `v<major>.<minor>.<patch>`, annotated, and never moved or reused.
- The action is referenced by full commit SHA, and every release names its
  commit. Keep recommending SHAs over tags: a tag can be moved by anyone with
  push access, a SHA cannot. A moving major tag (`v0`) is not planned while
  the API is 0.x.

## 1. Preconditions

- [ ] The release commit is on `main`, and the `push` runs of `ci.yml` and
      `setupguard.yml` on it are green.
- [ ] `audit.yml` passes on it. It does not run on push, so dispatch it:
      `gh workflow run audit.yml --ref main`, then `gh run watch` the new run.
- [ ] `node scripts/check-audit-exceptions.mjs` passes, and no exception is
      within a week of its review date. If one is due, review it first
      (Notes/17); never renew a date without new evidence.
- [ ] `CHANGELOG.md` describes the release, with the date filled in.
- [ ] `SECURITY.md` and the README describe the support and security channels
      that actually exist. Private vulnerability reporting can be checked with
      `gh api repos/Jovinull/SetupGuard/private-vulnerability-reporting`.

## 2. Build and verify from a clean clone

```bash
git clone https://github.com/Jovinull/SetupGuard.git setupguard-release
cd setupguard-release
git checkout <release-commit-sha>

pnpm install --frozen-lockfile
pnpm check                                   # lint + typecheck + tests
node scripts/check-audit-exceptions.mjs
pnpm audit                                   # exits 0 with only the recorded exceptions
pnpm audit --prod                            # must report no vulnerability

# The action bundle must be byte-identical to the committed one.
pnpm --filter @setupguard/github-action run bundle
git diff --exit-code -- packages/github-action/dist

# Build first: the extension bundles the compiled workspace packages.
pnpm run build
pnpm --filter setupguard run package
(cd packages/vscode && LC_ALL=C unzip -Z1 setupguard-0.1.0.vsix | LC_ALL=C sort)
# Expect exactly the eight files listed in the `vsix package` job of ci.yml.

# The CLI diagnoses this repository.
node packages/cli/dist/bin.js .              # READY, on Node 24 as .nvmrc pins
node packages/cli/dist/bin.js --version      # the release version

# The notices cover exactly what each bundle inlines.
head -3 packages/github-action/dist/THIRD_PARTY_NOTICES.txt
unzip -p packages/vscode/setupguard-0.1.0.vsix extension/out/THIRD_PARTY_NOTICES.txt | head -3

# Checksums for the release assets (bare file names, so `sha256sum -c` works
# in the download directory).
(cd packages/vscode && sha256sum setupguard-0.1.0.vsix > SHA256SUMS.txt)
sha256sum packages/github-action/dist/index.cjs   # for the release notes
```

## 3. Tag and publish the GitHub release

```bash
git tag -a v0.1.0 <release-commit-sha> -m "SetupGuard 0.1.0"
git push origin v0.1.0

gh release create v0.1.0 --verify-tag --title "SetupGuard v0.1.0" \
  --notes-file <release-notes.md> \
  packages/vscode/setupguard-0.1.0.vsix packages/vscode/SHA256SUMS.txt
```

Release notes: the `0.1.0` section of `CHANGELOG.md`, the commit SHA to pin
the action to, requirements, known limitations, and the SHA-256 of the VSIX
and of the action bundle.

## 4. Verify after publishing

- [ ] `git ls-remote --tags origin 'v0.1.0^{}'` points at the release commit.
- [ ] `gh release download v0.1.0 -D <empty-dir>` then, in that directory,
      `sha256sum -c SHA256SUMS.txt` reports `OK`.
- [ ] The VSIX installs into an isolated profile —
      `code --user-data-dir <tmp> --extensions-dir <tmp> --install-extension setupguard-0.1.0.vsix`
      — and shows `Ready` on `fixtures/healthy-npm` and `Blocked` on
      `fixtures/broken-node-project`.
- [ ] In a separate test repository, a workflow using
      `Jovinull/SetupGuard@<release-commit-sha>`: a pull request that
      references a missing script fails with an annotation; removing it passes.

## Not part of a release yet

Each of these is a separate decision with its own accounts and credentials:

- VS Code Marketplace / Open VSX (publisher account and token).
- GitHub Marketplace listing for the action (requires a repository with
  `action.yml` at the root and no workflow files — a distribution-only repo).
- npm publication of the CLI (packages are `"private": true`).
