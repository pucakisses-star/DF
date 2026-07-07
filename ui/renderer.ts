/**
 * Renderer logic. Talks to the main process only through the `porter` bridge
 * exposed by the preload script.
 */
import { PreviewPanel, renderIcon } from './preview';

interface ObjectReference {
  id: string;
  name?: string;
  custom: boolean;
}

interface ObjectRefField {
  field: string;
  label: string;
  values: ObjectReference[];
}

interface InspectedObject {
  category: string;
  id: string;
  baseId: string;
  name?: string;
  modifications: number;
  modelPath?: string;
  iconPath?: string;
  refs: ObjectRefField[];
}

interface InspectData {
  name: string;
  isCampaign: boolean;
  objects: InspectedObject[];
  standardMods: number;
  importCount: number;
  warnings: string[];
}

interface FolderInfo {
  name: string;
  models: string[];
  icons: string[];
  defaults: Record<string, { baseId: string; idPrefix: string }>;
}

interface ObjectSuggestion {
  category: 'units' | 'items' | 'doodads' | 'destructables';
  baseId: string;
  label: string;
  reason: string;
  iconPath: string;
  name: string;
}

interface PortedObject {
  source: string;
  category: string;
  sourceId: string;
  newId: string;
  baseId: string;
  remapped: boolean;
  reason: string;
  name?: string;
}

