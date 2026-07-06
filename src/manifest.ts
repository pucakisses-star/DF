/**
 * The import manifest makes re-runs idempotent: once a source object has been
 * assigned an ID in the target, re-importing uses the same ID (which makes the
 * World Editor update the existing object instead of creating a duplicate),
 * and assets keep their import paths.
 *
 * Version 2 scopes every key by source name (`<source>|<id>` and
 * `<source>|<path>`) so several maps/folders can feed one target.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { PorterError } from './formats';

export interface Manifest {
  version: 2;
  /** "<sourceKey>|<source rawcode or folder-object name>" -> rawcode used in the target */
  idMap: Record<string, string>;
  /** "<sourceKey>|<normalized source asset path>" -> import path in the target */
  assetMap: Record<string, string>;
}

export function emptyManifest(): Manifest {
  return { version: 2, idMap: {}, assetMap: {} };
}

export function loadManifest(path: string, soleSourceKey?: string): Manifest {
  if (!existsSync(path)) {
    return emptyManifest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new PorterError(`Manifest ${path} is not valid JSON (${(e as Error).message}). Fix or delete it.`);
  }
  const m = parsed as { version?: number; idMap?: Record<string, string>; assetMap?: Record<string, string> };
  if (typeof m.idMap !== 'object' || typeof m.assetMap !== 'object' || m.idMap === null || m.assetMap === null) {
    throw new PorterError(`Manifest ${path} has an unexpected shape. Fix or delete it.`);
  }
  if (m.version === 2) {
    return { version: 2, idMap: { ...m.idMap }, assetMap: { ...m.assetMap } };
  }
  if (m.version === 1) {
    // v1 manifests were single-source and unscoped. When this run also has a
    // single source, migrate by prefixing; otherwise start fresh (the old
    // keys cannot be attributed to a source).
    if (soleSourceKey) {
      const scope = (record: Record<string, string>): Record<string, string> =>
        Object.fromEntries(Object.entries(record).map(([k, v]) => [`${soleSourceKey}|${k}`, v]));
      return { version: 2, idMap: scope(m.idMap), assetMap: scope(m.assetMap) };
    }
    return emptyManifest();
  }
  throw new PorterError(`Manifest ${path} has unsupported version ${m.version}. Fix or delete it.`);
}

export function saveManifest(path: string, manifest: Manifest): void {
  const sorted: Manifest = {
    version: 2,
    idMap: Object.fromEntries(Object.entries(manifest.idMap).sort(([a], [b]) => a.localeCompare(b))),
    assetMap: Object.fromEntries(Object.entries(manifest.assetMap).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n');
}
