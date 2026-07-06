/**
 * Read-only inspection of a map's custom object data.
 */
import { CATEGORIES, CategoryKey } from './formats';
import { isRawcodeList } from './ids';
import { MapData } from './mapdata';

/** Friendly labels for well-known rawcode-list fields. */
const REF_FIELD_LABELS: Record<string, string> = {
  uabi: 'Abilities',
  uhab: 'Hero abilities',
  utra: 'Trains',
  ubui: 'Builds',
  uupt: 'Upgrades to',
  usei: 'Sells items',
  useu: 'Sells units',
  umki: 'Makes items',
  ures: 'Researches',
  ureq: 'Requires',
  udaa: 'Default active ability',
  abuf: 'Buffs',
  areq: 'Requires',
  greq: 'Requires',
  ipab: 'Item ability',
};

export interface ObjectReference {
  id: string;
  /** Resolved display name when the reference points at a custom object of this map. */
  name?: string;
  /** True when the reference is a custom object (as opposed to a stock one). */
  custom: boolean;
}

export interface ObjectRefField {
  field: string;
  label: string;
  values: ObjectReference[];
}

export interface InspectedObject {
  category: CategoryKey;
  id: string;
  baseId: string;
  name?: string;
  modifications: number;
  /** Custom model path, when one of the object's fields sets a model. */
  modelPath?: string;
  /** Custom icon path, when one of the object's fields sets an image. */
  iconPath?: string;
  /** Rawcode-list fields: abilities, trained units, upgrades, buffs, ... */
  refs: ObjectRefField[];
}

export interface InspectResult {
  name: string;
  isCampaign: boolean;
  objects: InspectedObject[];
  standardMods: number;
  importCount: number;
  warnings: string[];
}

export function inspect(path: string): InspectResult {
  const source = new MapData(path);
  const objects: InspectedObject[] = [];
  let standardMods = 0;

  // First pass: names of every custom object, for resolving references.
  const customNames = new Map<string, string>();
  for (const cat of source.categories.values()) {
    for (const obj of cat.file.customTable.objects) {
      for (const mod of obj.modifications) {
        if (mod.variableType === 3 && typeof mod.value === 'string' && /^.nam$/.test(mod.id)) {
          customNames.set(obj.newId, source.resolveTrigStr(mod.value) ?? mod.value);
          break;
        }
      }
      if (!customNames.has(obj.newId)) {
        customNames.set(obj.newId, '');
      }
    }
  }

  for (const def of CATEGORIES) {
    const cat = source.categories.get(def.key);
    if (!cat) {
      continue;
    }
    standardMods += cat.file.originalTable.objects.length;
    for (const obj of cat.file.customTable.objects) {
      let name: string | undefined;
      let modelPath: string | undefined;
      let iconPath: string | undefined;
      const refs: ObjectRefField[] = [];
      for (const mod of obj.modifications) {
        if (mod.variableType !== 3 || typeof mod.value !== 'string') {
          continue;
        }
        const value = mod.value.trim();
        if (name === undefined && /^.nam$/.test(mod.id)) {
          name = source.resolveTrigStr(value) ?? value;
        }
        if (modelPath === undefined && /\.(mdx|mdl)$/i.test(value)) {
          modelPath = value;
        }
        if (iconPath === undefined && /\.(blp|dds|tga)$/i.test(value)) {
          iconPath = value;
        }
        // Reference fields: known field ids, or lists naming custom objects.
        if (isRawcodeList(value)) {
          const tokens = value.split(',');
          const known = mod.id in REF_FIELD_LABELS;
          const touchesCustom = tokens.some((t) => customNames.has(t));
          if ((known || touchesCustom) && !refs.some((r) => r.field === mod.id)) {
            refs.push({
              field: mod.id,
              label: REF_FIELD_LABELS[mod.id] ?? `Field '${mod.id}'`,
              values: tokens.map((t) => ({
                id: t,
                name: customNames.get(t) || undefined,
                custom: customNames.has(t),
              })),
            });
          }
        }
      }
      objects.push({
        category: def.key,
        id: obj.newId,
        baseId: obj.oldId,
        name,
        modifications: obj.modifications.length,
        modelPath,
        iconPath,
        refs,
      });
    }
  }

  return {
    name: source.name,
    isCampaign: source.isCampaign,
    objects,
    standardMods,
    importCount: source.map.getImportNames().length,
    warnings: source.warnings,
  };
}