interface PortData {
  outDir: string;
  w3oPath: string;
  reportPath: string;
  objects: PortedObject[];
  assets: { importPath: string }[];
  warnings: string[];
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface PorterBridge {
  pickMap(title: string): Promise<string | null>;
  pickDir(title: string): Promise<string | null>;
  pickModel(title: string): Promise<string | null>;
  inspectMap(path: string): Promise<IpcResult<InspectData>>;
  inspectFolder(path: string, recursive?: boolean): Promise<IpcResult<FolderInfo>>;
  suggestObject(folderPath: string, recursive: boolean, modelPath: string, icons: string[]): Promise<IpcResult<ObjectSuggestion>>;
  runPort(options: unknown): Promise<IpcResult<PortData>>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  previewFile(source: { kind: string; path: string } | null, filePath: string): Promise<Uint8Array | null>;
  getPathForFile(file: File): string;
  classifyPath(path: string): Promise<{ kind: 'map' | 'folder' | 'model' | 'project' | 'unknown'; path: string }>;
  saveProject(json: string): Promise<string | null>;
  loadProject(knownPath?: string): Promise<{ path: string; json?: string; error?: string } | null>;
  stockModelPath(category: string, baseId: string): Promise<string | null>;
}

declare global {
  interface Window {
    porter: PorterBridge;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  units: 'Units',
  items: 'Items',
  destructables: 'Destructibles',
  doodads: 'Doodads',
  abilities: 'Abilities',
  buffs: 'Buffs/Effects',
  upgrades: 'Upgrades',
};

interface MapSourceState {
  kind: 'map';
  path: string;
  data: InspectData;
  selected: Set<string>;
  /** Objects deleted from the list entirely (still in the map, just hidden). */
  removed: Set<string>;
  filter: string;
  /** When true, hide objects that have no custom model (use a stock game model). */
  modelsOnly: boolean;
}

interface FolderSourceState {
  kind: 'folder';
  path: string;
  recursive: boolean;
  info: FolderInfo;
  category: 'units' | 'items' | 'doodads' | 'destructables';
  objectName: string;
  baseId: string;
  modelPath: string;
  iconPath: string;
  /** What the model-based auto-detection concluded, for display. */
  suggestion?: string;
  /** True once the user typed a name themselves — suggestions stop touching it. */
  nameTouched?: boolean;
}

type SourceState = MapSourceState | FolderSourceState;

const state = {
  sources: [] as SourceState[],
  targetPath: null as string | null,
  previewing: null as { sourceIdx: number; key: string } | null,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const preview = new PreviewPanel(
  $('preview-canvas') as HTMLCanvasElement,
  $('preview-status'),
  $('sequence-select') as HTMLSelectElement,
  (source, filePath) => window.porter.previewFile(source, filePath),
);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(id: string, cls: '' | 'good' | 'bad' | 'warn', html: string): void {
  const el = $(id);
  el.className = `status ${cls}`;
  el.innerHTML = html;
}

function selectionCount(): number {
  let count = 0;
  for (const source of state.sources) {
    count += source.kind === 'map' ? source.selected.size : 1;
  }
  return count;
}

function updatePortButton(): void {
  const btn = $<HTMLButtonElement>('btn-port');
  const hint = $('port-hint');
  if (state.sources.length === 0) {
    btn.disabled = true;
    hint.textContent = 'Add a source first.';
    return;
  }
  const count = selectionCount();
  if (count === 0) {
    btn.disabled = true;
    hint.textContent = 'Tick at least one object to port.';
    return;
  }
  btn.disabled = false;
  const target = state.targetPath ? '' : ' (no target chosen: ID collisions cannot be checked)';
  hint.textContent = `${count} object(s) selected — dependencies come along automatically.${target}`;
}

// --- Source rendering --------------------------------------------------------

function renderSources(): void {
  const container = $('sources');
  container.innerHTML = '';
  state.sources.forEach((source, idx) => {
    const block = document.createElement('div');
    block.className = 'source-block';
    if (source.kind === 'map') {
      renderMapSource(block, source, idx);
    } else {
      renderFolderSource(block, source, idx);
    }
    container.appendChild(block);
  });
  updatePortButton();
}

function removeButton(idx: number): string {
  return `<button class="small" data-remove="${idx}">Remove</button>`;
}

function renderMapSource(block: HTMLElement, source: MapSourceState, idx: number): void {
  const { data } = source;
  const filter = source.filter.toLowerCase();
  const groups = new Map<string, InspectedObject[]>();
  let hiddenByModelFilter = 0;
  for (const obj of data.objects) {
    if (source.removed.has(obj.id)) {
      continue;
    }
    if (source.modelsOnly && !obj.modelPath) {
      hiddenByModelFilter++;
      continue;
    }
    if (
      filter &&
      !obj.id.toLowerCase().includes(filter) &&
      !(obj.name ?? '').toLowerCase().includes(filter) &&
      !obj.baseId.toLowerCase().includes(filter)
    ) {
      continue;
    }
    const list = groups.get(obj.category) ?? [];
    list.push(obj);
    groups.set(obj.category, list);
  }

  let html = `
    <div class="src-head">
      <b>${escapeHtml(data.name)}</b>
      <span class="path">${data.objects.length} custom object(s)${data.isCampaign ? ' · campaign' : ''}${data.standardMods > 0 ? ` · ${data.standardMods} standard edit(s)` : ''}</span>
      ${removeButton(idx)}
    </div>
    <div class="toolbar">
      <button class="small" data-all="${idx}">Select all</button>
      <button class="small" data-none="${idx}">Select none</button>
      <input type="search" data-filter="${idx}" placeholder="Filter…" value="${escapeHtml(source.filter)}" />
      <button class="small${source.modelsOnly ? ' toggle-on' : ''}" data-models-only="${idx}" title="Show only objects that have a custom model (hide ones using stock game models)">${source.modelsOnly ? '✓ ' : ''}Custom models only</button>
      ${source.removed.size > 0 ? `<button class="small" data-restore="${idx}">Restore ${source.removed.size} removed</button>` : ''}
    </div>
    <div class="objects">`;

  for (const [category, objs] of groups) {
    html += `<div class="cat-header">${CATEGORY_LABELS[category] ?? category} (${objs.length})</div>`;
    for (const obj of objs) {
      const checked = source.selected.has(obj.id) ? 'checked' : '';
      const previewing =
        state.previewing && state.previewing.sourceIdx === idx && state.previewing.key === obj.id ? ' previewing' : '';
      html += `
        <div class="obj-row${previewing}" data-preview="${idx}" data-obj="${escapeHtml(obj.id)}">
          <input type="checkbox" data-check="${idx}" data-id="${escapeHtml(obj.id)}" ${checked} />
          <code>${escapeHtml(obj.id)}</code>
          <span class="name">${escapeHtml(obj.name ?? '(unnamed)')}</span>
          <span class="base">base: ${escapeHtml(obj.baseId)}</span>
          <button class="small x-del" data-del="${idx}" data-id="${escapeHtml(obj.id)}" title="Remove from this list (does not change the map)">✕</button>
        </div>`;
    }
  }
  html += '</div>';
  if (source.modelsOnly && hiddenByModelFilter > 0) {
    html += `<div class="hint">Hiding ${hiddenByModelFilter} object(s) with no custom model.</div>`;
  }
  for (const warning of data.warnings) {
    html += `<div class="status warn">⚠ ${escapeHtml(warning)}</div>`;
  }
  block.innerHTML = html;
}

function renderFolderSource(block: HTMLElement, source: FolderSourceState, idx: number): void {
  const modelOptions = source.info.models
    .map((m) => `<option value="${escapeHtml(m)}" ${m === source.modelPath ? 'selected' : ''}>${escapeHtml(m)}</option>`)
    .join('');
  const iconOptions =
    '<option value="">(no icon)</option>' +
    source.info.icons
      .map((i) => `<option value="${escapeHtml(i)}" ${i === source.iconPath ? 'selected' : ''}>${escapeHtml(i)}</option>`)
      .join('');
  const categoryOptions = (['units', 'items', 'doodads', 'destructables'] as const)
    .map((c) => `<option value="${c}" ${c === source.category ? 'selected' : ''}>${CATEGORY_LABELS[c]}</option>`)
    .join('');

  const previewing =
    state.previewing && state.previewing.sourceIdx === idx ? ' style="outline: 1px solid var(--gold-dim);"' : '';
  block.innerHTML = `
    <div class="src-head">
      <b>${escapeHtml(source.info.name)}</b>
      <span class="path">asset folder · creates a new object</span>
      ${removeButton(idx)}
    </div>
    <div class="folder-form"${previewing}>
      <label>Create a</label>
      <select data-f-category="${idx}">${categoryOptions}</select>
      <label>Name</label>
      <input type="text" data-f-name="${idx}" value="${escapeHtml(source.objectName)}" />
      <label>Model</label>
      <select data-f-model="${idx}">${modelOptions}</select>
      <label>Icon</label>
      <select data-f-icon="${idx}">${iconOptions}</select>
      <label>Based on</label>
      <input type="text" data-f-base="${idx}" value="${escapeHtml(source.baseId)}" maxlength="4" style="width: 70px;" />
    </div>
    <div class="row" style="margin-top: 8px;">
      <button class="small" data-preview-folder="${idx}">Preview model</button>
      <span class="hint">${source.suggestion ? escapeHtml(source.suggestion) + ' ' : ''}"Based on" is the standard object whose other settings the new object inherits.</span>
    </div>`;
}

/**
 * All custom objects reachable from `id` through reference fields (abilities,
 * their buffs, trained units, upgrades, items, ...), including `id` itself.
 */
function dependencyClosure(source: MapSourceState, id: string): Set<string> {
  const byId = new Map(source.data.objects.map((o) => [o.id, o]));
  const closure = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (closure.has(current)) {
      continue;
    }
    closure.add(current);
    const obj = byId.get(current);
    if (!obj) {
      continue;
    }
    for (const ref of obj.refs) {
      for (const value of ref.values) {
        if (value.custom && !closure.has(value.id)) {
          queue.push(value.id);
        }
      }
    }
  }
  return closure;
}

/** Shift-click on a checkbox: tick/untick the object AND its whole dependency chain. */
function applyClosureSelection(idx: number, id: string, select: boolean): void {
  const source = state.sources[idx];
  if (!source || source.kind !== 'map') {
    return;
  }
  const closure = dependencyClosure(source, id);
  for (const depId of closure) {
    if (select) {
      if (!source.removed.has(depId)) {
        source.selected.add(depId);
      }
    } else {
      source.selected.delete(depId);
    }
  }
  renderSources();
  const others = closure.size - 1;
  $('port-hint').textContent = `${select ? 'Selected' : 'Deselected'} ${id}${others > 0 ? ` and ${others} object(s) it references` : ''}.`;
}

/** Show a folder source's model + icon in the right-hand preview panel. */
function previewFolder(idx: number): void {
  const source = state.sources[idx];
  if (!source || source.kind !== 'folder') {
    return;
  }
  state.previewing = { sourceIdx: idx, key: 'folder' };
  const ref = { kind: 'folder' as const, path: source.path, recursive: source.recursive };
  void preview.show(ref, source.modelPath, source.objectName || source.info.name);
  void showDetails(ref, {
    name: source.objectName || source.info.name,
    baseId: source.baseId,
    category: source.category,
    modelPath: source.modelPath,
    iconPath: source.iconPath || undefined,
  });
}

// --- Event delegation --------------------------------------------------------

$('sources').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // Shift-click a checkbox: select/deselect its whole dependency chain.
  // (click fires after the checkbox state flips, so `checked` is the NEW state)
  if (e.shiftKey && target instanceof HTMLInputElement && target.dataset.check !== undefined) {
    applyClosureSelection(Number(target.dataset.check), target.dataset.id!, target.checked);
    return;
  }
  const modelsOnly = target.dataset.modelsOnly;
  if (modelsOnly !== undefined) {
    const source = state.sources[Number(modelsOnly)] as MapSourceState;
    source.modelsOnly = !source.modelsOnly;
    renderSources();
    return;
  }
  const remove = target.dataset.remove;
  if (remove !== undefined) {
    state.sources.splice(Number(remove), 1);
    state.previewing = null;
    preview.clear('Preview cleared.');
    renderSources();
    return;
  }
  const all = target.dataset.all;
  if (all !== undefined) {
    const source = state.sources[Number(all)] as MapSourceState;
    for (const obj of source.data.objects) {
      if (!source.removed.has(obj.id)) {
        source.selected.add(obj.id);
      }
    }
    renderSources();
    return;
  }
  const none = target.dataset.none;
  if (none !== undefined) {
    (state.sources[Number(none)] as MapSourceState).selected.clear();
    renderSources();
    return;
  }
  const del = target.dataset.del;
  if (del !== undefined) {
    const source = state.sources[Number(del)] as MapSourceState;
    const id = target.dataset.id!;
    source.removed.add(id);
    source.selected.delete(id);
    if (state.previewing && state.previewing.sourceIdx === Number(del) && state.previewing.key === id) {
      state.previewing = null;
    }
    renderSources();
    return;
  }
  const restore = target.dataset.restore;
  if (restore !== undefined) {
    (state.sources[Number(restore)] as MapSourceState).removed.clear();
    renderSources();
    return;
  }
  const previewFolderBtn = target.dataset.previewFolder;
  if (previewFolderBtn !== undefined) {
    previewFolder(Number(previewFolderBtn));
    return;
  }
  const row = target.closest<HTMLElement>('.obj-row');
  if (row && !(target instanceof HTMLInputElement)) {
    const idx = Number(row.dataset.preview);
    const id = row.dataset.obj!;
    const source = state.sources[idx] as MapSourceState;
    const obj = source.data.objects.find((o) => o.id === id);
    if (obj) {
      state.previewing = { sourceIdx: idx, key: id };
      for (const el of $('sources').querySelectorAll('.obj-row.previewing')) {
        el.classList.remove('previewing');
      }
      row.classList.add('previewing');
      const ref = { kind: 'map' as const, path: source.path };
      void previewObject(ref, obj);
      void showDetails(ref, {
        name: obj.name ?? obj.id,
        id: obj.id,
        baseId: obj.baseId,
        category: obj.category,
        modelPath: obj.modelPath,
        iconPath: obj.iconPath,
        refs: obj.refs,
        modifications: obj.modifications,
      });
    }
  }
});

