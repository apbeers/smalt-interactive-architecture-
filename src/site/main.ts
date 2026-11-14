// The app: header, search, routing, and the issues, changes, rules and agent pages.
import type { IndexData, Issue } from '../model.js';
import type { Changes } from '../emit/data.js';
import { loadIndex, loadJson, loadSearch } from './data.js';
import { code, h, link, nodeHref, plural } from './dom.js';
import { issueItem, nodeView, platformView } from './views.js';
import { Explorer } from './explorer.js';
import { cityView } from './city.js';
import { cakeView } from './cake.js';
import { impactView } from './impact.js';
import { matrixView } from './matrix.js';
import { pinsView } from './pins.js';
import { timelineView } from './timeline.js';
import { traceView } from './trace.js';
import { hotspotsView } from './hotspots.js';
import { hubView } from './hub.js';

const app = document.getElementById('app')!;
/** Search results open in the explorer where it can show them, else on their page. */
const hrefFor = (row: string[]): string => (['repo', 'dir', 'file', 'symbol'].includes(row[2]!) ? `#/e/${encodeURIComponent(row[0]!)}` : nodeHref(row[0]!));

const KIND_WEIGHT: Record<string, number> = { repo: 50, entry: 40, symbol: 20, dir: 15, file: 10 };

// ---------------------------------------------------------------------------------------------------------------
// Theme: follows the system unless chosen; the choice is kept on this device only.

