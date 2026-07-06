/**
 * The porting pipeline:
 *
 *   1. Open source and target read-only; every object file must pass the
 *      roundtrip gate before anything else happens.
 *   2. Resolve the requested objects and walk their dependency closure
 *      (abilities, buffs, trained units, items, upgrades, ...).
 *   3. Assign collision-free rawcodes (stable across runs via the manifest).
 *   4. Rewrite rawcode references, inline TRIGSTR_ strings, collect referenced
 *      imported assets and rewrite their paths.
 *   5. Emit a .w3o + asset folder + report. The target map is never written;
 *      the World Editor's own importers apply the drop.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  CATEGORIES,
  CategoryKey,
  Modification,
  ModifiedObject,
  PorterError,
  War3MapW3o,
  newObjectFile,
} from './formats';
import { IdAllocator, isRawcode, isRawcodeList } from './ids';
import { MapData } from './mapdata';
import { Manifest, emptyManifest, loadManifest, saveManifest } from './manifest';
import { AssetCollector, looksLikeAssetPath } from './assets';
import { buildReport } from './report';

export interface PortOptions {
  sourcePath: string;
  /** Optional but strongly recommended: used to avoid rawcode collisions. */
  targetPath?: string;
  outDir: string;
  /** Rawcodes of the objects to port. Ignored when `all` is set. */
  ids?: string[];
  /** Port every custom object in the source. */
  all?: boolean;
  /** Also port the source's modifications of standard (non-custom) objects. */
  includeStandardMods?: boolean;
  manifestPath?: string;
}

export interface PortedObject {
  category: CategoryKey;
  sourceId: string;
  newId: string;
  baseId: string;
  remapped: boolean;
  /** Why this object was included: 'requested' or the ID of the object that referenced it. */
  reason: string;
  name?: string;
  modifications: number;
}

export interface RewriteRecord {
  objectId: string;
  field: string;
  kind: 'rawcodes' | 'asset' | 'trigstr';
  from: string;
  to: string;
}

export interface PortResult {
  outDir: string;
  w3oPath: string;
  objects: PortedObject[];
  rewrites: RewriteRecord[];
  assets: { sourcePath: string; importPath: string; bytes: number; patched: boolean }[];
  warnings: string[];
  skippedStandardMods: number;
  reportPath: string;
  manifestPath: string;
}

interface SourceEntry {
  category: CategoryKey;
  object: ModifiedObject;
}

/** Best-effort display name: the value of the category's *nam field, if modified. */
function displayName(source: MapData, obj: ModifiedObject): string | undefined {
  for (const mod of obj.modifications) {
    if (mod.variableType === 3 && typeof mod.value === 'string' && /^.nam$/.test(mod.id)) {
      return source.resolveTrigStr(mod.value) ?? mod.value;
    }
  }
  return undefined;
}

function cloneObject(obj: ModifiedObject): ModifiedObject {
  const copy = new ModifiedObject();
  copy.oldId = obj.oldId;
  copy.newId = obj.newId;
  copy.modifications = obj.modifications.map((m) => {
    const mc = new Modification();
    mc.id = m.id;
    mc.variableType = m.variableType;
    mc.levelOrVariation = m.levelOrVariation;
    mc.dataPointer = m.dataPointer;
    mc.value = m.value;
    mc.u1 = m.u1;
    return mc;
  });
  return copy;
}

