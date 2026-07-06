import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MdlxModel, MpqArchive, PorterError, War3MapW3o } from '../src/formats';
import { MapData } from '../src/mapdata';
import { inspect } from '../src/inspect';
import { port } from '../src/porter';
import { writeSourceMap, writeTargetMap } from './fixtures';

let dir: string;
let sourcePath: string;
let targetPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc3-porter-'));
  sourcePath = writeSourceMap(dir).path;
  targetPath = writeTargetMap(dir);
});

describe('MapData / roundtrip gate', () => {
  it('loads a map and verifies every object file roundtrips', () => {
    const data = new MapData(sourcePath);
    expect([...data.categories.keys()].sort()).toEqual(['abilities', 'buffs', 'items', 'units']);
    for (const cat of data.categories.values()) {
      expect(cat.roundtrip.ok).toBe(true);
      expect(cat.roundtrip.cosmetic).toBe(false); // fixture bytes come from the same serializer
    }
    expect(data.customIds()).toEqual(new Set(['h000', 'h001', 'A000', 'B000', 'I000']));
  });

  it('rejects a truncated object file instead of misreading it', () => {
    const bytes = readFileSync(sourcePath);
    const data = new MapData(sourcePath);
    const w3u = data.getFileBytes('war3map.w3u')!;
    // Build a map whose w3u is truncated mid-object.
    const broken = join(dir, 'broken.w3x');
    const archive = new MpqArchive();
    archive.set('war3map.w3u', w3u.slice(0, w3u.byteLength - 5).slice().buffer);
    writeFileSync(broken, archive.save()!);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(() => new MapData(broken)).toThrow(PorterError);
  });

  it('rejects unsupported format versions', () => {
    const data = new MapData(sourcePath);
    const w3u = data.getFileBytes('war3map.w3u')!.slice();
    w3u[0] = 3; // bump little-endian version int to 3 (Reforged 1.33+)
    const archive = new MpqArchive();
    archive.set('war3map.w3u', w3u.slice().buffer);
    const path = join(dir, 'v3.w3x');
    writeFileSync(path, archive.save()!);
    expect(() => new MapData(path)).toThrow(/version 3/);
  });
});

describe('inspect', () => {
  it('lists custom objects with names and standard edits', () => {
    const result = inspect(sourcePath);
    expect(result.objects).toHaveLength(5);
    const h000 = result.objects.find((o) => o.id === 'h000')!;
    expect(h000.baseId).toBe('hfoo');
    expect(h000.name).toBe('Dwarf Rifleman'); // TRIGSTR resolved
    expect(result.standardMods).toBe(1);
  });
});