$('sources').addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  const check = target.dataset.check;
  if (check !== undefined && target instanceof HTMLInputElement) {
    const source = state.sources[Number(check)] as MapSourceState;
    if (target.checked) {
      source.selected.add(target.dataset.id!);
    } else {
      source.selected.delete(target.dataset.id!);
    }
    updatePortButton();
    return;
  }
  // Folder object form: model/icon changes update the preview immediately.
  if (target.dataset.fCategory !== undefined) {
    const idx = Number(target.dataset.fCategory);
    const s = state.sources[idx] as FolderSourceState;
    s.category = target.value as FolderSourceState['category'];
    s.baseId = s.info.defaults[s.category].baseId;
    renderSources();
    previewFolder(idx);
    return;
  }
  if (target.dataset.fModel !== undefined) {
    const idx = Number(target.dataset.fModel);
    const s = state.sources[idx] as FolderSourceState;
    s.modelPath = target.value;
    previewFolder(idx); // update the 3D viewer right away
    void applySuggestion(s).then(() => previewFolder(idx));
    return;
  }
  if (target.dataset.fIcon !== undefined) {
    const idx = Number(target.dataset.fIcon);
    const s = state.sources[idx] as FolderSourceState;
    s.iconPath = target.value;
    previewFolder(idx); // refresh the icon shown below the model
    return;
  }
  if (target.dataset.fBase !== undefined) {
    (state.sources[Number(target.dataset.fBase)] as FolderSourceState).baseId = target.value;
    return;
  }
});

