# wc3-object-porter

Port Warcraft III custom objects — units, items, abilities, buffs, upgrades,
doodads, destructibles — from one map (or campaign) into another **without ever
writing into a map file**.

Automated map editing usually dies one of two deaths: a hand-written serializer
gets one byte wrong and the World Editor reads garbage from that point on, or a
rewritten MPQ archive breaks in a way you only discover much later. This tool
avoids the entire class of problem with one rule:

> **Maps are opened read-only. All writes to your map are performed by the
> World Editor itself**, through its own import features. The tool only emits
> the inputs for them.

## What it does

Given a source map and a target map, `wc3-porter port`:

1. **Verifies before trusting.** Every object-data file must survive a
   roundtrip (parse → re-serialize → identical result) before the run
   continues. If a file uses a format the tool doesn't fully understand
   (e.g. Reforged 1.33+), it aborts cleanly instead of guessing.
2. **Walks the dependency closure.** Ask for one unit and its custom
   abilities, the buffs those abilities apply, the items it sells, the units it
   trains, the upgrades it uses — all come along, automatically.
3. **Remaps colliding rawcodes.** IDs already used in the target get fresh,
   digit-bearing IDs (which can never shadow a stock Blizzard rawcode), and
   *every reference* to them is rewritten consistently. A manifest keeps the
   mapping stable, so re-running an import updates objects instead of
   duplicating them.
4. **Collects and re-paths assets.** Models, icons, textures and sounds
   referenced by the ported objects are pulled out of the source archive and
   given clean `war3mapImported\<name>` paths. Texture paths *inside* `.mdx`
   models are patched to match (with their own roundtrip verification), and
   `_portrait.mdx` companions come along automatically. No manual re-pathing.
5. **Inlines string references.** `TRIGSTR_nnn` values are resolved against the
   source's string table so nothing arrives as a dangling reference.
6. **Emits a drop folder**: `import.w3o` + `war3mapImported/` + `report.md`
   (every object, remap, asset, and rewritten field, plus step-by-step
   instructions) + `port-manifest.json`.

Applying the drop takes ~30 seconds in the World Editor:

1. Back up your map. Open it in the editor.
2. **Import Manager** → *File → Import Files...* → select everything in
   `war3mapImported/`. Keep the default paths.
3. **Object Editor** → *File → Import Object Settings...* → pick `import.w3o`.
4. Save. Done — the editor performed every write with its own code.

## Graphical app (easiest)

**WC3ObjectPorter.exe** is a standalone desktop app (no installation, no
Node.js):

- **Add any number of sources**: maps/campaigns to take existing custom
  objects from, and plain **asset folders** (e.g. unzipped Hive Workshop
  downloads) to turn a downloaded model into a brand-new unit, item, doodad
  or destructible — name, base object and icon included, textures re-pathed
  automatically.
- **Built-in 3D model preview**: click any object and its model renders in a
  WebGL viewer with animations (drag to rotate, scroll to zoom). Textures load
  from the source map/folder; stock Blizzard textures stream from
  hiveworkshop.com when online.
- Tick the objects you want, choose your target map or campaign, click *Build
  import drop*. Rawcode collisions are fixed across **all** sources and the
  target at once. The results view shows what was ported, which IDs were
  renamed, and the exact World Editor steps — with buttons to open the drop
  folder and the full report.

Download it from the *Build Windows executable* workflow run (repo **Actions**
tab → latest run → `wc3-object-porter-gui-windows` artifact), or from a
Release when one is published. To build it yourself: `npm run gui:package` →
`release-gui/WC3ObjectPorter.exe`. During development, `npm run gui` launches
it from source.

## Standalone CLI build (no Node.js required)

A packaged `wc3-porter.exe` is built by the *Build Windows executable* GitHub
Actions workflow: open the repo's **Actions** tab, pick the latest run, and
download the `wc3-porter-windows` artifact (pushing a `v*` tag instead attaches
the exe to a GitHub Release). To build it yourself: `npm run package:win` →
`release/wc3-porter.exe`.

It's still a command-line tool: put the exe somewhere convenient, open a
Command Prompt in that folder, and run e.g.

```bat
wc3-porter.exe inspect "C:\Maps\SourceMap.w3x"
wc3-porter.exe port --source "C:\Maps\SourceMap.w3x" --target "C:\Maps\MyMap.w3x" --out drop --all
```

(Double-clicking it just shows the usage text.)

## Usage (from source)

```sh
npm install
npm run build

# What's inside a map?
node dist/cli.js inspect  MySource.w3x

# Can the tool safely read this map? (run this on any map first)
node dist/cli.js verify   MySource.w3x

# Port one unit (and everything it depends on) into a drop folder
node dist/cli.js port --source MySource.w3x --target MyMap.w3x \
    --out drop/ --ids h000

# Port every custom object, including the source's edits to standard objects
node dist/cli.js port --source MySource.w3x --target MyMap.w3x \
    --out drop/ --all --include-standard-mods

# Port from several maps at once (collisions fixed across all of them)
node dist/cli.js port -s MapA.w3x -s MapB.w3x --target MyMap.w3x \
    --out drop/ --all
```

During development, `npm run cli -- <args>` runs the CLI without building.

`--target` is optional but strongly recommended: it is what enables
collision-safe rawcode remapping. Campaigns (`.w3n`) work as both source and
target (campaign-level object data, `war3campaign.*`).

## Design notes

- **No hand-written binary code.** All parsing/serialization is done by
  [mdx-m3-viewer](https://github.com/flowtsohg/mdx-m3-viewer)'s parsers (MPQ,
  the seven `war3map.*` object formats, `war3map.w3o`, MDX). This project only
  implements the *graph logic*: ID allocation, dependency closure, reference
  rewriting.
- **The roundtrip gate is non-negotiable.** Any file the tool cannot
  re-serialize losslessly aborts the run before any output is produced.
- **The `.w3o` output is itself re-parsed before being written** as a final
  self-check.
- **Doodad/destructible *types* are ported; their placements on the terrain
  (`war3map.doo`) are not** — placement is a per-map layout concern, and the
  editor has no safe import channel for it.
- Reference detection in field values is by exact match against the source's
  custom rawcodes (plus asset-extension matching for paths), and every rewrite
  is listed in `report.md` for review.

## Limitations

- Object-data format versions 1–2 (classic through early Reforged). Version 3+
  (Reforged 1.33+) files are detected and refused — never misread.
- Triggers/JASS are not ported; if a ported object is referenced from script in
  the source, wire it up in the target yourself (the report gives you the final
  rawcodes).
- `.mdl` (text-format) models are copied without texture-path patching (rare in
  finished maps; a warning is emitted).

## Development

```sh
npm test          # vitest: end-to-end tests against synthetic fixture maps
npm run build     # tsc → dist/
```

The tests build real MPQ map fixtures in memory (source with a
unit→ability→buff/item dependency chain, imported model + texture; target with
colliding rawcodes) and assert the full pipeline: closure, remapping, TRIGSTR
inlining, MDX patching, idempotency via the manifest, and the roundtrip gate's
rejection of truncated/newer-version files.
