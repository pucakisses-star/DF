/**
 * Collects imported files (models, textures, icons, sounds, ...) referenced by
 * ported objects out of the source archive, gives every file a clean
 * `war3mapImported\<name>` path, and patches texture paths inside .mdx models
 * so nothing has to be re-pathed by hand in the Import Manager.
 */
import { MdlxModel } from './formats';
import { MapData } from './mapdata';
import { Manifest } from './manifest';

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
  sourcePath: string;
  importPath: string;
  bytes: Uint8Array;
  /** True when the bytes were rewritten (MDX texture paths patched). */
  patched: boolean;
}

export class AssetCollector {
  /** normalized source path -> collected asset */
  readonly assets = new Map<string, CollectedAsset>();
  readonly warnings: string[] = [];
  private usedImportPaths = new Set<string>();

  constructor(
    private source: MapData,
    private manifest: Manifest,
  ) {
    for (const importPath of Object.values(manifest.assetMap)) {
      this.usedImportPaths.add(importPath.toLowerCase());
    }
  }

  private static normalize(path: string): string {
    return MapData.normalizePath(path.trim()).toLowerCase();
  }

  private static baseName(path: string): string {
    const norm = MapData.normalizePath(path);
    const idx = norm.lastIndexOf('\\');
    return idx >= 0 ? norm.slice(idx + 1) : norm;
  }

  private allocateImportPath(sourcePath: string): string {
    const base = AssetCollector.baseName(sourcePath);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 0; ; i++) {
      const candidate = IMPORT_PREFIX + (i === 0 ? base : `${stem}_${i}${ext}`);
      if (!this.usedImportPaths.has(candidate.toLowerCase())) {
        this.usedImportPaths.add(candidate.toLowerCase());
        return candidate;
      }
    }
  }

  /**
   * Import the file at `path` (as referenced by an object field or a model
   * texture) from the source archive. Returns the new import path, or null
   * when the path does not resolve to a file inside the source archive (then
   * it is a stock game asset and must not be rewritten).
   */
  collect(path: string): string | null {
    const norm = AssetCollector.normalize(path);
    const existing = this.assets.get(norm);
    if (existing) {
      return existing.importPath;
    }

    const bytes = this.source.getFileBytes(path);
    if (!bytes) {
      return null;
    }

    const importPath = this.manifest.assetMap[norm] ?? this.allocateImportPath(path);
    this.manifest.assetMap[norm] = importPath;

    const asset: CollectedAsset = { sourcePath: MapData.normalizePath(path.trim()), importPath, bytes, patched: false };
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

  /** Rewrite in-archive texture paths inside an MDX model to their import paths. */
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
        if (collected && !this.usedImportPaths.has(expected.toLowerCase())) {
          this.usedImportPaths.add(expected.toLowerCase());
          collected.importPath = expected;
          this.manifest.assetMap[norm] = expected;
        }
      }
    }
  }
}
