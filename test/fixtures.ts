/**
 * Builds small but realistic source/target maps fully in memory, using the
 * same library the tool itself uses for parsing (but never for map writes in
 * production — writing here is only to create test fixtures).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import Texture from 'mdx-m3-viewer/dist/cjs/parsers/mdlx/texture';
import { MdlxModel, Modification, MpqArchive, ObjectDataFile, W3Object } from '../src/formats';

export function makeObject(
  oldId: string,
  newId: string,
  mods: Array<{
    id: string;
    type: number;
    value: number | string;
    level?: number;
    pointer?: number;
  }>,
): W3Object {
  const obj = new W3Object();
  obj.oldId = oldId;
  obj.newId = newId;
  for (const def of mods) {
    const mod = new Modification();
    mod.id = def.id;
    mod.variableType = def.type;
    mod.value = def.value;
    mod.levelOrVariation = def.level ?? 0;
    mod.dataPointer = def.pointer ?? 0;
    obj.sets[0].modifications.push(mod);
  }
  return obj;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function makeModel(name: string, texturePaths: string[]): Uint8Array {
  const model = new MdlxModel();
  model.version = 800;
  model.name = name;
  for (const path of texturePaths) {
    const texture = new Texture();
    texture.path = path;
    model.textures.push(texture);
  }
  return model.saveMdx();
}

export interface SourceFixture {
  path: string;
  modelBytes: Uint8Array;
}

/**
 * Source map contents:
 *   unit h000 (base hfoo): name TRIGSTR_1, model war3mapImported\CustomKnight.mdx,
 *                          abilities "A000,AHbz", sold item I000, 500 hp (int mod)
 *   unit h001 (base hkni): independent, must NOT come along when only h000 is ported
 *   ability A000 (base AHbz): buff "B000" on level 1 and 2 (tests optional ints)
 *   buff B000 (base BPSE)
 *   item I000 (base ratc)
 *   imports: CustomKnight.mdx (+ _portrait) referencing Textures\Knight.blp
 */
export function writeSourceMap(dir: string): SourceFixture {
  const w3u = new ObjectDataFile(false);
  w3u.version = 2;
  w3u.customTable.objects.push(
    makeObject('hfoo', 'h000', [
      { id: 'unam', type: 3, value: 'TRIGSTR_1' },
      { id: 'umdl', type: 3, value: 'war3mapImported\\CustomKnight.mdx' },
      { id: 'uabi', type: 3, value: 'A000,AHbz' },
      { id: 'usei', type: 3, value: 'I000' },
      { id: 'uhpm', type: 0, value: 500 },
    ]),
    makeObject('hkni', 'h001', [{ id: 'unam', type: 3, value: 'Lone Knight' }]),
  );
  // The source also tweaks a standard unit; ported only with --include-standard-mods.
  w3u.originalTable.objects.push(
    makeObject('hpea', '\0\0\0\0', [{ id: 'uhpm', type: 0, value: 999 }]),
  );

  const w3a = new ObjectDataFile(true);
  w3a.version = 2;
  w3a.customTable.objects.push(
    makeObject('AHbz', 'A000', [
      { id: 'anam', type: 3, value: 'Custom Blizzard' },
      { id: 'abuf', type: 3, value: 'B000', level: 1, pointer: 0 },
      { id: 'abuf', type: 3, value: 'B000', level: 2, pointer: 0 },
      { id: 'ahdu', type: 2, value: 5, level: 1 },
    ]),
  );

  const w3h = new ObjectDataFile(false);
  w3h.version = 1;
  w3h.customTable.objects.push(
    makeObject('BPSE', 'B000', [{ id: 'fnam', type: 3, value: 'Custom Stun' }]),
  );

  const w3t = new ObjectDataFile(false);
  w3t.version = 2;
  w3t.customTable.objects.push(
    makeObject('ratc', 'I000', [{ id: 'unam', type: 3, value: 'Claws of Porting' }]),
  );

  const modelBytes = makeModel('CustomKnight', ['Textures\\Knight.blp', '']);
  const portraitBytes = makeModel('CustomKnightPortrait', ['Textures\\Knight.blp']);

  const archive = new MpqArchive();
  archive.resizeHashtable(16); // default is 4 slots; set() fails silently past that
  archive.set('war3map.w3u', toArrayBuffer(w3u.save()));
  archive.set('war3map.w3a', toArrayBuffer(w3a.save()));
  archive.set('war3map.w3h', toArrayBuffer(w3h.save()));
  archive.set('war3map.w3t', toArrayBuffer(w3t.save()));
  archive.set('war3map.wts', 'STRING 1\n{\nDwarf Rifleman\n}\n');
  archive.set('war3mapImported\\CustomKnight.mdx', toArrayBuffer(modelBytes));
  archive.set('war3mapImported\\CustomKnight_portrait.mdx', toArrayBuffer(portraitBytes));
  archive.set('Textures\\Knight.blp', toArrayBuffer(new TextEncoder().encode('fake-blp-bytes')));

  const bytes = archive.save();
  if (!bytes) {
    throw new Error('fixture archive save failed');
  }

  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'source.w3x');
  writeFileSync(path, bytes);
  return { path, modelBytes };
}

/** Target map that already owns rawcodes h000 and h001. */
export function writeTargetMap(dir: string): string {
  const w3u = new ObjectDataFile(false);
  w3u.version = 2;
  w3u.customTable.objects.push(
    makeObject('hpea', 'h000', [{ id: 'unam', type: 3, value: 'Existing Worker' }]),
    makeObject('hrif', 'h001', [{ id: 'unam', type: 3, value: 'Existing Rifleman' }]),
  );

  const archive = new MpqArchive();
  archive.set('war3map.w3u', toArrayBuffer(w3u.save()));

  const bytes = archive.save();
  if (!bytes) {
    throw new Error('fixture archive save failed');
  }

  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'target.w3x');
  writeFileSync(path, bytes);
  return path;
}
