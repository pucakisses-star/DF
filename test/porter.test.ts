import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MdlxModel, MpqArchive, ObjectDataFile, PorterError, War3MapW3o } from '../src/formats';
import { loadW3o } from '../src/w3o';
import { MapData } from '../src/mapdata';
import { inspect } from '../src/inspect';
import { port } from '../src/porter';
import { makeModel, makeObject, writeSourceMap, writeTargetCampaign, writeTargetMap, writeW3oExportFolder } from './fixtures';
import { W3oData } from '../src/w3odata';
import { FolderData } from '../src/source';
import { prettifyName, suggestIcon, suggestName, suggestObjectFromModel } from '../src/folderobjects';

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

describe('malformed field ids', () => {
  it('drops modifications whose field id contains control bytes, with a warning', () => {
    const w3u = new ObjectDataFile(false);
    w3u.version = 2;
    const unit = makeObject('hfoo', 'h500', [
      { id: 'unam', type: 3, value: 'Corrupt Fields Unit' },
      { id: 'Crs\0', type: 2, value: 0.25 },
      { id: 'uhpm', type: 0, value: 750 },
    ]);
    w3u.customTable.objects.push(unit);

    const archive = new MpqArchive();
    archive.set('war3map.w3u', w3u.save().slice().buffer as ArrayBuffer);
    const path = join(dir, 'corrupt-field.w3x');
    writeFileSync(path, archive.save()!);

    // The roundtrip gate still accepts the source (the bytes are consistent) —
    // the junk is only removed from what WE ship to the editor.
    const result = port({ sourcePath: path, targetPath, outDir: join(dir, 'drop-corrupt'), all: true });
    expect(result.warnings.some((w) => w.includes('malformed field id'))).toBe(true);

    const { files } = loadW3o(readFileSync(result.w3oPath));
    const mods = files.units!.customTable.objects[0].modifications;
    expect(mods.map((m) => m.id).sort()).toEqual(['uhpm', 'unam']);
    expect(mods.find((m) => m.id === 'uhpm')!.value).toBe(750);
  });
});

describe('campaign targets', () => {
  it('re-paths assets with war3campImported for .w3n targets, migrating the manifest', () => {
    const campaignTarget = writeTargetCampaign(join(dir, 'camp'));
    const out = join(dir, 'drop-camp');

    // First run against a MAP target seeds war3mapImported paths in the manifest.
    const mapRun = port({ sourcePath, targetPath, outDir: out, ids: ['h000'] });
    expect(mapRun.importPrefix).toBe('war3mapImported\\');

    // Re-running the same drop against a CAMPAIGN target must migrate the
    // prefix — the campaign Import Manager defaults to war3campImported\.
    const result = port({ sourcePath, targetPath: campaignTarget, outDir: out, ids: ['h000'] });
    expect(result.importPrefix).toBe('war3campImported\\');
    expect(result.assets.map((a) => a.importPath).sort()).toEqual([
      'war3campImported\\CustomKnight.mdx',
      'war3campImported\\CustomKnight_portrait.mdx',
      'war3campImported\\Knight.blp',
    ]);

    // Object fields and MDX texture paths all use the campaign prefix.
    const w3o = new War3MapW3o();
    w3o.load(readFileSync(result.w3oPath));
    const mods = Object.fromEntries(w3o.units!.customTable.objects[0].modifications.map((m) => [m.id, m.value]));
    expect(mods['umdl']).toBe('war3campImported\\CustomKnight.mdx');
    const model = new MdlxModel();
    model.load(new Uint8Array(readFileSync(join(out, 'war3campImported/CustomKnight.mdx'))));
    expect(model.textures.map((t) => t.path)).toEqual(['war3campImported\\Knight.blp', '']);

    // The instructions name the right folder.
    expect(readFileSync(result.reportPath, 'utf8')).toContain('war3campImported');

    // Rawcode collision with the campaign's own h000 still detected.
    expect(result.objects.find((o) => o.sourceId === 'h000')!.remapped).toBe(true);
  });
});

