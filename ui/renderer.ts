/**
 * Renderer logic. Talks to the main process only through the `porter` bridge
 * exposed by the preload script.
 */

interface InspectedObject {
  category: string;
  id: string;
  baseId: string;
  name?: string;
  modifications: number;
}

interface InspectData {
  name: string;
  isCampaign: boolean;
  objects: InspectedObject[];
  standardMods: number;
  importCount: number;
  warnings: string[];
}

interface PortedObject {
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
  runPort(options: unknown): Promise<IpcResult<PortData>>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
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

const state = {
  sourcePath: null as string | null,
  targetPath: null as string | null,
  inspectData: null as InspectData | null,
  selected: new Set<string>(),
  filter: '',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(id: string, cls: '' | 'good' | 'bad' | 'warn', html: string): void {
  const el = $(id);
  el.className = `status ${cls}`;
  el.innerHTML = html;
}

function updatePortButton(): void {
  const btn = $<HTMLButtonElement>('btn-port');
  const hint = $('port-hint');
  if (!state.sourcePath || !state.inspectData) {
    btn.disabled = true;
    hint.textContent = 'Pick a source map first.';
    return;
  }
  if (state.selected.size === 0) {
    btn.disabled = true;
    hint.textContent = 'Tick at least one object to port.';
    return;
  }
  btn.disabled = false;
  const target = state.targetPath ? '' : ' (no target chosen: ID collisions cannot be checked)';
  hint.textContent = `${state.selected.size} object(s) selected — dependencies come along automatically.${target}`;
}

function renderObjects(): void {
  const container = $('source-objects');
  const data = state.inspectData;
  if (!data) {
    container.innerHTML = '';
    return;
  }

  const filter = state.filter.toLowerCase();
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
    <div class="toolbar">
      <button id="btn-select-all">Select all</button>
      <button id="btn-select-none">Select none</button>
      <input type="search" id="obj-filter" placeholder="Filter by name or rawcode…" value="${escapeHtml(state.filter)}" />
    </div>
    <div class="objects">`;

  for (const [category, objs] of groups) {
    html += `<div class="cat-header">${CATEGORY_LABELS[category] ?? category} (${objs.length})</div>`;
    for (const obj of objs) {
      const checked = state.selected.has(obj.id) ? 'checked' : '';
      html += `
        <label class="obj-row">
          <input type="checkbox" data-id="${escapeHtml(obj.id)}" ${checked} />
          <code>${escapeHtml(obj.id)}</code>
          <span class="name">${escapeHtml(obj.name ?? '(unnamed)')}</span>
          <span class="base">base: ${escapeHtml(obj.baseId)}</span>
          <span class="base">${obj.modifications} mods</span>
        </label>`;
    }
  }
  html += '</div>';
  container.innerHTML = html;

  $('btn-select-all').addEventListener('click', () => {
    for (const obj of data.objects) {
      state.selected.add(obj.id);
    }
    renderObjects();
    updatePortButton();
  });
  $('btn-select-none').addEventListener('click', () => {
    state.selected.clear();
    renderObjects();
    updatePortButton();
  });
  const filterInput = $<HTMLInputElement>('obj-filter');
  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value;
    renderObjects();
    updatePortButton();
  });
  filterInput.focus();
  filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
  for (const box of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-id]')) {
    box.addEventListener('change', () => {
      const id = box.dataset.id!;
      if (box.checked) {
        state.selected.add(id);
      } else {
        state.selected.delete(id);
      }
      updatePortButton();
    });
  }
}

async function chooseSource(): Promise<void> {
  const path = await window.porter.pickMap('Choose the source map or campaign');
  if (!path) {
    return;
  }
  state.sourcePath = path;
  state.inspectData = null;
  state.selected.clear();
  $('source-path').textContent = path;
  setStatus('source-status', '', 'Reading and verifying…');
  $('results').innerHTML = '';

  const result = await window.porter.inspectMap(path);
  if (!result.ok) {
    setStatus('source-status', 'bad', `✗ ${escapeHtml(result.error)}`);
    renderObjects();
    updatePortButton();
    return;
  }
  state.inspectData = result.data;
  for (const obj of result.data.objects) {
    state.selected.add(obj.id); // everything selected by default
  }
  const bits = [
    `✓ Verified safely readable — <b>${result.data.objects.length}</b> custom object(s)`,
    result.data.standardMods > 0 ? `${result.data.standardMods} standard-object edit(s)` : '',
    result.data.isCampaign ? 'campaign archive' : '',
  ].filter(Boolean);
  setStatus('source-status', 'good', bits.join(' · '));
  if (result.data.warnings.length > 0) {
    setStatus('source-status', 'warn', `${bits.join(' · ')}<br>⚠ ${result.data.warnings.map(escapeHtml).join('<br>⚠ ')}`);
  }
  renderObjects();
  updatePortButton();
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

function renderResults(data: PortData): void {
  const remapped = data.objects.filter((o) => o.remapped);
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
        <li>Back up your ${state.targetPath && state.targetPath.toLowerCase().endsWith('.w3n') ? 'campaign' : 'map'} file.</li>
        <li>Open it in the World Editor${state.targetPath && state.targetPath.toLowerCase().endsWith('.w3n') ? ' (Module → Campaign Editor)' : ''}.</li>
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
  if (!state.sourcePath || !state.inspectData) {
    return;
  }
  const outDir = await window.porter.pickDir('Choose an (ideally empty) folder for the import drop');
  if (!outDir) {
    return;
  }

  document.body.classList.add('running');
  $<HTMLButtonElement>('btn-port').disabled = true;
  $('results').innerHTML = '';

  const everything = state.selected.size === state.inspectData.objects.length;
  const result = await window.porter.runPort({
    sourcePath: state.sourcePath,
    targetPath: state.targetPath ?? undefined,
    outDir,
    all: everything,
    ids: everything ? undefined : [...state.selected],
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

$('btn-source').addEventListener('click', () => void chooseSource());
$('btn-target').addEventListener('click', () => void chooseTarget());
$('btn-port').addEventListener('click', () => void runPort());

export {};
