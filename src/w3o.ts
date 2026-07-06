/**
 * war3map.w3o container: the combined object-data file the Object Editor
 * exports and imports. Layout: int32 version, then for each of the seven
 * categories in fixed order an int32 presence flag followed (when set) by an
 * embedded object-data file.
 */
import BinaryStream from 'mdx-m3-viewer/dist/cjs/common/binarystream';
import { CATEGORIES, CategoryKey } from './formats';
import { ObjectDataFile } from './objectdata';

export type W3oFiles = Partial<Record<CategoryKey, ObjectDataFile>>;

/** The w3o category order matches the CATEGORIES declaration order. */
const ORDER: readonly CategoryKey[] = CATEGORIES.map((c) => c.key);

export const W3O_VERSION = 1;

export function saveW3o(files: W3oFiles): Uint8Array {
  let size = 4;
  for (const key of ORDER) {
    size += 4;
    const file = files[key];
    if (file) {
      size += file.getByteLength();
    }
  }
  const stream = new BinaryStream(new ArrayBuffer(size));
  stream.writeInt32(W3O_VERSION);
  for (const key of ORDER) {
    const file = files[key];
    if (file) {
      stream.writeInt32(1);
      file.saveTo(stream);
    } else {
      stream.writeInt32(0);
    }
  }
  return stream.uint8array;
}

export function loadW3o(bytes: Uint8Array): { version: number; files: W3oFiles } {
  const stream = new BinaryStream(bytes);
  const version = stream.readInt32();
  const files: W3oFiles = {};
  for (const def of CATEGORIES) {
    if (stream.readInt32()) {
      const file = new ObjectDataFile(def.optionalInts);
      file.load(stream);
      files[def.key] = file;
    }
  }
  return { version, files };
}
