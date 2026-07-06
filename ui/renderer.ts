/**
 * Renderer logic. Talks to the main process only through the `porter` bridge
 * exposed by the preload script.
 */
import { PreviewPanel } from './preview';

interface InspectedObject {
  category: string;
  id: string;
  baseId: string;
  name?: string;
  modifications: number;
  modelPath?: string;
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
  inspectMap(path: string): Promise<IpcResult<InspectData>>;
  inspectFolder(path: string): Promise<IpcResult<FolderInfo>>;
  runPort(options: unknown): Promise<IpcResult<PortData>>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  previewFile(source: { kind: string; path: string } | null, filePath: string): Promise<Uint8Array | null>;
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
  filter: string;
}

interface FolderSourceState {
  kind: 'folder';
  path: string;
  info: FolderInfo;
  category: 'units' | 'items' | 'doodads' | 'destructables';
  objectName: string;
  baseId: string;
  modelPath: string;
  iconPath: string;
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
  for (const obj of data.objects) {
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
        </div>`;
    }
  }
  html += '</div>';
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
      <span class="hint">"Based on" is the standard object whose other settings the new object inherits.</span>
    </div>`;
}

// --- Event delegation --------------------------------------------------------

$('sources').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
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
      source.selected.add(obj.id);
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
  const previewFolder = target.dataset.previewFolder;
  if (previewFolder !== undefined) {
    const idx = Number(previewFolder);
    const source = state.sources[idx] as FolderSourceState;
    state.previewing = { sourceIdx: idx, key: 'folder' };
    void preview.show({ kind: 'folder', path: source.path }, source.modelPath, source.objectName || source.info.name);
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
      void preview.show({ kind: 'map', path: source.path }, obj.modelPath, `${obj.name ?? obj.id} (${obj.id})`);
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
  for (const [attr, apply] of [
    ['fCategory', (s: FolderSourceState, v: string) => {
      s.category = v as FolderSourceState['category'];
      s.baseId = s.info.defaults[s.category].baseId;
    }],
    ['fName', (s: FolderSourceState, v: string) => (s.objectName = v)],
    ['fModel', (s: FolderSourceState, v: string) => (s.modelPath = v)],
    ['fIcon', (s: FolderSourceState, v: string) => (s.iconPath = v)],
    ['fBase', (s: FolderSourceState, v: string) => (s.baseId = v)],
  ] as const) {
    const idx = target.dataset[attr];
    if (idx !== undefined) {
      apply(state.sources[Number(idx)] as FolderSourceState, target.value);
      if (attr === 'fCategory') {
        renderSources();
      }
      return;
    }
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
    (state.sources[Number(nameIdx)] as FolderSourceState).objectName = target.value;
  }
  const baseIdx = target.dataset.fBase;
  if (baseIdx !== undefined) {
    (state.sources[Number(baseIdx)] as FolderSourceState).baseId = target.value;
  }
});

// --- Adding sources ----------------------------------------------------------

async function addMapSource(): Promise<void> {
  const path = await window.porter.pickMap('Choose a source map or campaign');
  if (!path) {
    return;
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
  state.sources.push({ kind: 'map', path, data: result.data, selected, filter: '' });
  renderSources();
}

async function addFolderSource(): Promise<void> {
  const path = await window.porter.pickDir('Choose an unzipped asset folder (e.g. a Hive download)');
  if (!path) {
    return;
  }
  const result = await window.porter.inspectFolder(path);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  if (result.data.models.length === 0) {
    alert(`${result.data.name}: no .mdx/.mdl model files found in this folder.`);
    return;
  }
  const info = result.data;
  state.sources.push({
    kind: 'folder',
    path,
    info,
    category: 'units',
    objectName: info.name,
    baseId: info.defaults['units'].baseId,
    modelPath: info.models.find((m) => !/_portrait\.mdx$/i.test(m)) ?? info.models[0],
    iconPath: '',
  });
  renderSources();
}

async function chooseTarget(): Promise<void> {
  const path = await window.porter.pickMap('Choose the target map or campaign');
  if (!path) {
    return;
  }
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

$('btn-add-map').addEventListener('click', () => void addMapSource());
$('btn-add-folder').addEventListener('click', () => void addFolderSource());
$('btn-target').addEventListener('click', () => void chooseTarget());
$('btn-port').addEventListener('click', () => void runPort());

export {};
