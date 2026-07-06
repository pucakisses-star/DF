import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MdlxModel, Modification, ModificationSet, MpqArchive, ObjectDataFile, PorterError, War3MapW3o } from '../src/formats';
import { loadW3o } from '../src/w3o';
import { MapData } from '../src/mapdata';
import { inspect } from '../src/inspect';
import { port } from '../src/porter';
import { makeModel, makeObject, writeSourceMap, writeTargetMap } from './fixtures';

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

  it('rejects unsupported future format versions with a clear message', () => {
    const data = new MapData(sourcePath);
    const w3u = data.getFileBytes('war3map.w3u')!.slice();
    w3u[0] = 4; // bump little-endian version int past everything known
    const archive = new MpqArchive();
    archive.set('war3map.w3u', w3u.slice().buffer);
    const path = join(dir, 'v4.w3x');
    writeFileSync(path, archive.save()!);
    expect(() => new MapData(path)).toThrow(/version 4/);
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
    expect(manifest.version).toBe(2);
    expect(manifest.idMap['source.w3x|h000']).toBe('h002');
    expect(manifest.assetMap['source.w3x|war3mapimported\\customknight.mdx']).toBe(
      'war3mapImported\\CustomKnight.mdx',
    );
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
      /no custom object with rawcode 'xxxx'/,
    );
  });

  it('ports without a target (with a warning instead of collision detection)', () => {
    const result = port({ sourcePath, outDir: join(dir, 'drop6'), ids: ['h000'] });
    expect(result.objects.find((o) => o.sourceId === 'h000')!.newId).toBe('h000');
    expect(result.warnings.some((w) => w.includes('No target map'))).toBe(true);
  });
});

describe('multi-source port', () => {
  it('ports from two maps at once with cross-source collision handling', () => {
    // Second source: a copy of the source map (same rawcodes everywhere).
    const source2 = join(dir, 'source2.w3x');
    writeFileSync(source2, readFileSync(sourcePath));

    const result = port({
      sources: [
        { kind: 'map', path: sourcePath, ids: ['h000'] },
        { kind: 'map', path: source2, ids: ['h000'] },
      ],
      targetPath,
      outDir: join(dir, 'drop-multi'),
    });

    // 4 objects per source (unit + ability + buff + item).
    expect(result.objects).toHaveLength(8);
    const bySource = new Map<string, string[]>();
    for (const obj of result.objects) {
      const list = bySource.get(obj.source) ?? [];
      list.push(obj.newId);
      bySource.set(obj.source, list);
    }
    expect([...bySource.keys()].sort()).toEqual(['source.w3x', 'source2.w3x']);

    // No two ported objects may share an ID, and none may collide with the target.
    const allIds = result.objects.map((o) => o.newId);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).not.toContain('h000');
    expect(allIds).not.toContain('h001');

    // Both sources ship CustomKnight.mdx; import paths must not clobber.
    const importPaths = result.assets.map((a) => a.importPath);
    expect(new Set(importPaths.map((p) => p.toLowerCase())).size).toBe(importPaths.length);

    // Each source's unit must reference ITS OWN remapped ability.
    const w3o = new War3MapW3o();
    w3o.load(readFileSync(result.w3oPath));
    expect(w3o.units!.customTable.objects).toHaveLength(2);
    const abilityIds = w3o.abilities!.customTable.objects.map((o) => o.newId);
    for (const unit of w3o.units!.customTable.objects) {
      const uabi = unit.modifications.find((m) => m.id === 'uabi')!.value as string;
      const customRef = uabi.split(',').filter((t) => t !== 'AHbz');
      expect(customRef).toHaveLength(1);
      expect(abilityIds).toContain(customRef[0]);
    }
  });
});