$('sources').addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  const filterIdx = target.dataset.filter;
  if (filterIdx !== undefined) {
    const source = state.sources[Number(filterIdx)] as MapSourceState;
    source.filter = target.value;
    const pos = target.selectionStart;
    renderSources();
    const again = $('sources').querySelector<HTMLInputElement>(`input[data-filter="${filterIdx}"]`);
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  }
  const nameIdx = target.dataset.fName;
  if (nameIdx !== undefined) {
    const src = state.sources[Number(nameIdx)] as FolderSourceState;
    src.objectName = target.value;
    src.nameTouched = true;
  }
  const baseIdx = target.dataset.fBase;
  if (baseIdx !== undefined) {
    (state.sources[Number(baseIdx)] as FolderSourceState).baseId = target.value;
  }
});

// --- Adding sources ----------------------------------------------------------

async function addMapSource(): Promise<void> {
  const path = await window.porter.pickMap('Choose a source map or campaign');
  if (path) {
    await addMapByPath(path);
  }
}

async function addMapByPath(path: string): Promise<void> {
  if (state.sources.some((s) => s.kind === 'map' && s.path === path)) {
    return; // already added
  }
  const result = await window.porter.inspectMap(path);
  if (!result.ok) {
    setStatus('target-status', 'bad', ''); // no-op placeholder to keep layout
    alert(result.error);
    return;
  }
  const selected = new Set<string>();
  for (const obj of result.data.objects) {
    selected.add(obj.id); // everything selected by default
  }
  state.sources.push({ kind: 'map', path, data: result.data, selected, removed: new Set(), filter: '', modelsOnly: false });
  renderSources();
}

