# Upstream data

Directive and value data is generated from pinned systemd, Podman, and mkosi source. The extension
does not download data at runtime.

## Source lock

`data/upstream.lock.json` records each repository, release tag, commit, tree, preview commit, and
license. `adapterVersion` changes when extraction logic changes in a way that affects generated
output.

Stable data comes from the pinned release. Preview data comes from the pinned development commit.
The target-version setting filters these records without changing the parser.

## Local source layout

By default, the generator reads sibling checkouts:

```text
src/
├── vscode-systemd/
├── systemd/
├── podman/
└── mkosi/
```

Use `SYSTEMD_SOURCE`, `PODMAN_SOURCE`, and `MKOSI_SOURCE` for other locations.

## Commands

```sh
npm run generate
npm run check:generated
npm run check:coverage
npm run check:upstream
npm run check:upstream:corpus
```

Generation updates the registries, version deltas, user database definitions, JSON schemas, and the
source lock. The check commands verify deterministic output, minimum dialect coverage, source
identity, pinned revisions, trees, and real upstream configuration fixtures.

## Updating a pin

1. Check out the intended upstream commits.
2. Run `npm run generate` with all three source paths set.
3. Review the source lock and every generated diff.
4. Add focused tests for changed behavior or previously missing syntax.
5. Run `npm run check:generated`, `npm run check:coverage`, and `npm run verify`.
6. Run the upstream identity and corpus checks against the exact pinned checkouts.

The weekly upstream-drift workflow reports changes from current upstream heads. Its patch is a
review input, not an automatic update.