describe('folder sources (Hive downloads)', () => {
  it('creates a unit from a model folder with re-pathed assets', () => {
    const folder = join(dir, 'HiveDwarf');
    mkdirSync(join(folder, 'textures'), { recursive: true });
    writeFileSync(join(folder, 'DwarfHero.mdx'), makeModel('DwarfHero', ['textures\\dwarf.blp']));
    writeFileSync(join(folder, 'textures', 'dwarf.blp'), 'fake-dwarf-texture');
    writeFileSync(join(folder, 'icon.blp'), 'fake-icon');

    const result = port({
      sources: [
        {
          kind: 'folder',
          path: folder,
          objects: [
            {
              category: 'units',
              name: 'Dwarf Hero',
              modelPath: 'DwarfHero.mdx',
              iconPath: 'icon.blp',
            },
          ],
        },
      ],
      targetPath,
      outDir: join(dir, 'drop-folder'),
    });

    expect(result.objects).toHaveLength(1);
    const unit = result.objects[0];
    expect(unit.category).toBe('units');
    expect(unit.baseId).toBe('hfoo');
    expect(unit.reason).toBe('created from folder');
    expect(unit.newId).not.toBe('h000'); // target owns h000

    const w3o = new War3MapW3o();
    w3o.load(readFileSync(result.w3oPath));
    const mods = Object.fromEntries(w3o.units!.customTable.objects[0].modifications.map((m) => [m.id, m.value]));
    expect(mods['unam']).toBe('Dwarf Hero');
    expect(mods['umdl']).toBe('war3mapImported\\DwarfHero.mdx');
    expect(mods['uico']).toBe('war3mapImported\\icon.blp');

    // Model texture path patched to the imported texture.
    const model = new MdlxModel();
    model.load(new Uint8Array(readFileSync(join(result.outDir, 'war3mapImported/DwarfHero.mdx'))));
    expect(model.textures[0].path).toBe('war3mapImported\\dwarf.blp');

    // Idempotent: second run keeps the same generated ID.
    const again = port({
      sources: [
        {
          kind: 'folder',
          path: folder,
          objects: [{ category: 'units', name: 'Dwarf Hero', modelPath: 'DwarfHero.mdx', iconPath: 'icon.blp' }],
        },
      ],
      targetPath,
      outDir: join(dir, 'drop-folder'),
    });
    expect(again.objects[0].newId).toBe(unit.newId);
  });

  it('rejects a folder spec whose model is missing', () => {
    const folder = join(dir, 'EmptyFolder');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'readme.txt'), 'hi');
    expect(() =>
      port({
        sources: [
          { kind: 'folder', path: folder, objects: [{ category: 'units', name: 'X', modelPath: 'nope.mdx' }] },
        ],
        outDir: join(dir, 'drop-folder2'),
      }),
    ).toThrow(/model 'nope.mdx' not found/);
  });
});