async function addModelSource(): Promise<void> {
  const path = await window.porter.pickModel('Choose a model file (.mdx / .mdl)');
  if (!path) {
    return;
  }
  const norm = path.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  await addFolderByPath(path.slice(0, slash), false, norm.slice(slash + 1));
}

async function addFolderSource(): Promise<void> {
  const path = await window.porter.pickDir('Choose an unzipped asset folder (e.g. a Hive download)');
  if (path) {
    await addFolderByPath(path);
  }
}

async function addFolderByPath(path: string, recursive = true, preferredModel?: string): Promise<void> {
  if (state.sources.some((s) => s.kind === 'folder' && s.path === path && s.recursive === recursive)) {
    return; // already added
  }
  const result = await window.porter.inspectFolder(path, recursive);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  if (result.data.models.length === 0) {
    alert(`${result.data.name}: no .mdx/.mdl model files found in this folder.`);
    return;
  }
  const info = result.data;
  const modelPath =
    (preferredModel && info.models.find((m) => m.toLowerCase() === preferredModel.toLowerCase())) ??
    info.models.find((m) => !/_portrait\.(mdx|mdl)$/i.test(m)) ??
    info.models[0];
  const source: FolderSourceState = {
    kind: 'folder',
    path,
    recursive,
    info,
    category: 'units',
    objectName: preferredModel ? preferredModel.replace(/\.(mdx|mdl)$/i, '') : info.name,
    baseId: info.defaults['units'].baseId,
    modelPath,
    iconPath: '',
  };
  const idx = state.sources.length;
  state.sources.push(source);
  renderSources();
  await applySuggestion(source);
  // Auto-show the new object's model and icon without a manual click.
  previewFolder(idx);
}

/** Ask the model what it wants to be, and prefill the form accordingly. */
async function applySuggestion(source: FolderSourceState): Promise<void> {
  const result = await window.porter.suggestObject(source.path, source.recursive, source.modelPath, source.info.icons);
  if (!result.ok) {
    return; // suggestion is best-effort; the form defaults stand
  }
  source.category = result.data.category;
  source.baseId = result.data.baseId;
  if (!source.iconPath && result.data.iconPath) {
    source.iconPath = result.data.iconPath;
  }
  if (!source.nameTouched && result.data.name) {
    source.objectName = result.data.name;
  }
  source.suggestion = `Detected: ${result.data.label} (${result.data.reason}).`;
  renderSources();
}

async function chooseTarget(): Promise<void> {
  const path = await window.porter.pickMap('Choose the target map or campaign');
  if (path) {
    await setTargetByPath(path);
  }
}

async function setTargetByPath(path: string): Promise<void> {
  state.targetPath = path;
  $('target-path').textContent = path;
  setStatus('target-status', '', 'Checking…');
  const result = await window.porter.inspectMap(path);
  if (!result.ok) {
    state.targetPath = null;
    setStatus('target-status', 'bad', `✗ ${escapeHtml(result.error)}`);
  } else {
    setStatus(
      'target-status',
      'good',
      `✓ Verified — has ${result.data.objects.length} custom object(s) of its own (collisions will be auto-fixed)`,
    );
  }
  updatePortButton();
}

// --- Porting -----------------------------------------------------------------

