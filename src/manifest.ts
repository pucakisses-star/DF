/**
 * The import manifest makes re-runs idempotent: once a source object has been
 * assigned an ID in the target, re-importing uses the same ID (which makes the
 * World Editor update the existing object instead of creating a duplicate),
 * and assets keep their import paths.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { PorterError } from './formats';

export interface Manifest {
  version: 1;
  /** source custom rawcode -> rawcode used in the target */
  idMap: Record<string, string>;
  /** normalized (lowercased, backslash) source asset path -> import path in the target */
  assetMap: Record<string, string>;
}

export function emptyManifest(): Manifest {
  return { version: 1, idMap: {}, assetMap: {} };
}

export function loadManifest(path: string): Manifest {
  if (!existsSync(path)) {
    return emptyManifest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new PorterError(`Manifest ${path} is not valid JSON (${(e as Error).message}). Fix or delete it.`);
  }
  const m = parsed as Partial<Manifest>;
  if (m.version !== 1 || typeof m.idMap !== 'object' || typeof m.assetMap !== 'object') {
    throw new PorterError(`Manifest ${path} has an unexpected shape. Fix or delete it.`);
  }
  return { version: 1, idMap: { ...m.idMap }, assetMap: { ...m.assetMap } };
}

export function saveManifest(path: string, manifest: Manifest): void {
  const sorted: Manifest = {
    version: 1,
    idMap: Object.fromEntries(Object.entries(manifest.idMap).sort(([a], [b]) => a.localeCompare(b))),
    assetMap: Object.fromEntries(Object.entries(manifest.assetMap).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n');
}