describe('Reforged 1.33+ object data (format v3, modification sets)', () => {
  it('parses a hand-assembled v3 byte layout exactly as documented', () => {
    // version=3; originalTable empty; customTable: 1 object with 2 sets:
    // set0 (flag 0) holds one int mod, set1 (flag 7) holds one string mod.
    const str = 'Hi';
    const bytes = new Uint8Array(256); // generous; sliced to the written length below
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        bytes[offset + i] = text.charCodeAt(i);
      }
    };
    let o = 0;
    view.setInt32(o, 3, true); o += 4;        // version
    view.setUint32(o, 0, true); o += 4;       // original table count
    view.setUint32(o, 1, true); o += 4;       // custom table count
    ascii(o, 'hfoo'); o += 4;                 // oldId
    ascii(o, 'h300'); o += 4;                 // newId
    view.setUint32(o, 2, true); o += 4;       // set count
    view.setInt32(o, 0, true); o += 4;        // set 0 flag
    view.setUint32(o, 1, true); o += 4;       // set 0 mod count
    ascii(o, 'uhpm'); o += 4;                 // mod id
    view.setInt32(o, 0, true); o += 4;        // variable type int
    view.setInt32(o, 777, true); o += 4;      // value
    view.setInt32(o, 0, true); o += 4;        // end token
    view.setInt32(o, 7, true); o += 4;        // set 1 flag
    view.setUint32(o, 1, true); o += 4;       // set 1 mod count
    ascii(o, 'unam'); o += 4;                 // mod id
    view.setInt32(o, 3, true); o += 4;        // variable type string
    ascii(o, str); o += str.length + 1;       // null-terminated value
    view.setInt32(o, 0, true); o += 4;        // end token

    const data = bytes.slice(0, o);
    const file = new ObjectDataFile(false);
    file.load(data);
    expect(file.version).toBe(3);
    const obj = file.customTable.objects[0];
    expect(obj.oldId).toBe('hfoo');
    expect(obj.newId).toBe('h300');
    expect(obj.sets).toHaveLength(2);
    expect(obj.sets[0].modifications[0].value).toBe(777);
    expect(obj.sets[1].flag).toBe(7);
    expect(obj.sets[1].modifications[0].value).toBe('Hi');
    // And it must roundtrip byte-exactly.
    expect(Buffer.compare(Buffer.from(file.save()), Buffer.from(data))).toBe(0);
  });

  it('ports from a v3 map, preserving sets, and emits a v3 drop', () => {
    // Build a v3 source map with our serializer (gate verifies the roundtrip).
    const w3u = new ObjectDataFile(false);
    w3u.version = 3;
    const unit = makeObject('hfoo', 'h300', [
      { id: 'unam', type: 3, value: 'Sets Unit' },
      { id: 'umdl', type: 3, value: 'war3mapImported\\Knight2.mdl' }, // .mdl ref, .mdx file
    ]);
    const extraSet = new ModificationSet();
    extraSet.flag = 1;
    const extraMod = new Modification();
    extraMod.id = 'uhpm';
    extraMod.variableType = 0;
    extraMod.value = 1234;
    extraSet.modifications.push(extraMod);
    unit.sets.push(extraSet);
    w3u.customTable.objects.push(unit);

    const archive = new MpqArchive();
    archive.resizeHashtable(8);
    archive.set('war3map.w3u', w3u.save().slice().buffer as ArrayBuffer);
    archive.set('war3mapImported\\Knight2.mdx', makeModel('Knight2', ['']).slice().buffer as ArrayBuffer);
    const v3Path = join(dir, 'v3source.w3x');
    writeFileSync(v3Path, archive.save()!);

    // The gate accepts it.
    const data = new MapData(v3Path);
    expect(data.categories.get('units')!.file.version).toBe(3);
    expect(data.categories.get('units')!.roundtrip.cosmetic).toBe(false);

    const result = port({ sourcePath: v3Path, targetPath, outDir: join(dir, 'drop-v3'), all: true });
    expect(result.objects).toHaveLength(1);

    const { version, files } = loadW3o(readFileSync(result.w3oPath));
    expect(version).toBe(1);
    const units = files.units!;
    expect(units.version).toBe(3);
    const ported = units.customTable.objects[0];
    expect(ported.sets).toHaveLength(2); // set structure preserved
    expect(ported.sets[1].flag).toBe(1);
    expect(ported.sets[1].modifications[0].value).toBe(1234);

    // The .mdl reference resolved to the actual .mdx and was rewritten.
    const umdl = ported.modifications.find((m) => m.id === 'umdl')!;
    expect(umdl.value).toBe('war3mapImported\\Knight2.mdx');
    expect(existsSync(join(result.outDir, 'war3mapImported/Knight2.mdx'))).toBe(true);
  });
});

describe('cross-parser validation', () => {
  it('v1/v2 files written by our serializer parse identically with the reference library parser', () => {
    const data = new MapData(sourcePath);
    for (const cat of data.categories.values()) {
      if (cat.file.version > 2 || cat.def.optionalInts) {
        continue;
      }
      const ours = cat.file.save();
      const lib = new War3MapW3o(); // container check happens elsewhere; here use the raw file parser
      void lib;
      const reference = new (require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/file').default)();
      reference.load(ours);
      expect(reference.version).toBe(cat.file.version);
      expect(reference.customTable.objects.length).toBe(cat.file.customTable.objects.length);
      const refFirst = reference.customTable.objects[0];
      const ourFirst = cat.file.customTable.objects[0];
      expect(refFirst.newId).toBe(ourFirst.newId);
      expect(refFirst.modifications.map((m: { id: string; value: unknown }) => [m.id, m.value])).toEqual(
        ourFirst.modifications.map((m) => [m.id, m.value]),
      );
    }
  });
});
