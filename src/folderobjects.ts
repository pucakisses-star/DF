/**
 * Synthesizing brand-new custom objects from a plain asset folder (e.g. an
 * unzipped Hive Workshop model download): pick a model, pick a base object,
 * get a ready-to-import unit/item/doodad/destructible using that model.
 */
import { CategoryKey, Modification, ModifiedObject, PorterError } from './formats';
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
export function synthesizeObject(spec: FolderObjectSpec, newId: string): ModifiedObject {
  const fields = FIELDS[spec.category];
  const baseId = spec.baseId ?? fields.base;
  if (!isRawcode(baseId)) {
    throw new PorterError(`'${baseId}' is not a valid base rawcode.`);
  }

  const obj = new ModifiedObject();
  obj.oldId = baseId;
  obj.newId = newId;
  obj.modifications.push(stringMod(fields.nameField, spec.name));
  obj.modifications.push(stringMod(fields.modelField, spec.modelPath));
  if (spec.iconPath && fields.iconField) {
    obj.modifications.push(stringMod(fields.iconField, spec.iconPath));
  }
  return obj;
}