function setTheme(theme: string | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function initTheme(button: HTMLButtonElement): void {
  let theme: string | null = null;
  try {
    theme = localStorage.getItem('arch.theme');
  } catch {
    // no storage: follow the system
  }
  setTheme(theme);
  const label = (): void => {
    const t = document.documentElement.dataset.theme;
    button.textContent = t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'Auto';
    button.title = `Theme: ${t ?? 'follows the system'}. Click to change.`;
  };
  label();
  button.addEventListener('click', () => {
    const order = [undefined, 'light', 'dark'];
    const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length] ?? null;
    setTheme(next);
    try {
      if (next) localStorage.setItem('arch.theme', next);
      else localStorage.removeItem('arch.theme');
    } catch {
      // not kept: fine
    }
    label();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Search

function score(row: string[], q: string): number {
  const [id, name, kind] = row as [string, string, string];
  const n = name.toLowerCase();
  const base = n.split('/').pop()!;
  let s = 0;
  if (base === q || n === q) s = 100;
  else if (base.startsWith(q)) s = 70;
  else if (n.includes('/' + q) || n.includes(q)) s = 40;
  else if (id.toLowerCase().includes(q)) s = 15;
  else return 0;
  return s + (KIND_WEIGHT[kind] ?? 0) - Math.min(20, n.length / 8);
}

function initSearch(input: HTMLInputElement, results: HTMLElement): void {
  let rows: string[][] = [];
  let active = -1;
  let shown: string[][] = [];
  const close = (): void => {
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const render = (): void => {
    results.replaceChildren(...shown.map((r, i) => h('li', { role: 'option', id: `opt-${i}`, class: i === active ? 'active' : '', 'aria-selected': i === active ? 'true' : 'false' },
      h('a', { href: hrefFor(r), onclick: close }, h('span', { class: `chip kind-${r[2]}` }, r[2]!), ' ', h('strong', null, r[1]!), ' ', h('span', { class: 'muted' }, r[2] === 'repo' ? r[4]! : `${r[3]} · ${r[4]}`)))));
    results.hidden = shown.length === 0;
    input.setAttribute('aria-expanded', String(!results.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  input.addEventListener('focus', async () => {
    if (!rows.length) rows = await loadSearch();
  });
  input.addEventListener('input', async () => {
    if (!rows.length) rows = await loadSearch();
    const q = input.value.trim().toLowerCase();
    active = -1;
    if (q.length < 2) {
      shown = [];
      render();
      return;
    }
    shown = rows.map((r) => [r, score(r, q)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([r]) => r);
    render();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!shown.length) return;
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (ev.key === 'Enter') {
      const pick = shown[active >= 0 ? active : 0];
      if (pick) {
        location.hash = hrefFor(pick);
        input.value = '';
        shown = [];
        close();
        input.blur();
      }
    } else if (ev.key === 'Escape') {
      close();
      input.blur();
    }
  });
  document.addEventListener('click', (ev) => {
    if (!results.contains(ev.target as Node) && ev.target !== input) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      ev.preventDefault();
      input.focus();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Issues, changes, rules, agents

function issuesView(idx: IndexData, params: URLSearchParams): HTMLElement {
  const state = { severity: params.get('severity') ?? '', rule: params.get('rule') ?? '', repo: params.get('repo') ?? '', q: params.get('q') ?? '' };
  const list = h('div');
  const count = h('p', { class: 'muted' });
  const draw = (): void => {
    const q = state.q.toLowerCase();
    const match = idx.issues.filter((i) => (!state.severity || i.severity === state.severity) && (!state.rule || i.rule === state.rule) && (!state.repo || i.node === state.repo || i.node.startsWith(state.repo + '/') || idx.entries.find((e) => e.id === i.node)?.repo === state.repo) && (!q || (i.message + i.node).toLowerCase().includes(q)));
    count.textContent = `${plural(match.length, 'issue')}`;
    const byRule = new Map<string, Issue[]>();
    for (const i of match) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
    const order = { error: 0, warning: 1, info: 2 };
    const groups = [...byRule].sort((a, b) => order[a[1][0]!.severity] - order[b[1][0]!.severity] || b[1].length - a[1].length);
    list.replaceChildren(...groups.map(([rule, items]) => h('details', { class: 'rule-group', open: groups.length <= 3 },
      h('summary', null, h('span', { class: `chip sev sev-${items[0]!.severity}` }, items[0]!.severity), ' ', h('strong', null, rule), ' ', h('span', { class: 'muted' }, `${items.length} · ${idx.rules.find((r) => r.id === rule)?.about ?? ''}`)),
      h('ul', { class: 'issues' }, items.slice(0, 300).map((i) => issueItem(idx, i, true))),
      items.length > 300 ? h('p', { class: 'muted' }, `${items.length - 300} more; narrow the filter.`) : null)));
    const p = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
    history.replaceState(null, '', `#/issues${p.size ? '?' + p : ''}`);
  };
  const select = (key: 'severity' | 'rule' | 'repo', label: string, values: string[]): HTMLElement => {
    const el = h('select', { onchange: () => { state[key] = el.value; draw(); } }, h('option', { value: '' }, `All ${label}`), values.map((v) => h('option', { value: v, selected: state[key] === v }, v)));
    return h('label', null, h('span', { class: 'visually-hidden' }, label), el);
  };
  const search = h('input', { type: 'search', placeholder: 'Filter text', value: state.q, oninput: () => { state.q = search.value; draw(); } });
  draw();
  return h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', null, 'Issues'), h('p', { class: 'lede' }, 'What the checks found, grouped by rule. Each names the place, the evidence and, where known, the fix.')),
    h('div', { class: 'filters' },
      select('severity', 'severities', ['error', 'warning', 'info']),
      select('rule', 'rules', [...new Set(idx.issues.map((i) => i.rule))].sort()),
      select('repo', 'repositories', idx.repos.map((r) => r.name)),
      h('label', null, h('span', { class: 'visually-hidden' }, 'Filter text'), search), count),
    list,
  );
}

async function changesView(): Promise<HTMLElement> {
  let history: Changes[] = [];
  try {
    history = await loadJson<Changes[]>('data/history.json');
  } catch {
    // first build
  }
  const items = history.map((c) => {
    const total = c.commits.length + c.api.length + c.edges.added.length + c.edges.removed.length;
    return h('article', { class: 'change' },
      h('h2', null, new Date(c.to).toLocaleString(), ' ', h('span', { class: 'muted' }, c.from ? `since ${new Date(c.from).toLocaleString()}` : 'first build')),
      h('p', { class: 'muted' }, `Issues: ${c.issues.after.error} errors, ${c.issues.after.warning} warnings, ${c.issues.after.info} info${c.from ? ` (were ${c.issues.before.error}, ${c.issues.before.warning}, ${c.issues.before.info})` : ''}.`),
      !c.from ? null : total === 0 ? h('p', null, 'Nothing changed.') : null,
      c.from && c.commits.length ? h('div', null, h('h3', null, 'Repositories that moved'), h('ul', { class: 'plain' }, c.commits.map((m) => h('li', null, link(m.repo), ' ', code(`${m.before?.slice(0, 7) ?? '—'} → ${m.after.slice(0, 7)}`))))) : null,
      c.api.length ? h('div', null, h('h3', null, 'API changes'), h('ul', { class: 'plain' }, c.api.map((a) => h('li', null, link(a.entry, a.entry.slice(6)),
        a.removed.length ? h('div', { class: 'removed' }, '− ', a.removed.join(', ')) : null,
        a.added.length ? h('div', { class: 'added' }, '+ ', a.added.join(', ')) : null,
        a.changed.length ? h('div', null, '~ ', a.changed.map((x) => x.name).join(', ')) : null)))) : null,
      c.edges.added.length || c.edges.removed.length ? h('div', null, h('h3', null, 'Links between repositories'), h('ul', { class: 'plain' }, [...c.edges.added.map((e) => h('li', { class: 'added' }, '+ ', e)), ...c.edges.removed.map((e) => h('li', { class: 'removed' }, '− ', e))])) : null,
    );
  });
  return h('div', { class: 'page' }, h('header', { class: 'page-head' }, h('h1', null, 'Changes'), h('p', { class: 'lede' }, 'Each build compares itself with the one before: repositories that moved, exports added, removed or changed, and links that appeared or went away.')), items.length ? items : h('p', null, 'No history yet.'));
}

function rulesView(idx: IndexData): HTMLElement {
  const count = (id: string): number => idx.issues.filter((i) => i.rule === id).length;
  return h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', null, 'Rules'), h('p', { class: 'lede' }, 'Built-in checks, and boundary rules from arch.config.json that write down what the repositories\' CLAUDE.md files and ADRs say.')),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Rule'), h('th', null, 'Level'), h('th', null, 'Applies to'), h('th', null, 'What it checks'), h('th', { class: 'num' }, 'Issues'))),
      h('tbody', null, idx.rules.map((r) => h('tr', null, h('td', null, code(r.id)), h('td', null, h('span', { class: `chip sev sev-${r.severity}` }, r.severity)), h('td', null, r.repos), h('td', null, r.about, r.source ? h('div', { class: 'muted' }, r.source) : null), h('td', { class: 'num' }, h('a', { href: `#/issues?rule=${encodeURIComponent(r.id)}` }, String(count(r.id))))))))));
}

function agentsView(idx: IndexData): HTMLElement {
  const site = idx.siteUrl;
  return h('div', { class: 'page prose' },
    h('header', { class: 'page-head' }, h('h1', null, 'For agents'), h('p', { class: 'lede' }, 'Everything on this site is also plain files an agent can fetch, made by a static analyzer on every run: no model reads the code.')),
    h('ul', null,
      h('li', null, h('a', { href: 'llms.txt' }, 'llms.txt'), ': where to start.'),
      h('li', null, h('a', { href: 'context/platform.md' }, 'context/platform.md'), ': the whole platform on one page, with every error and warning.'),
      h('li', null, code('md/<repo>.md'), ' and ', code('md/<repo>/<path>.md'), ': a repository, and one file with its imports, importers, declarations and users.'),
      h('li', null, h('a', { href: 'data/index.json' }, 'data/index.json'), ', ', code('data/repo/<name>.json'), ', ', h('a', { href: 'data/search.json' }, 'data/search.json'), ', ', h('a', { href: 'data/changes.json' }, 'data/changes.json'), ': the model as JSON (schema in src/model.ts).'),
      h('li', null, h('a', { href: 'md/AGENTS.md' }, 'AGENTS.md'), ': how to use this before and after a change, and the query tool.'),
    ),
    h('p', null, 'Every page here links by node id, the same ids the data and the query tool use: ', code('smaltdb'), ', ', code('entry:smaltdb/language'), ', ', code('smaltdb/src/engine/'), ', ', code('smaltdb/src/client/index.ts'), ', ', code('smaltdb/src/client/index.ts#open'), '.'),
    h('p', { class: 'muted' }, `Parser: ${idx.parser.repo} at ${idx.parser.ref.slice(0, 7)}. Site: ${site}`),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Routing

let explorer: Explorer | null = null;

function markNav(path: string): void {
  for (const a of document.querySelectorAll('.site-nav a')) a.toggleAttribute('aria-current', a.getAttribute('href') === `#${path}`);
}

async function route(): Promise<void> {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query] = hash.split('?') as [string, string | undefined];
  const params = new URLSearchParams(query ?? '');
  app.setAttribute('aria-busy', 'true');
  try {
    const idx = await loadIndex();
    // The explorer stays on the page between its routes, so moving through it animates instead of reloading.
    if (path === '/' || path.startsWith('/e/')) {
      const id = path.startsWith('/e/') ? decodeURIComponent(path.slice(3)) : '';
      const fresh = !explorer || !explorer.el.isConnected;
      if (fresh) {
        explorer = new Explorer(idx);
        app.replaceChildren(explorer.el);
        document.body.classList.add('exploring');
        document.body.classList.remove('fullview');
      }
      markNav('/');
      app.removeAttribute('aria-busy');
      await explorer!.go(id, params.get('view') === '3d');
      return;
    }
    document.body.classList.remove('exploring');
    // Views with a stage that fills the window.
    const full = path === '/city' || path === '/layers' || path.startsWith('/impact/') || path === '/matrix';
    document.body.classList.toggle('fullview', full);
    let view: HTMLElement;
    if (path.startsWith('/n/')) view = await nodeView(idx, decodeURIComponent(path.slice(3)));
    else if (path === '/city') view = await cityView(idx, params);
    else if (path === '/layers') view = cakeView(idx, params);
    else if (path.startsWith('/impact/')) view = await impactView(idx, decodeURIComponent(path.slice(8)), params);
    else if (path === '/matrix') view = await matrixView(idx, params);
    else if (path === '/pins') view = pinsView(idx);
    else if (path === '/timeline') view = await timelineView(idx, params);
    else if (path === '/trace') view = await traceView(idx, params);
    else if (path === '/hotspots') view = await hotspotsView(idx);
    else if (path === '/views') view = hubView(idx);
    else if (path === '/overview') view = platformView(idx);
    else if (path === '/issues') view = issuesView(idx, params);
    else if (path === '/changes') view = await changesView();
    else if (path === '/rules') view = rulesView(idx);
    else if (path === '/agents') view = agentsView(idx);
    else view = h('div', { class: 'page' }, h('h1', null, 'Not found'), h('p', null, h('a', { href: '#/' }, 'Explore the platform')));
    app.replaceChildren(view);
    const title = view.querySelector('h1')?.textContent;
    document.title = title ? `${title} · ${idx.title}` : idx.title;
    markNav(['/city', '/timeline', '/issues', '/agents'].includes(path) ? path : path.startsWith('/n/') ? '' : '/views');
  } catch (e) {
    app.replaceChildren(h('div', { class: 'page' }, h('h1', null, 'Could not load'), h('p', null, String((e as Error).message ?? e))));
  }
  app.removeAttribute('aria-busy');
  window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
}

initTheme(document.getElementById('theme') as HTMLButtonElement);
initSearch(document.getElementById('search') as HTMLInputElement, document.getElementById('search-results')!);
window.addEventListener('hashchange', route);
void route();
