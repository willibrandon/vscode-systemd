# Releasing

Public releases are stable. Use an even minor version so the Visual Studio Marketplace does not
treat the release as a prerelease channel build.

## Requirements

- `main` is clean and all push workflows pass.
- `package.json`, workspace package versions, and lockfiles agree.
- `CHANGELOG.md` contains `## [VERSION] - YYYY-MM-DD`.
- `VSCE_PAT` and `OVSX_PAT` are configured as repository secrets.
- The tag is `vVERSION` and points at the release commit.

## Prepare

1. Update the versions and changelog.
2. Remove unreleased or test-build wording from public docs.
3. Run:

   ```sh
   npm run verify
   npm run test:docs
   npm run package
   npm run check:release-reproducibility
   ```

4. Confirm the VSIX name, version, publisher, stable channel, checksum, SBOM, and packaged file
   list.
5. Commit and push the release preparation. Wait for every required workflow.

## Publish

Create an annotated tag with concise release notes and push only that tag:

```sh
release_version=$(node -p "require('./package.json').version")
git tag -a "v$release_version" -m "systemd Unit Files $release_version"
git push origin "v$release_version"
```

The release workflow rebuilds from the tag, reruns the full gate, reproduces the artifacts, and
tests the exact VSIX on clean desktop, browser, and Remote SSH hosts. It then:

1. Creates provenance and CycloneDX attestations.
2. Creates a draft GitHub release.
3. Publishes the same VSIX to the Visual Studio Marketplace and Open VSX.
4. Verifies registry versions, channels, checksums, installation, and activation.
5. Publishes the GitHub release only after both registries pass.

Do not move or reuse a published tag or version. If a workflow fails, fix the cause and rerun the
same immutable tag only when its commit and artifacts have not changed. Use a new version for any
source or artifact change.
