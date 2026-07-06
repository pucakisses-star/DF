/**
 * Human-readable report for every port run: what was imported, what was
 * renamed, what to click in the World Editor.
 */
import { categoryByKey } from './formats';
import type { PortResult } from './porter';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function buildReport(result: PortResult, sourceName: string, targetName?: string): string {
  const lines: string[] = [];
  lines.push(`# Import drop: ${sourceName}${targetName ? ` -> ${targetName}` : ''}`);
  lines.push('');
  lines.push(`- Objects ported: **${result.objects.length}**`);
  lines.push(`- Assets collected: **${result.assets.length}**`);
  lines.push(`- Field rewrites: **${result.rewrites.length}**`);
  lines.push('');

  lines.push('## How to apply (World Editor does all writes)');
  lines.push('');
  lines.push('1. **Back up your map/campaign file.** (The tool never writes to it, but the editor will.)');
  lines.push('2. Open the target in the World Editor.');
  if (result.assets.length > 0) {
    lines.push(
      '3. Open **Module -> Import Manager**, click **File -> Import Files...**, and multi-select everything inside the `war3mapImported/` folder of this drop. Leave the default paths untouched — every reference already points at `war3mapImported\\<file>`.',
    );
  } else {
    lines.push('3. (No assets to import.)');
  }
  lines.push('4. Open **Module -> Object Editor**, then **File -> Import Object Settings...** and pick `import.w3o` from this drop. Confirm merging.');
  lines.push('5. Save. Then verify a few of the imported objects listed below.');
  lines.push('');

  if (result.objects.length > 0) {
    lines.push('## Objects');
    lines.push('');
    lines.push('| Source | Category | Name | Source ID | Imported as | Based on | Pulled in by | Mods |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const obj of result.objects) {
      lines.push(
        `| ${escapeCell(obj.source)} | ${categoryByKey(obj.category).label} | ${escapeCell(obj.name ?? '')} | \`${escapeCell(obj.sourceId)}\` | ` +
          `${obj.remapped ? `\`${obj.newId}\` (remapped)` : `\`${obj.newId}\``} | \`${obj.baseId}\` | ` +
          `${obj.reason === 'requested' || obj.reason === 'created from folder' ? obj.reason : `\`${obj.reason}\``} | ${obj.modifications} |`,
      );
    }
    lines.push('');
  }

  if (result.assets.length > 0) {
    lines.push('## Assets');
    lines.push('');
    lines.push('| Source | Source path | Import path | Size | Patched |');
    lines.push('|---|---|---|---|---|');
    for (const asset of result.assets) {
      lines.push(
        `| ${escapeCell(asset.source)} | \`${escapeCell(asset.sourcePath)}\` | \`${escapeCell(asset.importPath)}\` | ${asset.bytes} B | ${asset.patched ? 'texture paths rewritten' : ''} |`,
      );
    }
    lines.push('');
  }

  if (result.rewrites.length > 0) {
    lines.push('## Field rewrites');
    lines.push('');
    lines.push('Every automatic edit to a field value, for review:');
    lines.push('');
    lines.push('| Source | Object | Field | Kind | From | To |');
    lines.push('|---|---|---|---|---|---|');
    for (const rw of result.rewrites) {
      lines.push(
        `| ${escapeCell(rw.source)} | \`${escapeCell(rw.objectId)}\` | \`${rw.field}\` | ${rw.kind} | \`${escapeCell(rw.from)}\` | \`${escapeCell(rw.to)}\` |`,
      );
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
