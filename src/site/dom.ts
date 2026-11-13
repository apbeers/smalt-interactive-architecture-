// Building DOM without a framework: h('div', { class: 'x', onclick }, child, …).
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function fill(el: Element, attrs: Attrs | null, children: Child[]): void {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c: Child): void => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  fill(el, attrs ?? null, children);
  return el;
}

export function s(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  fill(el, attrs ?? null, children);
  return el;
}

/** A link to a node of the model. */
export const nodeHref = (id: string): string => `#/n/${encodeURIComponent(id)}`;

export function link(id: string, text?: string, attrs: Attrs = {}): HTMLAnchorElement {
  return h('a', { href: nodeHref(id), ...attrs }, text ?? id);
}

export function code(text: string): HTMLElement {
  return h('code', null, text);
}

export function plural(n: number, word: string, many = word + 's'): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}
