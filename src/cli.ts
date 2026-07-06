#!/usr/bin/env node
/**
 * wc3-porter — port Warcraft III custom objects between maps without ever
 * writing into a map file.
 *
 *   wc3-porter inspect <map>
 *   wc3-porter verify <map>
 *   wc3-porter port --source <map> --target <map> --out <dir> (--ids h000,A000 | --all) [--include-standard-mods] [--manifest <file>]
 */
import { parseArgs } from 'util';
import { CATEGORIES, PorterError, categoryByKey } from './formats';
import { MapData } from './mapdata';
import { inspect } from './inspect';
import { port } from './porter';

const USAGE = `wc3-porter — safe Warcraft III custom object importer

Commands:
  inspect <map>   List custom objects, standard-object edits and imports in a map/campaign.
  verify <map>    Run the roundtrip verification gate on all object data files.
  port            Build an import drop (.w3o + assets + report) from a source map.

Port options:
  --source, -s <map>        Source map/campaign to take objects from (repeatable)
  --target, -t <map>        Target map/campaign (enables collision-safe rawcode remapping)
  --out,    -o <dir>        Output directory for the drop (required)
  --ids <a,b,c>             Rawcodes to port (single source only; dependencies come along automatically)
  --all                     Port every custom object in the source(s)
  --include-standard-mods   Also port the sources' edits to standard objects
  --manifest <file>         ID/asset mapping file (default: <out>/port-manifest.json)

The tool NEVER writes into a map or campaign file. It emits a drop that you
apply with the World Editor's own Import Manager and Object Editor importers.`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function main(): void {
  const [, , command, ...rest] = process.argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    // Double-clicking wc3-porter.exe opens a console that would close
    // instantly; hold it open so the usage text is actually readable.
    if (!command && process.platform === 'win32' && process.stdout.isTTY) {
      console.log('\nThis is a command-line tool: open a Command Prompt in this folder and run, e.g.');
      console.log('  wc3-porter.exe inspect MyMap.w3x');
      const readline = require('readline') as typeof import('readline');
      readline
        .createInterface({ input: process.stdin, output: process.stdout })
        .question('\nPress Enter to close...', () => process.exit(0));
    }
    return;
  }

  if (command === 'inspect') {
    const [path] = rest;
    if (!path) {
      fail('usage: wc3-porter inspect <map>');
    }
    const result = inspect(path);
    console.log(`${result.name}${result.isCampaign ? ' (campaign)' : ''}`);
    console.log(`  custom objects: ${result.objects.length}`);
    console.log(`  standard-object edits: ${result.standardMods}`);
    console.log(`  imported files: ${result.importCount}`);
    for (const def of CATEGORIES) {
      const objs = result.objects.filter((o) => o.category === def.key);
      if (objs.length === 0) {
        continue;
      }
      console.log(`\n  ${def.label}:`);
      for (const obj of objs) {
        console.log(`    ${obj.id}  (base ${obj.baseId}, ${obj.modifications} mods)${obj.name ? `  ${obj.name}` : ''}`);
      }
    }
    for (const warning of result.warnings) {
      console.log(`\n  warning: ${warning}`);
    }
    return;
  }

  if (command === 'verify') {
    const [path] = rest;
    if (!path) {
      fail('usage: wc3-porter verify <map>');
    }
    // MapData runs the roundtrip gate on every object file at load time.
    const data = new MapData(path);
    if (data.categories.size === 0) {
      console.log(`${data.name}: no object data files found (nothing customized, or names not resolvable).`);
      return;
    }
    for (const cat of data.categories.values()) {
      const status = cat.roundtrip.cosmetic ? 'OK (cosmetic re-encode)' : 'OK (byte-exact)';
      console.log(
        `${cat.fileName}: ${status} — ${cat.file.customTable.objects.length} custom, ${cat.file.originalTable.objects.length} standard edits (${categoryByKey(cat.def.key).label})`,
      );
    }
    for (const warning of data.warnings) {
      console.log(`warning: ${warning}`);
    }
    console.log('All object data files passed roundtrip verification.');
    return;
  }

  if (command === 'port') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string', short: 's', multiple: true },
        target: { type: 'string', short: 't' },
        out: { type: 'string', short: 'o' },
        ids: { type: 'string' },
        all: { type: 'boolean', default: false },
        'include-standard-mods': { type: 'boolean', default: false },
        manifest: { type: 'string' },
      },
    });

    const sourcePaths = values.source ?? [];
    if (sourcePaths.length === 0 || !values.out) {
      fail('port requires at least one --source and --out (see wc3-porter help)');
    }
    if (sourcePaths.length > 1 && values.ids) {
      fail('--ids only works with a single --source; with multiple sources use --all');
    }

    const ids = values.ids ? values.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const result = port({
      sources: sourcePaths.map((path) => ({ kind: 'map' as const, path, ids, all: values.all })),
      targetPath: values.target,
      outDir: values.out,
      includeStandardMods: values['include-standard-mods'],
      manifestPath: values.manifest,
    });

    console.log(`Ported ${result.objects.length} object(s), ${result.assets.length} asset(s).`);
    const remapped = result.objects.filter((o) => o.remapped);
    if (remapped.length > 0) {
      console.log(`Remapped ${remapped.length} colliding rawcode(s): ${remapped.map((o) => `${o.sourceId}->${o.newId}`).join(', ')}`);
    }
    for (const warning of result.warnings) {
      console.log(`warning: ${warning}`);
    }
    console.log(`\nDrop written to ${result.outDir}`);
    console.log(`Next steps: see ${result.reportPath}`);
    return;
  }

  fail(`unknown command '${command}' (see wc3-porter help)`);
}

try {
  main();
} catch (e) {
  if (e instanceof PorterError) {
    fail(e.message);
  }
  throw e;
}
