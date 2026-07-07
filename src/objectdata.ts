/**
 * Object-data file serializer (war3map.w3u/w3t/w3b/w3h/w3d/w3a/w3q and the
 * embedded blocks of war3map.w3o).
 *
 * This is the ONE place this project serializes a Warcraft III binary format
 * itself, and only because the underlying library stops at format version 2:
 * Reforged 1.33+ writes version 3. Two guards keep this safe:
 *
 *   1. Individual modifications still load/save through the library's
 *      Modification class (value typing is where corruption bugs live).
 *   2. Every file read at runtime must pass the roundtrip gate in safety.ts —
 *      a misunderstanding of the framing aborts the run, it never ships bytes.
 *
 * Version 1/2 object framing:  oldId newId modCount mods[]
 * Version 3 object framing:    oldId newId unkCount unk[] modCount mods[]
 *
 * The v3 int list is undocumented (usually empty, sometimes a single 0); it is
 * preserved verbatim. This layout matches War3Net's reference implementation —
 * note it is NOT a list of (flag, mods) sets: files where the list is empty
 * would misparse under that interpretation.
 */
import BinaryStream from 'mdx-m3-viewer/dist/cjs/common/binarystream';
import Modification from 'mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/modification';

export { Modification };

export class W3Object {
  oldId = '\0\0\0\0';
  newId = '\0\0\0\0';
  /** v3-only undocumented int list, preserved verbatim (empty on v1/v2). */
  unk: number[] = [];
  modifications: Modification[] = [];

  load(stream: BinaryStream, version: number, optionalInts: boolean): void {
    this.oldId = stream.readBinary(4);
    this.newId = stream.readBinary(4);
    this.unk = [];
    if (version >= 3) {
      const unkCount = stream.readUint32();
      if (unkCount > 100000) {
        throw new Error(`implausible v3 int-list count ${unkCount}`);
      }
      for (let i = 0; i < unkCount; i++) {
        this.unk.push(stream.readInt32());
      }
    }
    const modCount = stream.readUint32();
    if (modCount > 1000000) {
      throw new Error(`implausible modification count ${modCount}`);
    }
    this.modifications = [];
    for (let m = 0; m < modCount; m++) {
      const mod = new Modification();
      mod.load(stream, optionalInts);
      this.modifications.push(mod);
    }
  }

  save(stream: BinaryStream, version: number, optionalInts: boolean): void {
    stream.writeBinary(this.oldId);
    stream.writeBinary(this.newId);
    if (version >= 3) {
      stream.writeUint32(this.unk.length);
      for (const value of this.unk) {
        stream.writeInt32(value);
      }
    }
    stream.writeUint32(this.modifications.length);
    for (const mod of this.modifications) {
      mod.save(stream, optionalInts);
    }
  }

  getByteLength(version: number, optionalInts: boolean): number {
    let size = 8 + 4;
    if (version >= 3) {
      size += 4 + this.unk.length * 4;
    }
    for (const mod of this.modifications) {
      size += mod.getByteLength(optionalInts);
    }
    return size;
  }
}

export interface ObjectTable {
  objects: W3Object[];
}

export const MIN_FORMAT_VERSION = 1;
export const MAX_FORMAT_VERSION = 3;

/** Little-endian peek of the leading version int, without parsing anything. */
export function peekFormatVersion(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 4) {
    return null;
  }
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) | 0;
}

export class ObjectDataFile {
  version = 2;
  originalTable: ObjectTable = { objects: [] };
  customTable: ObjectTable = { objects: [] };

  constructor(readonly optionalInts: boolean) {}

  private loadTable(stream: BinaryStream, table: ObjectTable): void {
    const count = stream.readUint32();
    if (count > 1000000) {
      throw new Error(`implausible object count ${count}`);
    }
    for (let i = 0; i < count; i++) {
      const obj = new W3Object();
      obj.load(stream, this.version, this.optionalInts);
      table.objects.push(obj);
    }
  }

  private saveTable(stream: BinaryStream, table: ObjectTable): void {
    stream.writeUint32(table.objects.length);
    for (const obj of table.objects) {
      obj.save(stream, this.version, this.optionalInts);
    }
  }

  /** Load from bytes, or from a stream (for the embedded blocks of a .w3o). */
  load(bufferOrStream: Uint8Array | BinaryStream): void {
    const stream = bufferOrStream instanceof BinaryStream ? bufferOrStream : new BinaryStream(bufferOrStream);
    this.version = stream.readInt32();
    if (this.version < MIN_FORMAT_VERSION || this.version > MAX_FORMAT_VERSION) {
      throw new Error(`unsupported object data format version ${this.version}`);
    }
    this.originalTable = { objects: [] };
    this.customTable = { objects: [] };
    this.loadTable(stream, this.originalTable);
    this.loadTable(stream, this.customTable);
  }

  saveTo(stream: BinaryStream): void {
    stream.writeInt32(this.version);
    this.saveTable(stream, this.originalTable);
    this.saveTable(stream, this.customTable);
  }

  save(): Uint8Array {
    const stream = new BinaryStream(new ArrayBuffer(this.getByteLength()));
    this.saveTo(stream);
    return stream.uint8array;
  }

  getByteLength(): number {
    let size = 4 + 4 + 4;
    for (const obj of this.originalTable.objects) {
      size += obj.getByteLength(this.version, this.optionalInts);
    }
    for (const obj of this.customTable.objects) {
      size += obj.getByteLength(this.version, this.optionalInts);
    }
    return size;
  }
}
