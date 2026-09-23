import {
  BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip,
  type ChartConfiguration, type Plugin,
} from 'chart.js';
import type { ContributorRow, HostToWebview, StatsViewModel, WebviewToHost } from '../shared/messages';
import { weekRange } from '../stats/dates';
import { formatCount, formatReadableDate } from '../stats/formatDate';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip, Legend);

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type SortKey = 'name' | 'commits' | 'merges' | 'added' | 'removed' | 'binaryFiles' | 'firstDate' | 'lastDate' | 'activeDays';
type Metric = 'commits' | 'added' | 'removed' | 'activeDays';

interface UiState {
  sortKey: SortKey;
  sortDesc: boolean;
  metric: Metric;
  search: string;
  /** Contributor ids shown in the weekly chart, mapped to a fixed colour slot. */
  series: Record<string, number>;
  seriesInitialised: boolean;
}

/** Categorical order from the VS Code theme; a colour stays with a person, not a rank. */
const SERIES_TOKENS = ['--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-green', '--vscode-charts-purple', '--vscode-charts-yellow', '--vscode-charts-red'];
const MAX_SERIES = SERIES_TOKENS.length;
const BAR_LIMIT = 15;

const METRICS: Record<Metric, { label: string; value: (c: ContributorRow) => number }> = {
  commits: { label: 'Commits (incl. merges)', value: (c) => c.commits + c.merges },
  added: { label: 'Lines added', value: (c) => c.added },
  removed: { label: 'Lines removed', value: (c) => c.removed },
  activeDays: { label: 'Active days', value: (c) => c.activeDays },
};

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Name', numeric: false },
  { key: 'commits', label: 'Commits', numeric: true },
  { key: 'merges', label: 'Merges', numeric: true },
  { key: 'added', label: '+ Lines', numeric: true },
  { key: 'removed', label: '− Lines', numeric: true },
  { key: 'binaryFiles', label: 'Binary', numeric: true },
  { key: 'firstDate', label: 'First commit', numeric: false },
  { key: 'lastDate', label: 'Last commit', numeric: false },
  { key: 'activeDays', label: 'Active days', numeric: true },
];

const ui: UiState = {
  sortKey: 'commits',
  sortDesc: true,
  metric: 'commits',
  search: '',
  series: {},
  seriesInitialised: false,
  ...((vscode.getState() as Partial<UiState> | undefined) ?? {}),
};
let model: StatsViewModel | undefined;
let barChart: Chart | undefined;
let lineChart: Chart | undefined;
const app = document.getElementById('app')!;

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  if (event.data?.type !== 'update') return;
  model = event.data.model;
  render();
});
new MutationObserver(() => renderCharts()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
vscode.postMessage({ type: 'ready' });

function saveUi(): void {
  vscode.setState(ui);
}

// ── DOM helpers (textContent only: data never becomes HTML) ─────────────────

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => !!c));
}

