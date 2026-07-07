/**
 * Thin re-export layer over mdx-m3-viewer's parsers.
 *
 * Everything binary-format-related goes through this battle-tested library;
 * this project never hand-serializes any Warcraft III format.
 */
import War3Map from 'mdx-m3-viewer/dist/cjs/parsers/w3x/map';
import War3MapW3u from 'mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/file';
import War3MapW3d from 'mdx-m3-viewer/dist/cjs/parsers/w3x/w3d/file';
import War3MapW3o from 'mdx-m3-viewer/dist/cjs/parsers/w3x/w3o/file';
import War3MapWts from 'mdx-m3-viewer/dist/cjs/parsers/w3x/wts/file';
import War3MapImp from 'mdx-m3-viewer/dist/cjs/parsers/w3x/imp/file';
import MdlxModel from 'mdx-m3-viewer/dist/cjs/parsers/mdlx/model';
import MpqArchive from 'mdx-m3-viewer/dist/cjs/parsers/mpq/archive';
import { Modification, ObjectDataFile, W3Object } from './objectdata';

export {
  War3Map,
  War3MapW3u,
  War3MapW3d,
  War3MapW3o,
  War3MapWts,
  War3MapImp,
  Modification,
  ObjectDataFile,
  W3Object,
  MdlxModel,
  MpqArchive,
};

/**
 * An object-data file. Our own serializer (objectdata.ts) handles versions
 * 1-3 including Reforged 1.33+ modification sets.
 */
export type ObjectFile = ObjectDataFile;

export type CategoryKey =
  | 'units'
  | 'items'
  | 'destructables'
  | 'doodads'
  | 'abilities'
  | 'buffs'
  | 'upgrades';

export interface CategoryDef {
  key: CategoryKey;
  /** File extension inside the map archive (war3map.<ext> / war3campaign.<ext>). */
  ext: string;
  /**
   * Doodads, abilities and upgrades store two extra ints (level/variation and
   * data pointer) per modification; the others don't. This is the single most
   * common corruption source in hand-written tools.
   */
  optionalInts: boolean;
  /** Human name used in reports. */
  label: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  { key: 'units', ext: 'w3u', optionalInts: false, label: 'Units' },
  { key: 'items', ext: 'w3t', optionalInts: false, label: 'Items' },
  { key: 'destructables', ext: 'w3b', optionalInts: false, label: 'Destructibles' },
  { key: 'doodads', ext: 'w3d', optionalInts: true, label: 'Doodads' },
  { key: 'abilities', ext: 'w3a', optionalInts: true, label: 'Abilities' },
  { key: 'buffs', ext: 'w3h', optionalInts: false, label: 'Buffs/Effects' },
  { key: 'upgrades', ext: 'w3q', optionalInts: true, label: 'Upgrades' },
] as const;

export function categoryByKey(key: CategoryKey): CategoryDef {
  const def = CATEGORIES.find((c) => c.key === key);
  if (!def) {
    throw new Error(`Unknown category: ${key}`);
  }
  return def;
}

export function newObjectFile(def: CategoryDef): ObjectFile {
  return new ObjectDataFile(def.optionalInts);
}

export function parseObjectFile(def: CategoryDef, bytes: Uint8Array): ObjectFile {
  const file = newObjectFile(def);
  file.load(bytes);
  return file;
}

/** Errors that should abort the run with a clean, user-facing message. */
export class PorterError extends Error {}
