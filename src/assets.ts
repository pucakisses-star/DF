/**
 * Collects imported files (models, textures, icons, sounds, ...) referenced by
 * ported objects out of an asset source (map archive or plain folder), gives
 * every file a clean `war3mapImported\<name>` path, and patches texture paths
 * inside .mdx models so nothing has to be re-pathed by hand in the Import
 * Manager.
 */
import { MdlxModel } from './formats';
import { Manifest } from './manifest';
import { AssetSource, normalizeAssetPath } from './source';

/** Extensions that mark a string field value as an asset path. */
const ASSET_EXTENSIONS = [
  '.mdl',
  '.mdx',
  '.blp',
  '.tga',
  '.dds',
  '.jpg',
  '.gif',
  '.mp3',
  '.wav',
  '.flac',
  '.txt',
  '.slk',
];

export const IMPORT_PREFIX = 'war3mapImported\\';

export function looksLikeAssetPath(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return ASSET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface CollectedAsset {
  source: string;
  sourcePath: string;
  importPath: string;
  bytes: Uint8Array;
  /** True when the bytes were rewritten (MDX texture paths patched). */
  patched: boolean;
}

/**
 * Allocates import paths that are unique across ALL sources of a drop, so two
 * maps can both ship a `hero.blp` without clobbering each other.
 */
export class ImportPathRegistry {
  private used = new Set<string>();

  claim(importPath: string): void {
    this.used.add(importPath.toLowerCase());
  }

  isFree(importPath: string): boolean {
    return !this.used.has(importPath.toLowerCase());
  }

  allocate(sourcePath: string): string {
    const norm = normalizeAssetPath(sourcePath);
    const base = norm.slice(norm.lastIndexOf('\\') + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 0; ; i++) {
      const candidate = IMPORT_PREFIX + (i === 0 ? base : `${stem}_${i}${ext}`);
      if (this.isFree(candidate)) {
        this.claim(candidate);
        return candidate;
      }
    }
  }
}

export class AssetCollector {
  /** normalized source path -> collected asset */
  readonly assets = new Map<string, CollectedAsset>();
  readonly warnings: string[] = [];

  constructor(
    private source: AssetSource,
    /** Key that scopes this source's entries in the manifest. */
    private sourceKey: string,
    private manifest: Manifest,
    private registry: ImportPathRegistry,
  ) {}

  private static normalize(path: string): string {
    return normalizeAssetPath(path).toLowerCase();
  }

  private manifestKey(normPath: string): string {
    return `${this.sourceKey}|${normPath}`;
  }

  /**
   * Object fields routinely reference models as `.mdl` while the archive
   * stores `.mdx` (the game swaps the extension at load time). Resolve the
   * referenced path to the file that actually exists.
   */
  private resolveActual(path: string): string | null {
    if (this.source.hasFile(path)) {
      return path;
    }
    const lower = path.toLowerCase();
    if (lower.endsWith('.mdl') || lower.endsWith('.mdx')) {
      const swapped = path.slice(0, -1) + (lower.endsWith('.mdl') ? 'x' : 'l');
      if (this.source.hasFile(swapped)) {
        return swapped;
      }
    }
    return null;
  }

  /**
   * Import the file at `path` (as referenced by an object field or a model
   * texture) from the source. Returns the new import path, or null when the
   * path does not resolve to a file inside the source (then it is a stock
   * game asset and must not be rewritten).
   */
  collect(referencedPath: string): string | null {
    const actual = this.resolveActual(referencedPath);
    if (!actual) {
      return null;
    }
    const path = actual;
    const norm = AssetCollector.normalize(path);
    const existing = this.assets.get(norm);
    if (existing) {
      return existing.importPath;
    }

    const bytes = this.source.getFileBytes(path);
    if (!bytes) {
      return null;
    }

    let importPath = this.manifest.assetMap[this.manifestKey(norm)];
    if (importPath) {
      this.registry.claim(importPath);
    } else {
      importPath = this.registry.allocate(path);
      this.manifest.assetMap[this.manifestKey(norm)] = importPath;
    }

    const asset: CollectedAsset = {
      source: this.source.name,
      sourcePath: normalizeAssetPath(path),
      importPath,
      bytes,
      patched: false,
    };
    // Register before recursing so texture cycles cannot loop forever.
    this.assets.set(norm, asset);

    if (norm.endsWith('.mdx')) {
      this.patchModel(asset);
      this.collectPortrait(asset);
    } else if (norm.endsWith('.mdl')) {
      this.warnings.push(
        `${asset.sourcePath}: .mdl (text) models are copied as-is; if this model references custom textures they must keep their original paths.`,
      );
    }

    return importPath;
  }

  /** Rewrite in-source texture paths inside an MDX model to their import paths. */
  private patchModel(asset: CollectedAsset): void {
    let model: MdlxModel;
    try {
      model = new MdlxModel();
      model.load(asset.bytes.slice().buffer as ArrayBuffer);
    } catch (e) {
      this.warnings.push(
        `${asset.sourcePath}: could not parse model (${(e as Error).message}); copied unmodified. ` +
          `If it uses custom textures, import those at their original paths manually.`,
      );
      return;
    }

    let changed = false;
    for (const texture of model.textures) {
      if (!texture.path) {
        continue;
      }
      const newPath = this.collect(texture.path);
      if (newPath && newPath !== texture.path) {
        texture.path = newPath;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    let patchedBytes: Uint8Array;
    try {
      patchedBytes = model.saveMdx();
      // Verify the patched model still parses before trusting it.
      const check = new MdlxModel();
      check.load(patchedBytes.slice().buffer as ArrayBuffer);
    } catch (e) {
      this.warnings.push(
        `${asset.sourcePath}: patching texture paths failed roundtrip verification (${(e as Error).message}); ` +
          `copied unmodified instead — its custom textures keep their original paths.`,
      );
      return;
    }

    asset.bytes = patchedBytes;
    asset.patched = true;
  }

  /** Models often ship with an implicit `<name>_portrait.mdx` next to them. */
  private collectPortrait(asset: CollectedAsset): void {
    const portraitSource = asset.sourcePath.replace(/\.mdx$/i, '_portrait.mdx');
    if (AssetCollector.normalize(portraitSource) === AssetCollector.normalize(asset.sourcePath)) {
      return;
    }
    if (this.source.hasFile(portraitSource)) {
      const portraitImport = this.collect(portraitSource);
      // The game looks the portrait up by the model's path, so its imported
      // name must be "<imported model stem>_portrait.mdx".
      const expected = asset.importPath.replace(/\.mdx$/i, '_portrait.mdx');
      if (portraitImport && portraitImport !== expected) {
        const norm = AssetCollector.normalize(portraitSource);
        const collected = this.assets.get(norm);
        if (collected && this.registry.isFree(expected)) {
          this.registry.claim(expected);
          collected.importPath = expected;
          this.manifest.assetMap[this.manifestKey(norm)] = expected;
        }
      }
    }
  }
}