export function port(options: PortOptions): PortResult {
  const warnings: string[] = [];

  const source = new MapData(options.sourcePath);
  warnings.push(...source.warnings);

  let target: MapData | null = null;
  if (options.targetPath) {
    target = new MapData(options.targetPath);
    warnings.push(...target.warnings);
  } else {
    warnings.push(
      'No target map given: rawcode collisions with the target cannot be detected. Pass --target to enable collision-safe remapping.',
    );
  }

  const manifestPath = options.manifestPath ?? join(options.outDir, 'port-manifest.json');
  const manifest: Manifest = loadManifest(manifestPath);

  // Index every custom object in the source by rawcode. The same rawcode in
  // several categories (legal but unusual) stays aliased: one new ID for all.
  const sourceIndex = new Map<string, SourceEntry[]>();
  let sourceStandardMods = 0;
  for (const cat of source.categories.values()) {
    sourceStandardMods += cat.file.originalTable.objects.length;
    for (const object of cat.file.customTable.objects) {
      const list = sourceIndex.get(object.newId) ?? [];
      list.push({ category: cat.def.key, object });
      sourceIndex.set(object.newId, list);
    }
  }

  if (sourceIndex.size === 0 && !options.includeStandardMods) {
    throw new PorterError(`${source.name}: no custom objects found in any object data file.`);
  }

  // Rawcodes that new allocations must avoid: everything defined in the
  // target, everything defined in the source (other ported objects), and
  // every ID the manifest has handed out before.
  const allocator = new IdAllocator();
  if (target) {
    for (const id of target.customIds()) {
      allocator.claim(id);
    }
  }
  for (const id of sourceIndex.keys()) {
    allocator.claim(id);
  }
  for (const id of Object.values(manifest.idMap)) {
    allocator.claim(id);
  }

  const targetIds = target ? target.customIds() : new Set<string>();

  // --- Closure walk ---------------------------------------------------------

  const roots: string[] = [];
  if (options.all) {
    roots.push(...sourceIndex.keys());
  } else {
    for (const id of options.ids ?? []) {
      if (!isRawcode(id)) {
        throw new PorterError(`'${id}' is not a valid rawcode (must be exactly 4 characters).`);
      }
      if (!sourceIndex.has(id)) {
        throw new PorterError(
          `No custom object with rawcode '${id}' exists in ${source.name}. Run the inspect command to list available objects.`,
        );
      }
      roots.push(id);
    }
    if (roots.length === 0) {
      throw new PorterError('Nothing to port: pass --ids or --all.');
    }
  }

  const idMap = new Map<string, string>(); // source id -> id in target
  const includedBy = new Map<string, string>(); // source id -> reason
  const queue: string[] = [];

  const include = (id: string, reason: string): string => {
    let mapped = idMap.get(id);
    if (mapped) {
      return mapped;
    }
    const manifested = manifest.idMap[id];
    if (manifested) {
      // Re-import: reuse the previous ID so the editor updates in place.
      mapped = manifested;
    } else if (!targetIds.has(id)) {
      mapped = id; // No collision: keep the original rawcode.
      allocator.claim(id);
    } else {
      mapped = allocator.allocate(id);
    }
    idMap.set(id, mapped);
    manifest.idMap[id] = mapped;
    includedBy.set(id, reason);
    queue.push(id);
    return mapped;
  };

  for (const id of roots) {
    include(id, 'requested');
  }

  const assetCollector = new AssetCollector(source, manifest);
  const rewrites: RewriteRecord[] = [];
  const ported: PortedObject[] = [];
  const outputObjects = new Map<CategoryKey, ModifiedObject[]>();

  const rewriteValue = (objectId: string, mod: Modification): void => {
    if (mod.variableType !== 3 || typeof mod.value !== 'string' || mod.value.length === 0) {
      return;
    }
    const original = mod.value;

    // 1. TRIGSTR_nnn -> literal string from the source string table.
    if (/^TRIGSTR_[\-\d]+$/.test(original)) {
      const literal = source.resolveTrigStr(original);
      if (literal !== undefined) {
        mod.value = literal;
        rewrites.push({ objectId, field: mod.id, kind: 'trigstr', from: original, to: literal });
      } else {
        warnings.push(
          `${objectId}.${mod.id}: string reference ${original} not found in the source string table; left unchanged.`,
        );
      }
      return;
    }

    // 2. Rawcode lists: rewrite references to other ported custom objects and
    //    pull those objects into the import.
    if (isRawcodeList(original)) {
      const tokens = original.split(',');
      let touched = false;
      const rewritten = tokens.map((token) => {
        if (sourceIndex.has(token)) {
          touched = true;
          return include(token, objectId);
        }
        return token;
      });
      if (touched) {
        const value = rewritten.join(',');
        if (value !== original) {
          mod.value = value;
          rewrites.push({ objectId, field: mod.id, kind: 'rawcodes', from: original, to: value });
        }
      }
      return;
    }

    // 3. Asset paths (possibly comma-separated, e.g. destructible variations).
    const parts = original.split(',');
    if (parts.every((p) => looksLikeAssetPath(p))) {
      let touched = false;
      const rewritten = parts.map((part) => {
        const imported = assetCollector.collect(part);
        if (imported) {
          touched = true;
          return imported;
        }
        return part; // Stock game asset (not in the source archive): keep.
      });
      if (touched) {
        const value = rewritten.join(',');
        if (value !== original) {
          mod.value = value;
          rewrites.push({ objectId, field: mod.id, kind: 'asset', from: original, to: value });
        }
      }
    }
  };

  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const entry of sourceIndex.get(id) ?? []) {
      const copy = cloneObject(entry.object);
      copy.newId = idMap.get(id)!;

      // A custom object based on another custom object: port the base too.
      if (sourceIndex.has(copy.oldId)) {
        copy.oldId = include(copy.oldId, id);
      }

      for (const mod of copy.modifications) {
        rewriteValue(id, mod);
      }

      const list = outputObjects.get(entry.category) ?? [];
      list.push(copy);
      outputObjects.set(entry.category, list);

      ported.push({
        category: entry.category,
        sourceId: id,
        newId: copy.newId,
        baseId: copy.oldId,
        remapped: copy.newId !== id,
        reason: includedBy.get(id) ?? 'requested',
        name: displayName(source, entry.object),
        modifications: copy.modifications.length,
      });
    }
  }

  // Standard-object modifications (edits to stock units etc.) are only ported
  // when explicitly asked for, because importing them silently changes the
  // target's standard objects.
  const standardMods = new Map<CategoryKey, ModifiedObject[]>();
  let skippedStandardMods = 0;
  if (options.includeStandardMods) {
    for (const cat of source.categories.values()) {
      for (const object of cat.file.originalTable.objects) {
        const copy = cloneObject(object);
        for (const mod of copy.modifications) {
          rewriteValue(copy.oldId, mod);
        }
        const list = standardMods.get(cat.def.key) ?? [];
        list.push(copy);
        standardMods.set(cat.def.key, list);
      }
    }
  } else {
    skippedStandardMods = sourceStandardMods;
    if (sourceStandardMods > 0) {
      warnings.push(
        `${source.name} also modifies ${sourceStandardMods} standard object(s); those edits were NOT ported. Re-run with --include-standard-mods to port them.`,
      );
    }
  }

  warnings.push(...assetCollector.warnings);

  // --- Emit ------------------------------------------------------------------

  const w3o = new War3MapW3o();
  w3o.version = 1;
  for (const def of CATEGORIES) {
    const custom = outputObjects.get(def.key) ?? [];
    const original = standardMods.get(def.key) ?? [];
    if (custom.length === 0 && original.length === 0) {
      continue;
    }
    const file = newObjectFile(def);
    file.version = source.categories.get(def.key)?.file.version ?? 2;
    file.originalTable.objects = original;
    file.customTable.objects = custom;
    // The container types are structurally identical per layout; the compiler
    // cannot see which of the two layouts `file` is, hence the cast.
    (w3o as unknown as Record<string, unknown>)[def.key] = file;
  }

  const w3oBytes = w3o.save();

  // Final self-check: our own output must survive a parse.
  try {
    const check = new War3MapW3o();
    check.load(w3oBytes);
  } catch (e) {
    throw new PorterError(`Internal error: generated .w3o failed to re-parse (${(e as Error).message}). Nothing was written.`);
  }

  mkdirSync(options.outDir, { recursive: true });
  const w3oPath = join(options.outDir, 'import.w3o');
  writeFileSync(w3oPath, w3oBytes);

  const assets = [...assetCollector.assets.values()];
  for (const asset of assets) {
    const rel = asset.importPath.replace(/\\/g, '/');
    const filePath = join(options.outDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, asset.bytes);
  }

  saveManifest(manifestPath, manifest);

  const result: PortResult = {
    outDir: options.outDir,
    w3oPath,
    objects: ported,
    rewrites,
    assets: assets.map((a) => ({
      sourcePath: a.sourcePath,
      importPath: a.importPath,
      bytes: a.bytes.byteLength,
      patched: a.patched,
    })),
    warnings,
    skippedStandardMods,
    reportPath: join(options.outDir, 'report.md'),
    manifestPath,
  };

  writeFileSync(result.reportPath, buildReport(result, source.name, target?.name));

  return result;
}

export { emptyManifest };
