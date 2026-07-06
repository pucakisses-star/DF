/**
 * The porting pipeline:
 *
 *   1. Open every source (maps, campaigns, asset folders) and the target
 *      read-only; every object file must pass the roundtrip gate first.
 *   2. Resolve the requested objects per source and walk each dependency
 *      closure (abilities, buffs, trained units, items, upgrades, ...). Asset
 *      folders contribute synthesized objects (a new unit/doodad/... wearing a
 *      downloaded model).
 *   3. Assign rawcodes that are collision-free across the target AND all
 *      sources (stable across runs via the manifest).
 *   4. Rewrite rawcode references, inline TRIGSTR_ strings, collect referenced
 *      assets and rewrite their paths (unique across all sources).
 *   5. Emit one combined .w3o + asset folder + report. The target map is never
 *      written; the World Editor's own importers apply the drop.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  CATEGORIES,
  CategoryKey,
  Modification,
  ModificationSet,
  PorterError,
  W3Object,
  newObjectFile,
} from './formats';
import { loadW3o, saveW3o, W3oFiles } from './w3o';
import { IdAllocator, isRawcode, isRawcodeList } from './ids';
import { MapData } from './mapdata';
import { FolderData } from './source';
import { FolderObjectSpec, folderObjectDefaults, synthesizeObject } from './folderobjects';
import { Manifest, loadManifest, saveManifest } from './manifest';
import { AssetCollector, ImportPathRegistry, looksLikeAssetPath } from './assets';
import { buildReport } from './report';

export type SourceSpec =
  | {
      kind: 'map';
      path: string;
      /** Rawcodes to port from this map. Ignored when `all` is set. */
      ids?: string[];
      /** Port every custom object in this map. */
      all?: boolean;
    }
  | {
      kind: 'folder';
      path: string;
      /** Objects to create from the folder's assets. */
      objects: FolderObjectSpec[];
    };

export interface PortOptions {
  sources?: SourceSpec[];
  /** Legacy single-map form; merged into `sources`. */
  sourcePath?: string;
  ids?: string[];
  all?: boolean;
  /** Optional but strongly recommended: used to avoid rawcode collisions. */
  targetPath?: string;
  outDir: string;
  /** Also port map sources' modifications of standard (non-custom) objects. */
  includeStandardMods?: boolean;
  manifestPath?: string;
}

export interface PortedObject {
  source: string;
  category: CategoryKey;
  sourceId: string;
  newId: string;
  baseId: string;
  remapped: boolean;
  /** Why this object was included: 'requested', 'created from folder', or the referencing object's ID. */
  reason: string;
  name?: string;
  modifications: number;
}

export interface RewriteRecord {
  source: string;
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
  assets: { source: string; sourcePath: string; importPath: string; bytes: number; patched: boolean }[];
  warnings: string[];
  skippedStandardMods: number;
  reportPath: string;
  manifestPath: string;
}

interface SourceEntry {
  category: CategoryKey;
  object: W3Object;
}

/** Best-effort display name: the value of the category's *nam field, if modified. */
function displayName(obj: W3Object, resolveTrigStr: (v: string) => string | undefined): string | undefined {
  for (const mod of obj.modifications) {
    if (mod.variableType === 3 && typeof mod.value === 'string' && /^.nam$/.test(mod.id)) {
      return resolveTrigStr(mod.value) ?? mod.value;
    }
  }
  return undefined;
}

function cloneObject(obj: W3Object): W3Object {
  const copy = new W3Object();
  copy.oldId = obj.oldId;
  copy.newId = obj.newId;
  copy.sets = obj.sets.map((set) => {
    const sc = new ModificationSet();
    sc.flag = set.flag;
    sc.modifications = set.modifications.map((m) => {
      const mc = new Modification();
      mc.id = m.id;
      mc.variableType = m.variableType;
      mc.levelOrVariation = m.levelOrVariation;
      mc.dataPointer = m.dataPointer;
      mc.value = m.value;
      mc.u1 = m.u1;
      return mc;
    });
    return sc;
  });
  return copy;
}