function buildSourceSpecs(): { specs: unknown[]; error?: string } {
  const specs: unknown[] = [];
  for (const source of state.sources) {
    if (source.kind === 'map') {
      if (source.selected.size === 0) {
        continue;
      }
      const everything = source.selected.size === source.data.objects.length;
      specs.push({
        kind: 'map',
        path: source.path,
        all: everything,
        ids: everything ? undefined : [...source.selected],
      });
    } else {
      if (!source.objectName.trim()) {
        return { specs, error: `${source.info.name}: give the new object a name.` };
      }
      if (source.baseId.length !== 4) {
        return { specs, error: `${source.info.name}: "Based on" must be a 4-character rawcode (e.g. hfoo).` };
      }
      specs.push({
        kind: 'folder',
        path: source.path,
        recursive: source.recursive,
        objects: [
          {
            category: source.category,
            name: source.objectName.trim(),
            modelPath: source.modelPath,
            iconPath: source.iconPath || undefined,
            baseId: source.baseId,
          },
        ],
      });
    }
  }
  return { specs };
}

function renderResults(data: PortData): void {
  const remapped = data.objects.filter((o) => o.remapped);
  const isCampaign = state.targetPath ? state.targetPath.toLowerCase().endsWith('.w3n') : false;
  let html = `<div class="results">
    <h2 style="color: var(--good); margin: 16px 0 6px;">✓ Import drop built</h2>
    <ul>
      <li><b>${data.objects.length}</b> object(s) ported (including dependencies)</li>
      <li><b>${data.assets.length}</b> asset file(s) collected &amp; re-pathed</li>
      ${remapped.length > 0 ? `<li class="remaps">${remapped.length} ID(s) renamed to avoid collisions: ${remapped.map((o) => `<code>${escapeHtml(o.sourceId)}→${escapeHtml(o.newId)}</code>`).join(', ')}</li>` : ''}
    </ul>`;

  if (data.warnings.length > 0) {
    html += `<ul class="warnings">${data.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  }

  html += `
    <div class="row" style="margin-top: 10px;">
      <button id="btn-open-drop">Open drop folder</button>
      <button id="btn-open-report">Open full report</button>
    </div>
    <div class="steps">
      <b>Apply it in the World Editor (the editor does all the writing):</b>
      <ol>
        <li>Back up your ${isCampaign ? 'campaign' : 'map'} file.</li>
        <li>Open it in the World Editor${isCampaign ? ' (Module → Campaign Editor)' : ''}.</li>
        ${data.assets.length > 0 ? '<li>Import Manager → File → Import Files… → select everything inside the <code>war3mapImported</code> folder of the drop. Keep the default paths.</li>' : ''}
        <li>Object Editor → File → Import Object Settings… → pick <code>import.w3o</code> from the drop.</li>
        <li>Save. Check a couple of the imported objects.</li>
      </ol>
    </div>
  </div>`;

  $('results').innerHTML = html;
  $('btn-open-drop').addEventListener('click', () => void window.porter.showInFolder(data.w3oPath));
  $('btn-open-report').addEventListener('click', () => void window.porter.openPath(data.reportPath));
}

async function runPort(): Promise<void> {
  const { specs, error } = buildSourceSpecs();
  if (error) {
    $('results').innerHTML = `<div class="status bad" style="margin-top: 12px;">✗ ${escapeHtml(error)}</div>`;
    return;
  }
  if (specs.length === 0) {
    return;
  }
  const outDir = await window.porter.pickDir('Choose an (ideally empty) folder for the import drop');
  if (!outDir) {
    return;
  }

  document.body.classList.add('running');
  $<HTMLButtonElement>('btn-port').disabled = true;
  $('results').innerHTML = '';

  const result = await window.porter.runPort({
    sources: specs,
    targetPath: state.targetPath ?? undefined,
    outDir,
    includeStandardMods: $<HTMLInputElement>('opt-standard').checked,
  });

  document.body.classList.remove('running');
  updatePortButton();

  if (!result.ok) {
    $('results').innerHTML = `<div class="status bad" style="margin-top: 12px;">✗ ${escapeHtml(result.error)}<br><span class="hint">Nothing was written to your maps.</span></div>`;
    return;
  }
  renderResults(result.data);
}

/**
 * Preview an object's model: its custom model if it has one, otherwise the
 * standard model of its base object (resolved from the game's data tables,
 * streamed from Hive when online).
 */
let previewRequest = 0;

async function previewObject(ref: { kind: 'map' | 'folder'; path: string }, obj: InspectedObject): Promise<void> {
  const request = ++previewRequest;
  const label = `${obj.name ?? obj.id} (${obj.id})`;
  if (obj.modelPath) {
    await preview.show(ref, obj.modelPath, label);
    return;
  }
  preview.clear(`${label}: looking up the standard model for base '${obj.baseId}'…`);
  const stock = await window.porter.stockModelPath(obj.category, obj.baseId);
  if (request !== previewRequest) {
    return; // the user clicked something else while we were looking it up
  }
  if (stock) {
    await preview.show(ref, stock, `${label} — standard model of '${obj.baseId}'`);
  } else {
    preview.clear(
      `${label}: uses the standard model of '${obj.baseId}', which couldn't be resolved (offline, or no model for this type).`,
    );
  }
}