describe('w3o object-export sources', () => {
  let exportPath: string;

  beforeAll(() => {
    exportPath = writeW3oExportFolder(join(dir, 'HiveBundle'));
  });

  it('loads and roundtrip-verifies an export, resolving assets from its folder', () => {
    const data = new W3oData(exportPath);
    expect(data.cosmetic).toBe(false); // fixture bytes come from the same serializer
    expect([...data.categories.keys()].sort()).toEqual(['abilities', 'units']);
    expect(data.customIds()).toEqual(new Set(['h000', 'A000']));
    expect(data.hasFile('CustomKnight.mdx')).toBe(true); // sibling file, not in the .w3o
    expect(data.hasFile('Knight.blp')).toBe(true);
  });

  it('inspects an export like a map', () => {
    const result = inspect(exportPath);
    expect(result.isObjectExport).toBe(true);
    expect(result.objects).toHaveLength(2);
    const h000 = result.objects.find((o) => o.id === 'h000')!;
    expect(h000.name).toBe('Exported Knight');
    expect(h000.modelPath).toBe('CustomKnight.mdl');
    expect(h000.refs.some((r) => r.field === 'uabi' && r.values.some((v) => v.id === 'A000' && v.custom))).toBe(true);
  });

  it('ports from an export with closure, remapping, and folder-resolved assets', () => {
    const result = port({
      sources: [{ kind: 'w3o', path: exportPath, all: true }],
      targetPath,
      outDir: join(dir, 'drop-w3o'),
    });

    // h000 collides with the target and gets remapped; A000 is free and kept.
    const unit = result.objects.find((o) => o.sourceId === 'h000')!;
    expect(unit.remapped).toBe(true);
    const ability = result.objects.find((o) => o.sourceId === 'A000')!;
    expect(ability.remapped).toBe(false);

    const { files } = loadW3o(readFileSync(result.w3oPath));
    expect(files.units!.version).toBe(2);
    const mods = Object.fromEntries(files.units!.customTable.objects[0].modifications.map((m) => [m.id, m.value]));
    // The .mdl reference resolved to the .mdx sitting next to the export.
    expect(mods['umdl']).toBe('war3mapImported\\CustomKnight.mdx');
    expect(mods['uabi']).toBe('A000');

    // Model collected from the folder, texture path patched.
    const model = new MdlxModel();
    model.load(new Uint8Array(readFileSync(join(result.outDir, 'war3mapImported/CustomKnight.mdx'))));
    expect(model.textures[0].path).toBe('war3mapImported\\Knight.blp');
    expect(existsSync(join(result.outDir, 'war3mapImported/Knight.blp'))).toBe(true);
  });

  it('rejects a damaged export instead of misreading it', () => {
    const bytes = readFileSync(exportPath);
    const broken = join(dir, 'broken.w3o');
    writeFileSync(broken, bytes.slice(0, bytes.byteLength - 5));
    expect(() => new W3oData(broken)).toThrow(PorterError);
    expect(() => new W3oData(broken)).toThrow(/failed to parse/);
  });

  it('refuses a .w3o as target', () => {
    expect(() =>
      port({ sources: [{ kind: 'w3o', path: exportPath, all: true }], targetPath: exportPath, outDir: join(dir, 'x') }),
    ).toThrow(/source, not a target/);
  });
});