/** Unique short keys for sources (basenames, disambiguated when repeated). */
function sourceKeys(specs: SourceSpec[]): string[] {
  const seen = new Map<string, number>();
  return specs.map((spec) => {
    const base = spec.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? spec.path;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count + 1}`;
  });
}

export function port(options: PortOptions): PortResult {
  const warnings: string[] = [];

  const specs: SourceSpec[] = [...(options.sources ?? [])];
  if (options.sourcePath) {
    specs.push({ kind: 'map', path: options.sourcePath, ids: options.ids, all: options.all });
  }
  if (specs.length === 0) {
    throw new PorterError('No sources given: pass at least one map or asset folder.');
  }

  let target: MapData | null = null;
  if (options.targetPath) {
    target = new MapData(options.targetPath);
    warnings.push(...target.warnings);
  } else {
    warnings.push(
      'No target map given: rawcode collisions with the target cannot be detected. Pass a target to enable collision-safe remapping.',
    );
  }

  const keys = sourceKeys(specs);
  const manifestPath = options.manifestPath ?? join(options.outDir, 'port-manifest.json');
  const manifest: Manifest = loadManifest(
    manifestPath,
    specs.length === 1 && specs[0].kind === 'map' ? keys[0] : undefined,
  );

  // --- Load sources ----------------------------------------------------------

  interface LoadedMapSource {
    kind: 'map';
    key: string;
    spec: Extract<SourceSpec, { kind: 'map' }>;
    data: MapData;
    index: Map<string, SourceEntry[]>;
    standardMods: number;
  }
  interface LoadedFolderSource {
    kind: 'folder';
    key: string;
    spec: Extract<SourceSpec, { kind: 'folder' }>;
    data: FolderData;
  }
  type LoadedSource = LoadedMapSource | LoadedFolderSource;

  const sources: LoadedSource[] = specs.map((spec, i) => {
    if (spec.kind === 'map') {
      const data = new MapData(spec.path);
      warnings.push(...data.warnings);
      const index = new Map<string, SourceEntry[]>();
      let standardMods = 0;
      for (const cat of data.categories.values()) {
        standardMods += cat.file.originalTable.objects.length;
        for (const object of cat.file.customTable.objects) {
          const list = index.get(object.newId) ?? [];
          list.push({ category: cat.def.key, object });
          index.set(object.newId, list);
        }
      }
      return { kind: 'map', key: keys[i], spec, data, index, standardMods };
    }
    const data = new FolderData(spec.path);
    if (spec.objects.length === 0) {
      throw new PorterError(`${data.name}: no objects specified to create from this folder.`);
    }
    return { kind: 'folder', key: keys[i], spec, data };
  });

  // --- ID allocation domain --------------------------------------------------

  const allocator = new IdAllocator();
  if (target) {
    for (const id of target.customIds()) {
      allocator.claim(id);
    }
  }
  for (const source of sources) {
    if (source.kind === 'map') {
      for (const id of source.index.keys()) {
        allocator.claim(id);
      }
    }
  }
  for (const id of Object.values(manifest.idMap)) {
    allocator.claim(id);
  }
  const targetIds = target ? target.customIds() : new Set<string>();

  // --- Per-source closure walks ---------------------------------------------

  const rewrites: RewriteRecord[] = [];
  const ported: PortedObject[] = [];
  const outputObjects = new Map<CategoryKey, W3Object[]>();
  const standardMods = new Map<CategoryKey, W3Object[]>();
  const registry = new ImportPathRegistry();
  const collectors: AssetCollector[] = [];
  let totalSkippedStandardMods = 0;

  const pushOutput = (category: CategoryKey, obj: W3Object): void => {
    const list = outputObjects.get(category) ?? [];
    list.push(obj);
    outputObjects.set(category, list);
  };

  for (const source of sources) {
    const collector = new AssetCollector(source.data, source.key, manifest, registry);
    collectors.push(collector);

    // Shared string-field rewriting (TRIGSTR / rawcode lists / asset paths).
    // `resolveRef` maps a rawcode reference to its ported ID if the token is a
    // custom object of THIS source (folders have no rawcode references).
    const rewriteValue = (
      objectId: string,
      mod: Modification,
      resolveRef: ((token: string) => string | null) | null,
      resolveTrigStr: (v: string) => string | undefined,
    ): void => {
      if (mod.variableType !== 3 || typeof mod.value !== 'string' || mod.value.length === 0) {
        return;
      }
      const original = mod.value;

      if (/^TRIGSTR_[\-\d]+$/.test(original)) {
        const literal = resolveTrigStr(original);
        if (literal !== undefined) {
          mod.value = literal;
          rewrites.push({ source: source.key, objectId, field: mod.id, kind: 'trigstr', from: original, to: literal });
        } else {
          warnings.push(
            `${source.key}: ${objectId}.${mod.id}: string reference ${original} not found in the source string table; left unchanged.`,
          );
        }
        return;
      }

      if (resolveRef && isRawcodeList(original)) {
        const tokens = original.split(',');
        let touched = false;
        const rewritten = tokens.map((token) => {
          const mapped = resolveRef(token);
          if (mapped !== null) {
            touched = true;
            return mapped;
          }
          return token;
        });
        if (touched) {
          const value = rewritten.join(',');
          if (value !== original) {
            mod.value = value;
            rewrites.push({ source: source.key, objectId, field: mod.id, kind: 'rawcodes', from: original, to: value });
          }
        }
        return;
      }

      const parts = original.split(',');
      if (parts.every((p) => looksLikeAssetPath(p))) {
        let touched = false;
        const rewritten = parts.map((part) => {
          const imported = collector.collect(part);
          if (imported) {
            touched = true;
            return imported;
          }
          return part; // Stock game asset (not in the source): keep.
        });
        if (touched) {
          const value = rewritten.join(',');
          if (value !== original) {
            mod.value = value;
            rewrites.push({ source: source.key, objectId, field: mod.id, kind: 'asset', from: original, to: value });
          }
        }
      }
    };

    if (source.kind === 'folder') {
      // Synthesize one object per spec; no closure to walk.
      for (const spec of source.spec.objects) {
        const manifestKey = `${source.key}|folder:${spec.name}`;
        let newId = manifest.idMap[manifestKey];
        if (!newId) {
          if (spec.preferredId && isRawcode(spec.preferredId) && !allocator.has(spec.preferredId)) {
            newId = spec.preferredId;
            allocator.claim(newId);
          } else {
            newId = allocator.allocate(folderObjectDefaults(spec.category).idPrefix + '000');
          }
          manifest.idMap[manifestKey] = newId;
        } else {
          allocator.claim(newId);
        }

        if (!source.data.hasFile(spec.modelPath)) {
          throw new PorterError(`${source.key}: model '${spec.modelPath}' not found in the folder.`);
        }
        const obj = synthesizeObject(spec, newId);
        for (const mod of obj.modifications) {
          rewriteValue(newId, mod, null, () => undefined);
        }
        pushOutput(spec.category, obj);
        ported.push({
          source: source.key,
          category: spec.category,
          sourceId: spec.name,
          newId,
          baseId: obj.oldId,
          remapped: false,
          reason: 'created from folder',
          name: spec.name,
          modifications: obj.modifications.length,
        });
      }
      continue;
    }

    // Map source: closure walk.
    const { index, data, spec } = source;
    if (index.size === 0 && !(options.includeStandardMods && source.standardMods > 0)) {
      warnings.push(`${source.key}: no custom objects found in any object data file.`);
      continue;
    }

    const roots: string[] = [];
    if (spec.all) {
      roots.push(...index.keys());
    } else {
      for (const id of spec.ids ?? []) {
        if (!isRawcode(id)) {
          throw new PorterError(`${source.key}: '${id}' is not a valid rawcode (must be exactly 4 characters).`);
        }
        if (!index.has(id)) {
          throw new PorterError(
            `${source.key}: no custom object with rawcode '${id}' exists. Run the inspect command to list available objects.`,
          );
        }
        roots.push(id);
      }
      if (roots.length === 0 && index.size > 0) {
        throw new PorterError(`${source.key}: nothing selected to port (pass ids or all).`);
      }
    }

    const idMap = new Map<string, string>();
    const includedBy = new Map<string, string>();
    const queue: string[] = [];

    const include = (id: string, reason: string): string => {
      let mapped = idMap.get(id);
      if (mapped) {
        return mapped;
      }
      const manifestKey = `${source.key}|${id}`;
      const manifested = manifest.idMap[manifestKey];
      if (manifested) {
        // Re-import: reuse the previous ID so the editor updates in place.
        mapped = manifested;
      } else if (!targetIds.has(id) && (!allocator.has(id) || sourceOwnsId(id))) {
        mapped = id; // No collision: keep the original rawcode.
      } else {
        mapped = allocator.allocate(id);
      }
      allocator.claim(mapped);
      idMap.set(id, mapped);
      manifest.idMap[manifestKey] = mapped;
      includedBy.set(id, reason);
      queue.push(id);
      return mapped;
    };

    // An ID counts as "free" for this source if the only claim on it is this
    // source's own definition of it (allocator pre-claimed all source IDs).
    const sourceOwnsId = (id: string): boolean => {
      if (targetIds.has(id)) {
        return false;
      }
      for (const other of sources) {
        if (other !== source && other.kind === 'map' && other.index.has(id)) {
          return false;
        }
      }
      // Was it already assigned as someone's NEW id?
      for (const [key, value] of Object.entries(manifest.idMap)) {
        if (value === id && !key.startsWith(`${source.key}|`)) {
          return false;
        }
      }
      return index.has(id);
    };

    const resolveRef = (token: string): string | null => (index.has(token) ? include(token, 'referenced') : null);

    for (const id of roots) {
      include(id, 'requested');
    }

    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const entry of index.get(id) ?? []) {
        const copy = cloneObject(entry.object);
        copy.newId = idMap.get(id)!;

        // A custom object based on another custom object: port the base too.
        if (index.has(copy.oldId)) {
          copy.oldId = include(copy.oldId, id);
        }

        for (const mod of copy.modifications) {
          rewriteValue(id, mod, resolveRef, (v) => data.resolveTrigStr(v));
        }

        pushOutput(entry.category, copy);
        ported.push({
          source: source.key,
          category: entry.category,
          sourceId: id,
          newId: copy.newId,
          baseId: copy.oldId,
          remapped: copy.newId !== id,
          reason: includedBy.get(id) ?? 'requested',
          name: displayName(entry.object, (v) => data.resolveTrigStr(v)),
          modifications: copy.modifications.length,
        });
      }
    }

    // Standard-object modifications (edits to stock units etc.) are only
    // ported when explicitly asked for, because importing them silently
    // changes the target's standard objects.
    if (options.includeStandardMods) {
      for (const cat of data.categories.values()) {
        for (const object of cat.file.originalTable.objects) {
          const copy = cloneObject(object);
          for (const mod of copy.modifications) {
            rewriteValue(copy.oldId, mod, resolveRef, (v) => data.resolveTrigStr(v));
          }
          const existing = standardMods.get(cat.def.key) ?? [];
          if (existing.some((o) => o.oldId === copy.oldId)) {
            warnings.push(
              `${source.key}: standard object '${copy.oldId}' is also modified by another source; both edits are included and the editor applies them in order.`,
            );
          }
          existing.push(copy);
          standardMods.set(cat.def.key, existing);
        }
      }
    } else {
      totalSkippedStandardMods += source.standardMods;
      if (source.standardMods > 0) {
        warnings.push(
          `${source.key} also modifies ${source.standardMods} standard object(s); those edits were NOT ported. Enable "include standard mods" to port them.`,
        );
      }
    }
  }

  for (const collector of collectors) {
    warnings.push(...collector.warnings);
  }

  if (ported.length === 0 && standardMods.size === 0) {
    throw new PorterError('Nothing to port: no objects were selected or created.');
  }

  // --- Emit ------------------------------------------------------------------

  // Any v3 (Reforged 1.33+) source forces the whole drop to v3, because a
  // single category file cannot mix framings. The 1.33+ editor reads both.
  const maxSourceVersion = Math.max(
    2,
    ...sources
      .filter((s): s is LoadedMapSource => s.kind === 'map')
      .flatMap((s) => [...s.data.categories.values()].map((c) => c.file.version)),
  );

  const w3oFiles: W3oFiles = {};
  for (const def of CATEGORIES) {
    const custom = outputObjects.get(def.key) ?? [];
    const original = standardMods.get(def.key) ?? [];
    if (custom.length === 0 && original.length === 0) {
      continue;
    }
    const file = newObjectFile(def);
    file.version = maxSourceVersion;
    file.originalTable.objects = original;
    file.customTable.objects = custom;
    w3oFiles[def.key] = file;
  }

  const w3oBytes = saveW3o(w3oFiles);

  // Final self-check: our own output must survive a parse.
  try {
    loadW3o(w3oBytes);
  } catch (e) {
    throw new PorterError(`Internal error: generated .w3o failed to re-parse (${(e as Error).message}). Nothing was written.`);
  }

  mkdirSync(options.outDir, { recursive: true });
  const w3oPath = join(options.outDir, 'import.w3o');
  writeFileSync(w3oPath, w3oBytes);

  const allAssets = collectors.flatMap((c) => [...c.assets.values()]);
  for (const asset of allAssets) {
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
    assets: allAssets.map((a) => ({
      source: a.source,
      sourcePath: a.sourcePath,
      importPath: a.importPath,
      bytes: a.bytes.byteLength,
      patched: a.patched,
    })),
    warnings,
    skippedStandardMods: totalSkippedStandardMods,
    reportPath: join(options.outDir, 'report.md'),
    manifestPath,
  };

  writeFileSync(
    result.reportPath,
    buildReport(result, sources.map((s) => s.key).join(', '), target?.name),
  );

  return result;
}