// --- Details panel -----------------------------------------------------------

function escapeAttr(v: string): string {
  return escapeHtml(v);
}

async function showDetails(
  source: { kind: 'map' | 'folder'; path: string },
  info: {
    name: string;
    id?: string;
    baseId?: string;
    category?: string;
    modelPath?: string;
    iconPath?: string;
    refs?: ObjectRefField[];
    modifications?: number;
  },
): Promise<void> {
  const details = $('details');
  details.style.display = 'block';
  $('d-name').textContent = info.name || '(unnamed)';
  const metaBits = [
    info.id ? `${info.id}` : '',
    info.baseId ? `base ${info.baseId}` : '',
    info.category ? (CATEGORY_LABELS[info.category] ?? info.category) : '',
    info.modifications !== undefined ? `${info.modifications} modified field(s)` : '',
    info.modelPath ?? '',
  ].filter(Boolean);
  $('d-meta').textContent = metaBits.join(' · ');

  const refsEl = $('d-refs');
  refsEl.innerHTML = (info.refs ?? [])
    .map(
      (ref) =>
        `<dt>${escapeHtml(ref.label)}</dt><dd>${ref.values
          .map(
            (v) =>
              `<span class="chip${v.custom ? ' custom' : ''}" title="${escapeAttr(v.id)}">${escapeHtml(
                v.name ? `${v.name} (${v.id})` : v.id,
              )}</span>`,
          )
          .join('')}</dd>`,
    )
    .join('');

  const iconCanvas = $('icon-canvas') as HTMLCanvasElement;
  iconCanvas.style.display = 'none';
  if (info.iconPath) {
    const ok = await renderIcon(iconCanvas, (src, fp) => window.porter.previewFile(src, fp), source, info.iconPath);
    if (ok) {
      iconCanvas.style.display = 'block';
    }
  }
}

// --- Save / load the porter list -----------------------------------------------

interface ProjectSource {
  kind: 'map' | 'folder';
  path: string;
  recursive?: boolean;
  selected?: string[];
  removed?: string[];
  category?: FolderSourceState['category'];
  objectName?: string;
  baseId?: string;
  modelPath?: string;
  iconPath?: string;
}

interface ProjectFile {
  version: 1;
  app: 'wc3-object-porter';
  targetPath: string | null;
  includeStandardMods: boolean;
  sources: ProjectSource[];
}

function serializeProject(): ProjectFile {
  return {
    version: 1,
    app: 'wc3-object-porter',
    targetPath: state.targetPath,
    includeStandardMods: $<HTMLInputElement>('opt-standard').checked,
    sources: state.sources.map((source): ProjectSource => {
      if (source.kind === 'map') {
        return { kind: 'map', path: source.path, selected: [...source.selected], removed: [...source.removed] };
      }
      return {
        kind: 'folder',
        path: source.path,
        recursive: source.recursive,
        category: source.category,
        objectName: source.objectName,
        baseId: source.baseId,
        modelPath: source.modelPath,
        iconPath: source.iconPath,
      };
    }),
  };
}

async function saveList(): Promise<void> {
  if (state.sources.length === 0 && !state.targetPath) {
    alert('Nothing to save yet — add a source or target first.');
    return;
  }
  const savedTo = await window.porter.saveProject(JSON.stringify(serializeProject(), null, 2));
  if (savedTo) {
    setStatus('target-status', 'good', `✓ List saved to ${escapeHtml(savedTo)}`);
  }
}