function button(label: string, message: WebviewToHost, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, label);
  b.addEventListener('click', () => vscode.postMessage(message));
  return b;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render(): void {
  if (!model) return;
  barChart?.destroy();
  lineChart?.destroy();
  barChart = lineChart = undefined;

  if (model.status !== 'ready') {
    const text = model.status === 'error' ? `Could not load stats: ${model.error ?? 'unknown error'}` : model.status === 'empty' ? 'Open a folder that contains a Git repository.' : 'Reading history…';
    setChildren(app,
      h('h1', {}, model.repoName),
      h('p', { class: model.status === 'error' ? 'banner error' : 'muted' }, text),
      model.status === 'error' ? button('Retry', { type: 'refresh' }) : null,
    );
    return;
  }

  if (!ui.seriesInitialised) {
    model.contributors.slice(0, 3).forEach((c, i) => (ui.series[c.id] = i));
    ui.seriesInitialised = true;
  }
  // Drop series for people that no longer exist (e.g. after regrouping aliases).
  const ids = new Set(model.contributors.map((c) => c.id));
  for (const id of Object.keys(ui.series)) if (!ids.has(id)) delete ui.series[id];

  const t = model.totals;
  const generated = model.generatedAt ? new Date(model.generatedAt).toLocaleString() : '';
  setChildren(app,
    h('header', {},
      h('h1', {}, `Contributors · ${model.repoName}`),
      h('p', { class: 'muted' }, `${model.commitCount.toLocaleString()} commits scanned · ${generated}${model.fromCache ? ' (from cache)' : ''}`),
    ),
    h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Stats actions' },
      h('span', { class: `chip${model.filterActive ? ' active' : ''}`, title: 'Current filters' }, model.filterSummary),
      button('Filters…', { type: 'filters' }),
      button('Refresh', { type: 'refresh' }),
      model.suggestionCount ? button(`Review ${model.suggestionCount} alias suggestion${model.suggestionCount === 1 ? '' : 's'}`, { type: 'reviewAliases' }, { class: 'primary' }) : button('Aliases…', { type: 'reviewAliases' }),
      h('span', { class: 'spacer' }),
      button('Export CSV', { type: 'exportCsv' }),
      button('Export Markdown', { type: 'exportMarkdown' }),
    ),
    model.stale ? h('p', { class: 'banner warning' }, 'History changed since this scan. Click Refresh to update.') : null,
    model.shallow ? h('p', { class: 'banner warning' }, 'Shallow clone: only fetched history is counted.') : null,
    model.hiddenBots ? h('p', { class: 'muted small' }, `${model.hiddenBots} bot account${model.hiddenBots === 1 ? ' is' : 's are'} hidden (setting gitInsight.stats.excludeBots).`) : null,
    h('section', { class: 'tiles', 'aria-label': 'Totals' },
      tile('Contributors', model.contributors.length),
      tile('Commits', t.commits),
      tile('Merge commits', t.merges),
      tile('Lines added', t.added, '+'),
      tile('Lines removed', t.removed, '−'),
      tile('Binary file changes', t.binaryFiles),
    ),
    model.contributors.length === 0 ? h('p', { class: 'muted' }, 'No commits match the current filters.') : renderBody(),
  );
  renderCharts();

  if (model.focusId) {
    const row = document.querySelector<HTMLTableRowElement>(`tr[data-id="${CSS.escape(model.focusId)}"]`);
    row?.classList.add('focused');
    row?.scrollIntoView({ block: 'center' });
    row?.focus();
  }
}

function tile(label: string, value: number, sign = ''): HTMLElement {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-value', title: value.toLocaleString() }, `${value ? sign : ''}${formatCount(value)}`), h('div', { class: 'tile-label' }, label));
}

function renderBody(): DocumentFragment {
  const metricSelect = h('select', { id: 'metric', 'aria-label': 'Metric' });
  for (const [key, m] of Object.entries(METRICS)) metricSelect.append(h('option', { value: key, selected: key === ui.metric }, m.label));
  metricSelect.addEventListener('change', () => {
    ui.metric = metricSelect.value as Metric;
    saveUi();
    renderCharts();
  });

  const search = h('input', { type: 'search', placeholder: 'Filter by name or email', value: ui.search, 'aria-label': 'Filter contributors' });
  search.addEventListener('input', () => {
    ui.search = search.value;
    saveUi();
    renderTable();
  });

  const fragment = document.createDocumentFragment();
  fragment.append(
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, `Top ${BAR_LIMIT} contributors`), h('label', { for: 'metric', class: 'muted' }, 'by '), metricSelect),
      h('div', { class: 'chart', id: 'bar-wrap' }, h('canvas', { id: 'bar', role: 'img' })),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Commits per week'), h('span', { class: 'muted small' }, `Tick up to ${MAX_SERIES} people in the table to compare them.`)),
      h('div', { class: 'chart line', id: 'line-wrap' }, h('canvas', { id: 'line', role: 'img' })),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'All contributors'), search),
      h('div', { class: 'table-wrap' }, h('table', { id: 'table' })),
    ),
  );
  queueMicrotask(renderTable);
  return fragment;
}

function sortedRows(): ContributorRow[] {
  const rows = model!.contributors.filter((c) => {
    const q = ui.search.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.emails.some((e) => e.includes(q));
  });
  const { sortKey, sortDesc } = ui;
  rows.sort((a, b) => {
    const x = a[sortKey];
    const y = b[sortKey];
    const cmp = sortKey === 'firstDate' || sortKey === 'lastDate'
      ? Date.parse(x as string) - Date.parse(y as string)
      : typeof x === 'number' ? x - (y as number) : String(x).localeCompare(String(y));
    return sortDesc ? -cmp : cmp;
  });
  return rows;
}

