export function getBundledPackages(metafiles, lock) {
  const bundledPaths = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      // The last node_modules segment identifies the package, including nested installs.
      const matches = [...input.matchAll(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/gu)];
      const match = matches.at(-1);
      if (match !== undefined) {
        bundledPaths.set(input.slice(0, match.index + match[0].length), match[1]);
      }
    }
  }

  return new Set(
    [...bundledPaths].map(([path, name]) => {
      const entry = lock.packages[path];
      if (entry?.version === undefined) {
        throw new Error(`bundled dependency ${name} has no versioned lockfile entry at ${path}`);
      }
      return `${name}@${entry.version}`;
    }),
  );
}
