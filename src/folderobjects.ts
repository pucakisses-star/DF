/**
 * Synthesizing brand-new custom objects from a plain asset folder (e.g. an
 * unzipped Hive Workshop model download): pick a model, pick a base object,
 * get a ready-to-import unit/item/doodad/destructible using that model.
 */
import { CategoryKey, MdlxModel, Modification, PorterError, W3Object } from './formats';
import { isRawcode } from './ids';

export interface FolderObjectSpec {
  /** Which kind of object to create. */
  category: Extract<CategoryKey, 'units' | 'items' | 'doodads' | 'destructables'>;
  /** Display name, e.g. the folder name. */
  name: string;
  /** Model file inside the folder (relative path). */
  modelPath: string;
  /** Optional icon file inside the folder. */
  iconPath?: string;
  /**
   * Standard object to base the new object on. Defaults per category are
   * deliberately common objects so every field has sane values.
   */
  baseId?: string;
  /** Preferred rawcode; auto-allocated when omitted or colliding. */
  preferredId?: string;
}

interface CategoryFields {
  base: string;
  nameField: string;
  modelField: string;
  iconField?: string;
  idPrefix: string;
}

/**
 * Field rawcodes per category. name/model/icon are the fields the World
 * Editor itself writes for these categories.
 */
const FIELDS: Record<FolderObjectSpec['category'], CategoryFields> = {
  units: { base: 'hfoo', nameField: 'unam', modelField: 'umdl', iconField: 'uico', idPrefix: 'h' },
  items: { base: 'ratc', nameField: 'unam', modelField: 'ifil', iconField: 'iico', idPrefix: 'I' },
  doodads: { base: 'LOba', nameField: 'dnam', modelField: 'dfil', idPrefix: 'D' },
  destructables: { base: 'LTlt', nameField: 'bnam', modelField: 'bfil', idPrefix: 'B' },
};

export interface ObjectSuggestion {
  category: FolderObjectSpec['category'];
  baseId: string;
  label: string;
  reason: string;
  /** The model's internal name (MODL chunk), when present. */
  modelName?: string;
}

/**
 * Turn a model/file name into a readable display name:
 * "HeroVarokSaurfangGrey.mdl" -> "Hero Varok Saurfang Grey",
 * "dwarf_rifleman_v2" -> "Dwarf Rifleman".
 */
export function prettifyName(raw: string): string {
  let s = raw.replace(/\.(mdx|mdl)$/i, '');
  s = s.replace(/[_\-.]+/g, ' ');
  // Split camelCase and letter/digit boundaries.
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
  // Drop standalone version tokens (v2, V1.3) and lone digits.
  s = s
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^[vV]?\d*(\.\d+)*$/.test(w))
    .map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return s.trim();
}

/** Best display name for a new object: internal model name, else the file stem. */
export function suggestName(modelName: string | undefined, modelPath: string): string {
  const stem = modelPath.replace(/\//g, '\\').split('\\').pop() ?? modelPath;
  const source = modelName && modelName.trim().length > 2 && !/^(model|unnamed|untitled)$/i.test(modelName.trim())
    ? modelName.trim()
    : stem;
  const pretty = prettifyName(source);
  return pretty.length > 0 ? pretty : stem.replace(/\.(mdx|mdl)$/i, '');
}

/**
 * Guess what kind of object a model is meant for, from its animation
 * sequences: units walk, buildings are born/upgraded/work, destructibles die,
 * doodads mostly just stand there.
 */
export function suggestObjectFromModel(modelBytes: Uint8Array): ObjectSuggestion {
  let sequences: string[] = [];
  let modelName: string | undefined;
  try {
    const model = new MdlxModel();
    const isMdx =
      modelBytes.byteLength > 4 &&
      modelBytes[0] === 0x4d && modelBytes[1] === 0x44 && modelBytes[2] === 0x4c && modelBytes[3] === 0x58;
    model.load(isMdx ? modelBytes : new TextDecoder().decode(modelBytes));
    sequences = model.sequences.map((s) => s.name.toLowerCase());
    modelName = model.name || undefined;
  } catch {
    // Unparseable model: fall through to the unit default.
  }
  const has = (word: string): boolean => sequences.some((n) => n.includes(word));

  if (has('walk')) {
    return { category: 'units', baseId: 'hfoo', label: 'Unit', reason: 'the model has Walk animations', modelName };
  }
  if (has('birth') || has('upgrade') || has('work')) {
    return { category: 'units', baseId: 'hhou', label: 'Building', reason: 'the model has Birth/Work/Upgrade animations', modelName };
  }
  if (has('death') || has('decay')) {
    return {
      category: 'destructables',
      baseId: 'LTlt',
      label: 'Destructible',
      reason: 'the model has Death animations but never walks',
      modelName,
    };
  }
  if (sequences.length > 0) {
    return { category: 'doodads', baseId: 'LOba', label: 'Doodad', reason: 'the model only has Stand-style animations', modelName };
  }
  return { category: 'units', baseId: 'hfoo', label: 'Unit', reason: 'could not read the model animations; defaulting', modelName };
}

/** Prefer command-button style icons (BTN*) over plain textures. */
export function suggestIcon(icons: string[]): string | undefined {
  const baseName = (p: string): string => p.slice(p.replace(/\//g, '\\').lastIndexOf('\\') + 1).toLowerCase();
  return icons.find((i) => baseName(i).startsWith('btn')) ?? icons.find((i) => /\.(blp|dds)$/i.test(i)) ?? icons[0];
}

export function folderObjectDefaults(
  category: FolderObjectSpec['category'],
): { baseId: string; idPrefix: string } {
  const fields = FIELDS[category];
  return { baseId: fields.base, idPrefix: fields.idPrefix };
}

function stringMod(id: string, value: string): Modification {
  const mod = new Modification();
  mod.id = id;
  mod.variableType = 3;
  mod.value = value;
  return mod;
}

/**
 * Build the custom object for a folder spec. `newId` must already be
 * allocated by the caller; the model/icon paths are stored as they appear in
 * the folder and are rewritten by the normal asset pipeline.
 */
export function synthesizeObject(spec: FolderObjectSpec, newId: string): W3Object {
  const fields = FIELDS[spec.category];
  const baseId = spec.baseId ?? fields.base;
  if (!isRawcode(baseId)) {
    throw new PorterError(`'${baseId}' is not a valid base rawcode.`);
  }

  const obj = new W3Object();
  obj.oldId = baseId;
  obj.newId = newId;
  obj.modifications.push(stringMod(fields.nameField, spec.name));
  obj.modifications.push(stringMod(fields.modelField, spec.modelPath));
  if (spec.iconPath && fields.iconField) {
    obj.modifications.push(stringMod(fields.iconField, spec.iconPath));
  }
  return obj;
}