function renderTable(): void {
  const table = document.getElementById('table');
  if (!table || !model) return;
  const full = Object.keys(ui.series).length >= MAX_SERIES;

  const headRow = h('tr', {}, h('th', { scope: 'col', class: 'check' }, h('span', { class: 'sr-only' }, 'Show in weekly chart')));
  for (const col of COLUMNS) {
    const active = ui.sortKey === col.key;
    const th = h('th', { scope: 'col', class: col.numeric ? 'num' : undefined, 'aria-sort': active ? (ui.sortDesc ? 'descending' : 'ascending') : 'none' });
    const b = h('button', { type: 'button', class: 'sort' }, col.label, active ? (ui.sortDesc ? ' ↓' : ' ↑') : '');
    b.addEventListener('click', () => {
      ui.sortDesc = active ? !ui.sortDesc : col.numeric || col.key.endsWith('Date');
      ui.sortKey = col.key;
      saveUi();
      renderTable();
    });
    th.append(b);
    headRow.append(th);
  }

  const body = h('tbody');
  for (const c of sortedRows()) {
    const checked = c.id in ui.series;
    const box = h('input', { type: 'checkbox', checked, disabled: !checked && full, 'aria-label': `Show ${c.name} in weekly chart`, title: !checked && full ? `At most ${MAX_SERIES} people at once` : undefined });
    box.addEventListener('change', () => toggleSeries(c.id, box.checked));
    const slot = ui.series[c.id];
    const swatch = slot !== undefined ? h('span', { class: 'swatch', 'data-slot': String(slot), 'aria-hidden': 'true' }) : null;
    body.append(
      h('tr', { 'data-id': c.id, tabindex: '-1' },
        h('td', { class: 'check' }, h('span', { class: 'check-wrap' }, box, swatch)),
        h('td', {},
          h('div', { class: 'name' }, c.name, c.identityCount > 1 ? h('span', { class: 'badge', title: 'Merged alias group' }, `${c.identityCount} identities`) : null),
          h('div', { class: 'muted small' }, c.emails.join(', ')),
        ),
        num(c.commits), num(c.merges), num(c.added), num(c.removed), num(c.binaryFiles),
        date(c.firstDate), date(c.lastDate), num(c.activeDays),
      ),
    );
  }
  table.replaceChildren(h('thead', {}, headRow), body);
}

function num(value: number): HTMLTableCellElement {
  return h('td', { class: 'num' }, value.toLocaleString());
}

function date(iso: string): HTMLTableCellElement {
  return h('td', { title: iso }, formatReadableDate(iso, { shortMonth: true }));
}

function toggleSeries(id: string, on: boolean): void {
  if (on) {
    const used = new Set(Object.values(ui.series));
    const slot = [...Array(MAX_SERIES).keys()].find((i) => !used.has(i));
    if (slot === undefined) return;
    ui.series[id] = slot;
  } else {
    delete ui.series[id];
  }
  saveUi();
  renderTable();
  renderCharts();
}

// ── Charts ──────────────────────────────────────────────────────────────────

function theme() {
  return {
    text: cssVar('--vscode-foreground', '#888'),
    muted: cssVar('--vscode-descriptionForeground', '#888'),
    grid: cssVar('--vscode-editorWidget-border', 'rgba(128,128,128,0.25)'),
    surface: cssVar('--vscode-editor-background', '#fff'),
    tooltipBg: cssVar('--vscode-editorHoverWidget-background', '#252526'),
    tooltipFg: cssVar('--vscode-editorHoverWidget-foreground', '#ccc'),
    tooltipBorder: cssVar('--vscode-editorHoverWidget-border', '#454545'),
    font: cssVar('--vscode-font-family', 'sans-serif'),
    series: SERIES_TOKENS.map((token, i) => cssVar(token, ['#3794ff', '#d18616', '#89d185', '#b180d7', '#cca700', '#f14c4c'][i]!)),
  };
}

function renderCharts(): void {
  if (!model || model.status !== 'ready' || model.contributors.length === 0) return;
  const th = theme();
  Chart.defaults.font.family = th.font;
  Chart.defaults.color = th.muted;
  const tooltip = {
    backgroundColor: th.tooltipBg, titleColor: th.tooltipFg, bodyColor: th.tooltipFg, borderColor: th.tooltipBorder, borderWidth: 1,
    padding: 8, cornerRadius: 4, displayColors: true, boxPadding: 4,
  };
  renderBar(th, tooltip);
  renderLine(th, tooltip);
}

