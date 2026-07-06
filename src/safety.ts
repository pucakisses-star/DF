/**
 * The roundtrip gate: before the tool trusts its own reading of any object
 * data file, it must be able to re-serialize that file and get either the
 * exact same bytes or a byte-different but structurally identical encoding.
 *
 * If a file fails this gate the run aborts. This is what prevents the class
 * of bug where a partially-understood format gets rewritten as garbage.
 */
import { CategoryDef, ObjectFile, PorterError, parseObjectFile } from './formats';
import { MAX_FORMAT_VERSION, W3Object, peekFormatVersion } from './objectdata';

export interface RoundtripResult {
  ok: boolean;
  /** True when bytes differed but the parsed structure matched (cosmetic re-encode). */
  cosmetic: boolean;
  message?: string;
}

/** Highest object-data format version this tool understands (3 = Reforged 1.33+). */
export const MAX_SUPPORTED_VERSION = MAX_FORMAT_VERSION;

interface PlainModification {
  id: string;
  variableType: number;
  levelOrVariation: number;
  dataPointer: number;
  value: number | string;
  u1: number;
}

interface PlainSet {
  flag: number;
  modifications: PlainModification[];
}

interface PlainObject {
  oldId: string;
  newId: string;
  sets: PlainSet[];
}

export interface PlainObjectFile {
  version: number;
  originalTable: PlainObject[];
  customTable: PlainObject[];
}

export function toPlain(file: ObjectFile): PlainObjectFile {
  const mapObject = (o: W3Object): PlainObject => ({
    oldId: o.oldId,
    newId: o.newId,
    sets: o.sets.map((set) => ({
      flag: set.flag,
      modifications: set.modifications.map((m) => ({
        id: m.id,
        variableType: m.variableType,
        levelOrVariation: m.levelOrVariation,
        dataPointer: m.dataPointer,
        value: m.value,
        u1: m.u1,
      })),
    })),
  });

  return {
    version: file.version,
    originalTable: file.originalTable.objects.map(mapObject),
    customTable: file.customTable.objects.map(mapObject),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Parse `bytes` as `def`'s format and verify the parse survives a roundtrip.
 * Returns the parsed file; throws PorterError when the file cannot be safely
 * understood.
 */
export function parseVerified(
  def: CategoryDef,
  bytes: Uint8Array,
  fileName: string,
): { file: ObjectFile; roundtrip: RoundtripResult } {
  // Check the version up front so unsupported future formats produce a clear
  // message instead of a confusing parse error from misaligned reads.
  const version = peekFormatVersion(bytes);
  if (version !== null && (version < 1 || version > MAX_SUPPORTED_VERSION)) {
    throw new PorterError(
      `${fileName}: object data format version ${version} is not supported ` +
        `(this tool supports versions 1-${MAX_SUPPORTED_VERSION}, i.e. up to and including Reforged 1.33+). Aborting.`,
    );
  }

  let file: ObjectFile;
  try {
    file = parseObjectFile(def, bytes);
  } catch (e) {
    throw new PorterError(
      `${fileName}: failed to parse (${(e as Error).message}). ` +
        `The file may use a newer format than this tool supports, or may already be damaged. Aborting without touching anything.`,
    );
  }

  let resaved: Uint8Array;
  try {
    resaved = file.save();
  } catch (e) {
    throw new PorterError(`${fileName}: re-serialization failed (${(e as Error).message}). Aborting.`);
  }

  if (bytesEqual(bytes, resaved)) {
    return { file, roundtrip: { ok: true, cosmetic: false } };
  }

  // Bytes differ; accept only if a re-parse yields the identical structure.
  let reparsed: ObjectFile;
  try {
    reparsed = parseObjectFile(def, resaved);
  } catch (e) {
    throw new PorterError(
      `${fileName}: roundtrip verification failed — re-encoded bytes do not parse (${(e as Error).message}). Aborting.`,
    );
  }

  const before = JSON.stringify(toPlain(file));
  const after = JSON.stringify(toPlain(reparsed));
  if (before !== after) {
    throw new PorterError(
      `${fileName}: roundtrip verification failed — parsing and re-serializing this file does not preserve its contents. ` +
        `Refusing to continue, because the tool clearly does not fully understand this file.`,
    );
  }

  return {
    file,
    roundtrip: {
      ok: true,
      cosmetic: true,
      message: `${fileName}: re-encodes byte-differently but structurally identically (cosmetic; safe).`,
    },
  };
}
