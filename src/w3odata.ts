/**
 * Read-only access to an Object Editor export file (.w3o) — the combined
 * object-data file written by the editor's "Export All Object Settings".
 *
 * A .w3o defines objects but carries no assets, so the folder the file lives
 * in doubles as its asset source: models, icons and textures referenced by the
 * exported objects resolve from the surrounding files (e.g. an unzipped Hive
 * download that ships "data.w3o" next to its models).
 *
 * Like maps, exports go through a roundtrip gate at load time: the whole
 * container must re-serialize to the exact same bytes (or a byte-different but
 * structurally identical encoding) before anything trusts the parse.
 */
import { readFileSync } from 'fs';
import { basename, dirname } from 'path';
import { CATEGORIES, CategoryDef, CategoryKey, ObjectFile, PorterError } from './formats';
import { W3O_VERSION, W3oFiles, loadW3o, saveW3o } from './w3o';
import { bytesEqual, toPlain } from './safety';
import { FolderData, ObjectDataSource } from './source';

export class W3oData implements ObjectDataSource {
  readonly path: string;
  readonly name: string;
  readonly isCampaign = false;
  readonly categories = new Map<CategoryKey, { def: CategoryDef; file: ObjectFile }>();
  readonly warnings: string[] = [];
  /** True when the file re-encodes byte-differently but structurally identically. */
  readonly cosmetic: boolean;
  /** The folder next to the .w3o, indexed as this source's asset store. */
  private readonly folder: FolderData | null;

  constructor(path: string) {
    this.path = path;
    this.name = basename(path);

    const bytes = new Uint8Array(readFileSync(path));
    let version: number;
    let files: W3oFiles;
    try {
      ({ version, files } = loadW3o(bytes));
    } catch (e) {
      throw new PorterError(
        `${this.name}: failed to parse as an object-data export (${(e as Error).message}). ` +
          `The file may use a newer format than this tool supports, or may be damaged. Aborting without touching anything.`,
      );
    }
    if (version !== W3O_VERSION) {
      throw new PorterError(
        `${this.name}: unsupported .w3o container version ${version} (this tool supports version ${W3O_VERSION}). Aborting.`,
      );
    }

    this.cosmetic = this.verifyRoundtrip(bytes, files);

    for (const def of CATEGORIES) {
      const file = files[def.key];
      if (file) {
        this.categories.set(def.key, { def, file });
      }
    }
    if (this.categories.size === 0) {
      this.warnings.push(`${this.name}: the export contains no object data in any category.`);
    }

    let folder: FolderData | null = null;
    try {
      folder = new FolderData(dirname(path), { recursive: true });
    } catch {
      // Unreadable directory: object definitions still work, asset lookups miss.
    }
    this.folder = folder;
  }

  /** The roundtrip gate, applied to the whole container. */
  private verifyRoundtrip(bytes: Uint8Array, files: W3oFiles): boolean {
    let resaved: Uint8Array;
    try {
      resaved = saveW3o(files);
    } catch (e) {
      throw new PorterError(`${this.name}: re-serialization failed (${(e as Error).message}). Aborting.`);
    }
    if (bytesEqual(bytes, resaved)) {
      return false;
    }

    // Bytes differ; accept only if a re-parse yields the identical structure.
    let reparsed: W3oFiles;
    try {
      reparsed = loadW3o(resaved).files;
    } catch (e) {
      throw new PorterError(
        `${this.name}: roundtrip verification failed — re-encoded bytes do not parse (${(e as Error).message}). Aborting.`,
      );
    }
    for (const def of CATEGORIES) {
      const before = files[def.key];
      const after = reparsed[def.key];
      const same =
        before === undefined
          ? after === undefined
          : after !== undefined && JSON.stringify(toPlain(before)) === JSON.stringify(toPlain(after));
      if (!same) {
        throw new PorterError(
          `${this.name}: roundtrip verification failed — parsing and re-serializing this file does not preserve its contents. ` +
            `Refusing to continue, because the tool clearly does not fully understand this file.`,
        );
      }
    }
    this.warnings.push(`${this.name}: re-encodes byte-differently but structurally identically (cosmetic; safe).`);
    return true;
  }

  getFileBytes(path: string): Uint8Array | null {
    return this.folder?.getFileBytes(path) ?? null;
  }

  hasFile(path: string): boolean {
    return this.folder?.hasFile(path) ?? false;
  }

  /** Exports carry literal strings, not a string table; nothing to resolve. */
  resolveTrigStr(_value: string): string | undefined {
    return undefined;
  }

  /** Every custom-object rawcode defined in this export, across all categories. */
  customIds(): Set<string> {
    const ids = new Set<string>();
    for (const cat of this.categories.values()) {
      for (const obj of cat.file.customTable.objects) {
        ids.add(obj.newId);
      }
    }
    return ids;
  }

  /** Asset files sitting next to the export (the .w3o itself excluded). */
  importedFileCount(): number {
    if (!this.folder) {
      return 0;
    }
    return this.folder.files.filter((f) => !/\.w3o$/i.test(f)).length;
  }
}