function renderBar(th: ReturnType<typeof theme>, tooltip: object): void {
  const canvas = document.getElementById('bar') as HTMLCanvasElement | null;
  const wrap = document.getElementById('bar-wrap');
  if (!canvas || !wrap) return;
  const metric = METRICS[ui.metric];
  const top = [...model!.contributors].sort((a, b) => metric.value(b) - metric.value(a)).slice(0, BAR_LIMIT);
  wrap.style.height = `${top.length * 26 + 40}px`;
  canvas.setAttribute('aria-label', `${metric.label} by contributor: ${top.map((c) => `${c.name} ${metric.value(c)}`).join(', ')}`);

  const config: ChartConfiguration<'bar'> = {
    type: 'bar',
    data: {
      labels: top.map((c) => c.name),
      datasets: [{ label: metric.label, data: top.map(metric.value), backgroundColor: th.series[0], borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'start', maxBarThickness: 16 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { ...tooltip, displayColors: false, callbacks: { label: (ctx) => `${metric.label}: ${(ctx.raw as number).toLocaleString()}` } } },
      scales: {
        x: { beginAtZero: true, grid: { color: th.grid }, border: { display: false }, ticks: { color: th.muted, callback: (v) => formatCount(Number(v)) } },
        y: { grid: { display: false }, border: { color: th.grid }, ticks: { color: th.text, autoSkip: false } },
      },
    },
  };
  barChart?.destroy();
  barChart = new Chart(canvas, config);
}

/** Writes each series' name at its last point when there are few series (identity is never colour-only). */
const endLabels: Plugin<'line'> = {
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    if (chart.data.datasets.length > 4) return;
    const { ctx } = chart;
    const th = theme();
    ctx.save();
    ctx.font = `12px ${th.font}`;
    ctx.fillStyle = th.text;
    ctx.textBaseline = 'middle';
    const labels = chart.data.datasets
      .map((ds, i) => ({ text: String(ds.label ?? ''), point: chart.getDatasetMeta(i).hidden ? undefined : chart.getDatasetMeta(i).data.at(-1) }))
      .filter((l): l is { text: string; point: NonNullable<typeof l.point> } => !!l.point)
      .map((l) => ({ text: l.text, x: l.point.x + 6, y: l.point.y }))
      .sort((a, b) => a.y - b.y);
    // Push overlapping labels apart so lines ending at the same value stay readable.
    const gap = 14;
    for (let i = 1; i < labels.length; i++) labels[i]!.y = Math.max(labels[i]!.y, labels[i - 1]!.y + gap);
    const overflow = labels.length ? labels.at(-1)!.y - chart.chartArea.bottom : 0;
    if (overflow > 0) labels.forEach((l) => (l.y -= overflow));
    for (const l of labels) ctx.fillText(l.text, l.x, l.y);
    ctx.restore();
  },
};

function renderLine(th: ReturnType<typeof theme>, tooltip: object): void {
  const canvas = document.getElementById('line') as HTMLCanvasElement | null;
  if (!canvas) return;
  const selected = model!.contributors.filter((c) => c.id in ui.series);
  const weeks = selected.flatMap((c) => Object.keys(c.weekly)).sort();
  if (selected.length === 0 || weeks.length === 0) {
    canvas.parentElement!.replaceChildren(h('canvas', { id: 'line', role: 'img' }), h('p', { class: 'muted empty-note' }, 'Tick people in the table below to see their weekly commits.'));
    return;
  }
  const labels = weekRange(weeks[0]!, weeks.at(-1)!);
  canvas.setAttribute('aria-label', `Weekly commits for ${selected.map((c) => c.name).join(', ')} from ${labels[0]} to ${labels.at(-1)}. The table lists the totals.`);
  const shortName = (name: string) => (name.length > 16 ? `${name.slice(0, 15)}…` : name);

  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels,
      datasets: selected.map((c) => {
        const color = th.series[ui.series[c.id]!]!;
        return {
          label: shortName(c.name),
          data: labels.map((w) => c.weekly[w] ?? 0),
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderColor: th.surface,
          pointHoverBorderWidth: 2,
          tension: 0,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { right: selected.length <= 4 ? 110 : 8 } },
      plugins: {
        legend: { display: true, position: 'top', align: 'start', labels: { color: th.text, usePointStyle: true, pointStyle: 'line', boxWidth: 16 } },
        tooltip: {
          ...tooltip,
          itemSort: (a, b) => (b.raw as number) - (a.raw as number),
          callbacks: {
            title: (items) => `Week of ${formatReadableDate(String(items[0]?.label ?? ''), { shortMonth: true })}`,
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw as number} commit${ctx.raw === 1 ? '' : 's'}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: th.grid },
          ticks: { color: th.muted, maxRotation: 0, autoSkipPadding: 24, callback(value) { return formatReadableDate(String(this.getLabelForValue(Number(value))), { shortMonth: true }).replace(/ \d{4}$/, ''); } },
        },
        y: { beginAtZero: true, grid: { color: th.grid }, border: { display: false }, ticks: { color: th.muted, precision: 0 } },
      },
    },
    plugins: [endLabels],
  };
  lineChart?.destroy();
  lineChart = new Chart(canvas, config);
}