async function loadList(knownPath?: string): Promise<void> {
  const result = await window.porter.loadProject(knownPath);
  if (!result) {
    return;
  }
  if (result.error || !result.json) {
    alert(`Could not read ${result.path}: ${result.error ?? 'empty file'}`);
    return;
  }
  let project: ProjectFile;
  try {
    project = JSON.parse(result.json) as ProjectFile;
    if (project.app !== 'wc3-object-porter' || project.version !== 1 || !Array.isArray(project.sources)) {
      throw new Error('not a wc3-object-porter list');
    }
  } catch (e) {
    alert(`${result.path} is not a valid porter list (${(e as Error).message}).`);
    return;
  }

  // Replace the current session with the saved one, loading sequentially.
  state.sources = [];
  state.previewing = null;
  preview.clear('Loading saved list…');
  renderSources();

  const problems: string[] = [];
  for (const saved of project.sources) {
    const before = state.sources.length;
    if (saved.kind === 'map') {
      await addMapByPath(saved.path);
      const added = state.sources[before];
      if (!added || added.kind !== 'map') {
        problems.push(`${saved.path}: could not be reopened.`);
        continue;
      }
      if (saved.selected) {
        const available = new Set(added.data.objects.map((o) => o.id));
        const wanted = saved.selected.filter((id) => available.has(id));
        added.selected = new Set(wanted);
        const missing = saved.selected.length - wanted.length;
        if (missing > 0) {
          problems.push(`${added.data.name}: ${missing} previously selected object(s) no longer exist in the map.`);
        }
      }
      if (saved.removed) {
        added.removed = new Set(saved.removed);
        for (const id of added.removed) {
          added.selected.delete(id);
        }
      }
    } else {
      await addFolderByPath(saved.path, saved.recursive ?? true);
      const added = state.sources[before];
      if (!added || added.kind !== 'folder') {
        problems.push(`${saved.path}: folder could not be reopened.`);
        continue;
      }
      if (saved.category) {
        added.category = saved.category;
      }
      if (saved.objectName) {
        added.objectName = saved.objectName;
      }
      if (saved.baseId) {
        added.baseId = saved.baseId;
      }
      if (saved.modelPath) {
        if (added.info.models.includes(saved.modelPath)) {
          added.modelPath = saved.modelPath;
        } else {
          problems.push(`${added.info.name}: saved model '${saved.modelPath}' is gone; using '${added.modelPath}'.`);
        }
      }
      if (saved.iconPath !== undefined) {
        if (saved.iconPath === '' || added.info.icons.includes(saved.iconPath)) {
          added.iconPath = saved.iconPath;
        } else {
          problems.push(`${added.info.name}: saved icon '${saved.iconPath}' is gone.`);
        }
      }
    }
  }

  $<HTMLInputElement>('opt-standard').checked = Boolean(project.includeStandardMods);
  if (project.targetPath) {
    await setTargetByPath(project.targetPath);
  }
  renderSources();

  if (problems.length > 0) {
    alert(`List loaded with warnings:\n\n${problems.join('\n')}`);
  } else {
    setStatus('target-status', 'good', `✓ List loaded from ${escapeHtml(result.path)}`);
  }
}

// --- Drag & drop ---------------------------------------------------------------

let dragDepth = 0;

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    document.body.classList.remove('dropping');
  }
});

async function handleDrop(files: FileList, asTarget: boolean): Promise<void> {
  const paths: string[] = [];
  for (const file of files) {
    try {
      paths.push(window.porter.getPathForFile(file));
    } catch {
      // ignore non-filesystem drops
    }
  }
  // Load strictly one after another so big maps don't race each other.
  for (const path of paths) {
    const classified = await window.porter.classifyPath(path);
    if (classified.kind === 'map') {
      if (asTarget) {
        await setTargetByPath(path);
      } else {
        await addMapByPath(path);
      }
    } else if (classified.kind === 'folder' && !asTarget) {
      await addFolderByPath(path);
    } else if (classified.kind === 'model' && !asTarget) {
      const norm = path.replace(/\\/g, '/');
      const slash = norm.lastIndexOf('/');
      await addFolderByPath(path.slice(0, slash), false, norm.slice(slash + 1));
    } else if (classified.kind === 'project') {
      await loadList(path);
    } else if (classified.kind === 'unknown') {
      alert(`${path}\n\nNot a map (.w3x/.w3m/.w3n), model (.mdx/.mdl), folder, or .wc3port list — ignored.`);
    }
  }
}

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (e.dataTransfer?.files?.length) {
    const onTarget = (e.target as HTMLElement).closest('#card-target') !== null;
    void handleDrop(e.dataTransfer.files, onTarget);
  }
});

$('btn-add-map').addEventListener('click', () => void addMapSource());
$('btn-add-model').addEventListener('click', () => void addModelSource());
$('btn-save-list').addEventListener('click', () => void saveList());
$('btn-load-list').addEventListener('click', () => void loadList());
$('btn-add-folder').addEventListener('click', () => void addFolderSource());
$('btn-target').addEventListener('click', () => void chooseTarget());
$('btn-port').addEventListener('click', () => void runPort());

export {};
