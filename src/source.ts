/**
 * A source of asset files: either a map/campaign archive (MapData) or a plain
 * folder on disk (FolderData) — e.g. an unzipped Hive Workshop download.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, relative } from 'path';
import { PorterError } from './formats';

export interface AssetSource {
  /** Short human-readable name (file/folder basename). */
  readonly name: string;
  getFileBytes(path: string): Uint8Array | null;
  hasFile(path: string): boolean;
}

export function normalizeAssetPath(path: string): string {
  return path.replace(/\//g, '\\').trim();
}

/**
 * A folder treated as an asset source. Files resolve by relative path
 * (case-insensitive, slash-agnostic), with a basename fallback — Hive models
 * frequently reference textures by paths that don't match the folder layout.
 */
export class FolderData implements AssetSource {
  readonly name: string;
  readonly root: string;
  /** normalized lowercased relative path -> absolute path */
  private byRelPath = new Map<string, string>();
  /** lowercased basename -> absolute paths (may be ambiguous) */
  private byBase = new Map<string, string[]>();
  readonly files: string[] = [];

  constructor(root: string) {
    this.root = root;
    this.name = basename(root);
    let stats;
    try {
      stats = statSync(root);
    } catch {
      throw new PorterError(`${root}: folder not found.`);
    }
    if (!stats.isDirectory()) {
      throw new PorterError(`${root}: not a folder.`);
    }
    this.walk(root);
    if (this.files.length === 0) {
      throw new PorterError(`${this.name}: the folder contains no files.`);
    }
  }

  private walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(abs);
      } else if (entry.isFile()) {
        const rel = normalizeAssetPath(relative(this.root, abs));
        this.files.push(rel);
        this.byRelPath.set(rel.toLowerCase(), abs);
        const base = entry.name.toLowerCase();
        const list = this.byBase.get(base) ?? [];
        list.push(abs);
        this.byBase.set(base, list);
      }
    }
  }

  private resolve(path: string): string | null {
    const norm = normalizeAssetPath(path).toLowerCase();
    const direct = this.byRelPath.get(norm);
    if (direct) {
      return direct;
    }
    const base = norm.slice(norm.lastIndexOf('\\') + 1);
    const candidates = this.byBase.get(base);
    // Ambiguous basenames are not resolved: silently guessing wrong would be
    // worse than a missing-texture warning.
    return candidates && candidates.length === 1 ? candidates[0] : null;
  }

  hasFile(path: string): boolean {
    return this.resolve(path) !== null;
  }

  getFileBytes(path: string): Uint8Array | null {
    const abs = this.resolve(path);
    if (!abs) {
      return null;
    }
    try {
      return new Uint8Array(readFileSync(abs));
    } catch {
      return null;
    }
  }

  /** Relative paths of files with any of the given extensions. */
  filesWithExtension(...extensions: string[]): string[] {
    const lowered = extensions.map((e) => e.toLowerCase());
    return this.files.filter((f) => lowered.some((ext) => f.toLowerCase().endsWith(ext)));
  }
}