describe('Reforged 1.33+ object data (format v3)', () => {
  it('parses a hand-assembled v3 byte layout exactly as documented', () => {
    // version=3; originalTable empty; customTable: 2 objects.
    // Object 1: EMPTY v3 int list (the case that used to misparse), 1 int mod.
    // Object 2: int list [7, 9], 1 string mod.
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
    view.setUint32(o, 2, true); o += 4;       // custom table count
    // object 1
    ascii(o, 'hfoo'); o += 4;                 // oldId
    ascii(o, 'h300'); o += 4;                 // newId
    view.setUint32(o, 0, true); o += 4;       // v3 int list: EMPTY
    view.setUint32(o, 1, true); o += 4;       // mod count
    ascii(o, 'uhpm'); o += 4;                 // mod id
    view.setInt32(o, 0, true); o += 4;        // variable type int
    view.setInt32(o, 777, true); o += 4;      // value
    view.setInt32(o, 0, true); o += 4;        // end token
    // object 2
    ascii(o, 'hkni'); o += 4;                 // oldId
    ascii(o, 'h301'); o += 4;                 // newId
    view.setUint32(o, 2, true); o += 4;       // v3 int list: 2 entries
    view.setInt32(o, 7, true); o += 4;
    view.setInt32(o, 9, true); o += 4;
    view.setUint32(o, 1, true); o += 4;       // mod count
    ascii(o, 'unam'); o += 4;                 // mod id
    view.setInt32(o, 3, true); o += 4;        // variable type string
    ascii(o, str); o += str.length + 1;       // null-terminated value
    view.setInt32(o, 0, true); o += 4;        // end token

    const data = bytes.slice(0, o);
    const file = new ObjectDataFile(false);
    file.load(data);
    expect(file.version).toBe(3);
    expect(file.customTable.objects).toHaveLength(2);
    const [first, second] = file.customTable.objects;
    expect(first.oldId).toBe('hfoo');
    expect(first.newId).toBe('h300');
    expect(first.unk).toEqual([]);
    expect(first.modifications[0].value).toBe(777);
    expect(second.newId).toBe('h301');
    expect(second.unk).toEqual([7, 9]);
    expect(second.modifications[0].value).toBe('Hi');
    // And it must roundtrip byte-exactly.
    expect(Buffer.compare(Buffer.from(file.save()), Buffer.from(data))).toBe(0);
  });

  it('reads a v3 map but emits a v2 drop the editor can import (dropping unk bookkeeping)', () => {
    const w3u = new ObjectDataFile(false);
    w3u.version = 3;
    const unit = makeObject('hfoo', 'h300', [
      { id: 'unam', type: 3, value: 'Sets Unit' },
      { id: 'umdl', type: 3, value: 'war3mapImported\\Knight2.mdl' }, // .mdl ref, .mdx file
    ]);
    // Real 1.33+ campaign files have an EMPTY v3 int list — the exact case
    // that previously drifted the parser into "unknown variable type" errors.
    expect(unit.unk).toEqual([]);
    const second = makeObject('hkni', 'h301', [{ id: 'unam', type: 3, value: 'After Empty' }]);
    second.unk = [0];
    w3u.customTable.objects.push(unit, second);

    const archive = new MpqArchive();
    archive.resizeHashtable(8);
    archive.set('war3map.w3u', w3u.save().slice().buffer as ArrayBuffer);
    archive.set('war3mapImported\\Knight2.mdx', makeModel('Knight2', ['']).slice().buffer as ArrayBuffer);
    const v3Path = join(dir, 'v3source.w3x');
    writeFileSync(v3Path, archive.save()!);

    // The gate accepts it byte-exactly.
    const data = new MapData(v3Path);
    expect(data.categories.get('units')!.file.version).toBe(3);
    expect(data.categories.get('units')!.roundtrip.cosmetic).toBe(false);

    const result = port({ sourcePath: v3Path, targetPath, outDir: join(dir, 'drop-v3'), all: true });
    expect(result.objects).toHaveLength(2);

    const { version, files } = loadW3o(readFileSync(result.w3oPath));
    expect(version).toBe(1); // container version
    const units = files.units!;
    // Emitted as v2 — the universally-importable format — NOT v3.
    expect(units.version).toBe(2);
    const ported = units.customTable.objects.find((obj) => obj.oldId === 'hfoo')!;
    expect(ported.unk).toEqual([]);
    const portedSecond = units.customTable.objects.find((obj) => obj.oldId === 'hkni')!;
    expect(portedSecond.unk).toEqual([]); // v3 bookkeeping dropped on downgrade
    // ...and the user is told the harmless bookkeeping was dropped.
    expect(result.warnings.some((w) => w.includes('v2 object format'))).toBe(true);

    // Every actual field modification survives the downgrade untouched.
    const umdl = ported.modifications.find((m) => m.id === 'umdl')!;
    expect(umdl.value).toBe('war3mapImported\\Knight2.mdx');
    expect(ported.modifications.find((m) => m.id === 'unam')!.value).toBe('Sets Unit');
    expect(portedSecond.modifications.find((m) => m.id === 'unam')!.value).toBe('After Empty');
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

describe('lone model files and auto-classification', () => {
  it('indexes only the top directory (asset types) in non-recursive mode', () => {
    const dir2 = join(dir, 'LooseModels');
    mkdirSync(join(dir2, 'sub'), { recursive: true });
    writeFileSync(join(dir2, 'Hero.mdx'), makeModel('Hero', ['hero.blp']));
    writeFileSync(join(dir2, 'hero.blp'), 'loose-texture');
    writeFileSync(join(dir2, 'unrelated.zip'), 'not-an-asset');
    writeFileSync(join(dir2, 'sub', 'nested.mdx'), makeModel('Nested', []));

    const flat = new FolderData(dir2, { recursive: false });
    expect(flat.files.sort()).toEqual(['Hero.mdx', 'hero.blp']);
    expect(flat.hasFile('hero.blp')).toBe(true);

    const deep = new FolderData(dir2);
    expect(deep.files.length).toBe(4);

    // Porting from the non-recursive source works end to end.
    const result = port({
      sources: [
        {
          kind: 'folder',
          path: dir2,
          recursive: false,
          objects: [{ category: 'units', name: 'Loose Hero', modelPath: 'Hero.mdx' }],
        },
      ],
      targetPath,
      outDir: join(dir, 'drop-loose'),
    });
    expect(result.objects).toHaveLength(1);
    expect(existsSync(join(result.outDir, 'war3mapImported/Hero.mdx'))).toBe(true);
    expect(existsSync(join(result.outDir, 'war3mapImported/hero.blp'))).toBe(true);
  });

  it('classifies models by their animation sequences', () => {
    const withSeqs = (names: string[]): Uint8Array => makeModel('T', [], names);

    expect(suggestObjectFromModel(withSeqs(['Stand', 'Walk', 'Attack - 1', 'Death'])).label).toBe('Melee unit');
    expect(suggestObjectFromModel(withSeqs(['Birth', 'Stand', 'Stand Work', 'Death'])).label).toBe('Building');
    expect(suggestObjectFromModel(withSeqs(['Stand', 'Death'])).label).toBe('Destructible');
    expect(suggestObjectFromModel(withSeqs(['Stand', 'Stand Hit'])).label).toBe('Doodad');

    expect(suggestIcon(['textures\\skin.blp', 'BTNHero.blp'])).toBe('BTNHero.blp');
    expect(suggestIcon(['a.tga'])).toBe('a.tga');
  });
});

describe('auto-naming', () => {
  it('prettifies model and file names', () => {
    expect(prettifyName('HeroVarokSaurfangGrey.mdl')).toBe('Hero Varok Saurfang Grey');
    expect(prettifyName('dwarf_rifleman_v2')).toBe('Dwarf Rifleman');
    expect(prettifyName('BTN-crystal.golem')).toBe('BTN Crystal Golem');
  });

  it('prefers the internal model name over the file stem', () => {
    expect(suggestName('VarokSaurfang', 'model123.mdx')).toBe('Varok Saurfang');
    expect(suggestName(undefined, 'FrostWyrm.mdx')).toBe('Frost Wyrm');
    expect(suggestName('', 'a.mdx')).toBe('A');
  });
});

describe('flying/ranged refinement', () => {
  const walker = ['Stand', 'Walk', 'Attack', 'Death'];

  it('detects flying units by name keywords', () => {
    const s = suggestObjectFromModel(makeModel('FrostWyrm', [], walker), 'FrostWyrm.mdx');
    expect(s.label).toBe('Flying unit');
    expect(s.baseId).toBe('hgry');
  });

  it('detects flying units by geometry floating above the ground', () => {
    const bytes = makeModel('Mystery', [], walker, 60);
    const s = suggestObjectFromModel(bytes, 'Mystery.mdx');
    expect(s.label).toBe('Flying unit');
  });

  it('detects ranged units by name keywords', () => {
    const s = suggestObjectFromModel(makeModel('DwarfRifleman', [], walker), 'DwarfRifleman.mdx');
    expect(s.label).toBe('Ranged unit');
    expect(s.baseId).toBe('hrif');
  });

  it('defaults to melee for plain walkers', () => {
    const s = suggestObjectFromModel(makeModel('Swordsman', [], walker), 'Swordsman.mdx');
    expect(s.label).toBe('Melee unit');
    expect(s.baseId).toBe('hfoo');
  });
});