describe('port', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = join(dir, 'drop');
  });

  it('ports a unit with its full dependency closure and remaps collisions', () => {
    const result = port({
      sourcePath,
      targetPath,
      outDir,
      ids: ['h000'],
    });

    // h000 collides with the target and h001 is taken (target + source), so
    // the unit lands on h002. Its dependencies keep their free rawcodes.
    const unit = result.objects.find((o) => o.sourceId === 'h000')!;
    expect(unit.remapped).toBe(true);
    expect(unit.newId).toBe('h002');
    expect(unit.name).toBe('Dwarf Rifleman');

    const portedIds = result.objects.map((o) => o.sourceId).sort();
    expect(portedIds).toEqual(['A000', 'B000', 'I000', 'h000']); // closure; h001 NOT included
    for (const dep of ['A000', 'B000', 'I000']) {
      const obj = result.objects.find((o) => o.sourceId === dep)!;
      expect(obj.remapped).toBe(false);
      expect(obj.reason).not.toBe('requested');
    }

    // The emitted w3o parses with the reference parser and holds the objects.
    const w3o = new War3MapW3o();
    w3o.load(readFileSync(result.w3oPath));
    expect(w3o.units!.customTable.objects).toHaveLength(1);
    expect(w3o.abilities!.customTable.objects).toHaveLength(1);
    expect(w3o.buffs!.customTable.objects).toHaveLength(1);
    expect(w3o.items!.customTable.objects).toHaveLength(1);
    expect(w3o.units!.customTable.objects[0].newId).toBe('h002');

    const unitMods = Object.fromEntries(
      w3o.units!.customTable.objects[0].modifications.map((m) => [m.id + ':' + m.levelOrVariation, m.value]),
    );
    expect(unitMods['unam:0']).toBe('Dwarf Rifleman'); // TRIGSTR inlined
    expect(unitMods['uabi:0']).toBe('A000,AHbz'); // custom kept, stock untouched
    expect(unitMods['usei:0']).toBe('I000');
    expect(unitMods['uhpm:0']).toBe(500);

    // Ability levels (the optional-ints layout) survive.
    const abilityMods = w3o.abilities!.customTable.objects[0].modifications;
    const buffRefs = abilityMods.filter((m) => m.id === 'abuf');
    expect(buffRefs.map((m) => m.levelOrVariation).sort()).toEqual([1, 2]);
    expect(buffRefs.every((m) => m.value === 'B000')).toBe(true);

    // Standard-object edits were not silently ported.
    expect(result.skippedStandardMods).toBe(1);
    expect(result.warnings.some((w) => w.includes('standard object'))).toBe(true);
  });

  it('collects assets, patches MDX texture paths, and brings the portrait', () => {
    const result = port({ sourcePath, targetPath, outDir, ids: ['h000'] });

    const importPaths = result.assets.map((a) => a.importPath).sort();
    expect(importPaths).toEqual([
      'war3mapImported\\CustomKnight.mdx',
      'war3mapImported\\CustomKnight_portrait.mdx',
      'war3mapImported\\Knight.blp',
    ]);

    const modelPath = join(outDir, 'war3mapImported/CustomKnight.mdx');
    expect(existsSync(modelPath)).toBe(true);
    const model = new MdlxModel();
    model.load(new Uint8Array(readFileSync(modelPath)));
    expect(model.textures.map((t) => t.path)).toEqual(['war3mapImported\\Knight.blp', '']);

    expect(new Uint8Array(readFileSync(join(outDir, 'war3mapImported/Knight.blp')))).toEqual(
      new TextEncoder().encode('fake-blp-bytes'),
    );

    expect(existsSync(result.reportPath)).toBe(true);
    const report = readFileSync(result.reportPath, 'utf8');
    expect(report).toContain('Import Manager');
    expect(report).toContain('import.w3o');
    expect(report).toContain('h002');
  });

  it('is idempotent across runs via the manifest', () => {
    const first = port({ sourcePath, targetPath, outDir: join(dir, 'drop2'), ids: ['h000'] });
    const again = port({
      sourcePath,
      targetPath,
      outDir: join(dir, 'drop2'),
      ids: ['h000'],
    });
    const byId = (r: typeof first) => Object.fromEntries(r.objects.map((o) => [o.sourceId, o.newId]));
    expect(byId(again)).toEqual(byId(first));

    const manifest = JSON.parse(readFileSync(first.manifestPath, 'utf8'));
    expect(manifest.idMap['h000']).toBe('h002');
    expect(manifest.assetMap['war3mapimported\\customknight.mdx']).toBe('war3mapImported\\CustomKnight.mdx');
  });

  it('ports everything with --all and keeps IDs stable for non-colliding objects', () => {
    const result = port({ sourcePath, targetPath, outDir: join(dir, 'drop-all'), all: true });
    const ids = result.objects.map((o) => o.sourceId).sort();
    expect(ids).toEqual(['A000', 'B000', 'I000', 'h000', 'h001']);
    const h001 = result.objects.find((o) => o.sourceId === 'h001')!;
    expect(h001.remapped).toBe(true); // h001 exists in the target too
    expect(h001.newId).not.toBe('h001');
  });

  it('ports standard-object edits only when asked', () => {
    const without = port({ sourcePath, targetPath, outDir: join(dir, 'drop3'), ids: ['h000'] });
    const w3oWithout = new War3MapW3o();
    w3oWithout.load(readFileSync(without.w3oPath));
    expect(w3oWithout.units!.originalTable.objects).toHaveLength(0);

    const withMods = port({
      sourcePath,
      targetPath,
      outDir: join(dir, 'drop4'),
      ids: ['h000'],
      includeStandardMods: true,
    });
    const w3oWith = new War3MapW3o();
    w3oWith.load(readFileSync(withMods.w3oPath));
    expect(w3oWith.units!.originalTable.objects).toHaveLength(1);
    expect(w3oWith.units!.originalTable.objects[0].oldId).toBe('hpea');
  });

  it('fails clearly on unknown rawcodes', () => {
    expect(() => port({ sourcePath, targetPath, outDir: join(dir, 'drop5'), ids: ['xxxx'] })).toThrow(
      /No custom object with rawcode 'xxxx'/,
    );
  });

  it('ports without a target (with a warning instead of collision detection)', () => {
    const result = port({ sourcePath, outDir: join(dir, 'drop6'), ids: ['h000'] });
    expect(result.objects.find((o) => o.sourceId === 'h000')!.newId).toBe('h000');
    expect(result.warnings.some((w) => w.includes('No target map'))).toBe(true);
  });
});
