// The views, in one place.
import type { IndexData } from '../model.js';
import { h } from './dom.js';

const VIEWS: [string, string, string][] = [
  ['#/', 'Explore', 'Zoom from the platform into repositories, folders, files and declarations, with a 3D map of where you are.'],
  ['#/city', 'City', 'Every file a building in its repository\'s district: height is code, colour is health, hot spots or change. Click for import arcs.'],
  ['#/timeline', 'Time-lapse', 'The platform growing day by day from its git history: repositories appear, links come and go, issues rise and fall.'],
  ['#/layers', 'Layers', 'The layers as 3D slabs with the links between repositories; links that climb against the layers pulse red.'],
  ['#/impact/smaltdb', 'What breaks?', 'A ripple through everything that depends on something, one ring per hop. Open it from any node\'s panel.'],
  ['#/trace', 'Trace', 'A path through the code played step by step: named traces, or the shortest path between any two nodes.'],
  ['#/matrix', 'Matrix', 'Everything against everything at one level; cycles and links against the layering stand out. Drill into folders.'],
  ['#/pins', 'Pin drift', 'Every commit pin on a timeline against the head of the repository it pins, coloured by how far behind it is.'],
  ['#/hotspots', 'Hot spots', 'Source files by how much they change and how much depends on them.'],
  ['#/overview', 'Overview', 'The platform on one page: the map, the layers and the errors.'],
  ['#/changes', 'Changes', 'What moved since the previous build: API, links, repositories.'],
  ['#/rules', 'Rules', 'What the checks look for, and where each rule comes from.'],
];

export function hubView(_idx: IndexData): HTMLElement {
  return h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', null, 'Views'), h('p', { class: 'lede' }, 'The same model, seen different ways. Everything is computed from the code by the analyzer; nothing here is drawn by hand.')),
    h('div', { class: 'cards views' }, VIEWS.map(([href, title, about]) => h('a', { class: 'card view-card', href }, h('h3', null, title), h('p', { class: 'muted' }, about)))),
  );
}
