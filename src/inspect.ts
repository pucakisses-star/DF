/**
 * Read-only inspection of a map's custom object data.
 */
import { CATEGORIES, CategoryKey } from './formats';
import { MapData } from './mapdata';

export interface InspectedObject {
  category: CategoryKey;
  id: string;
  baseId: string;
  name?: string;
  modifications: number;
  /** Custom model path, when one of the object's fields sets a model. */
  modelPath?: string;
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

  for (const def of CATEGORIES) {
    const cat = source.categories.get(def.key);
    if (!cat) {
      continue;
    }
    standardMods += cat.file.originalTable.objects.length;
    for (const obj of cat.file.customTable.objects) {
      let name: string | undefined;
      let modelPath: string | undefined;
      for (const mod of obj.modifications) {
        if (mod.variableType !== 3 || typeof mod.value !== 'string') {
          continue;
        }
        if (name === undefined && /^.nam$/.test(mod.id)) {
          name = source.resolveTrigStr(mod.value) ?? mod.value;
        }
        if (modelPath === undefined && /\.(mdx|mdl)$/i.test(mod.value.trim())) {
          modelPath = mod.value.trim();
        }
      }
      objects.push({
        category: def.key,
        id: obj.newId,
        baseId: obj.oldId,
        name,
        modifications: obj.modifications.length,
        modelPath,
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
