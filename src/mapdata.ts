/**
 * Read-only access to a map (.w3x/.w3m) or campaign (.w3n) archive.
 *
 * Nothing in this module can write to the archive: maps are always loaded in
 * the MPQ parser's readonly mode.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import {
  CATEGORIES,
  CategoryDef,
  CategoryKey,
  ObjectFile,
  PorterError,
  War3Map,
  War3MapWts,
} from './formats';
import { parseVerified, RoundtripResult } from './safety';

export interface LoadedCategory {
  def: CategoryDef;
  /** Archive file name the data came from (war3map.w3u or war3campaign.w3u). */
  fileName: string;
  file: ObjectFile;
  roundtrip: RoundtripResult;
}

export class MapData {
  readonly path: string;
  readonly name: string;
  readonly map: War3Map;
  readonly categories = new Map<CategoryKey, LoadedCategory>();
  readonly strings: War3MapWts | null;
  readonly warnings: string[] = [];
  readonly isCampaign: boolean;

  constructor(path: string) {
    this.path = path;
    this.name = basename(path);
    this.isCampaign = /\.w3n$/i.test(path);

    const bytes = new Uint8Array(readFileSync(path));
    this.map = new War3Map();
    try {
      this.map.load(bytes, true /* readonly */);
    } catch (e) {
      throw new PorterError(`${this.name}: could not open archive (${(e as Error).message})`);
    }

    const prefixes = this.isCampaign ? ['war3campaign', 'war3map'] : ['war3map', 'war3campaign'];

    let sawAnyFile = false;
    for (const def of CATEGORIES) {
      for (const prefix of prefixes) {
        const fileName = `${prefix}.${def.ext}`;
        const raw = this.getFileBytes(fileName);
        if (!raw) {
          continue;
        }
        sawAnyFile = true;
        const { file, roundtrip } = parseVerified(def, raw, `${this.name}/${fileName}`);
        if (roundtrip.message) {
          this.warnings.push(roundtrip.message);
        }
        this.categories.set(def.key, { def, fileName, file, roundtrip });
        break;
      }
    }

    this.strings = this.readStrings(prefixes);

    if (!sawAnyFile && this.map.getFileNames().length === 0) {
      // Not even a listfile and no object data resolvable by name: this is
      // either not a WC3 archive or something is very wrong.
      throw new PorterError(
        `${this.name}: no object data files and no readable file list found. Is this really a WC3 map/campaign?`,
      );
    }
  }

  private readStrings(prefixes: string[]): War3MapWts | null {
    for (const prefix of prefixes) {
      const raw = this.getFileText(`${prefix}.wts`);
      if (raw !== null) {
        const wts = new War3MapWts();
        try {
          wts.load(raw);
          return wts;
        } catch (e) {
          this.warnings.push(`${this.name}: could not parse ${prefix}.wts (${(e as Error).message}); TRIGSTR values will be left as-is.`);
          return null;
        }
      }
    }
    return null;
  }

  /** MPQ paths are case-insensitive and use backslashes. */
  static normalizePath(path: string): string {
    return path.replace(/\//g, '\\');
  }

  getFileBytes(path: string): Uint8Array | null {
    const file = this.map.get(MapData.normalizePath(path));
    if (!file) {
      return null;
    }
    const bytes = file.bytes();
    return bytes ? bytes : null;
  }

  getFileText(path: string): string | null {
    const file = this.map.get(MapData.normalizePath(path));
    if (!file) {
      return null;
    }
    try {
      return file.text();
    } catch {
      return null;
    }
  }

  hasFile(path: string): boolean {
    return this.map.has(MapData.normalizePath(path));
  }

  /** Resolve a TRIGSTR_nnn reference to its literal string, if possible. */
  resolveTrigStr(value: string): string | undefined {
    if (!this.strings) {
      return undefined;
    }
    return this.strings.getString(value);
  }

  /** Every custom-object rawcode defined in this map, across all categories. */
  customIds(): Set<string> {
    const ids = new Set<string>();
    for (const cat of this.categories.values()) {
      for (const obj of cat.file.customTable.objects) {
        ids.add(obj.newId);
      }
    }
    return ids;
  }
}
