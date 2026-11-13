// Node runs TypeScript itself (type stripping, Node 22.18+), but it does not map an import of `./x.js` to the
// `./x.ts` beside it, as TypeScript's own resolution does. This hook does only that, for imports from a .ts file,
// so smaltty's source and this project's run unbuilt.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const js = new URL(specifier, context.parentURL);
    if (js.protocol === 'file:' && !existsSync(fileURLToPath(js))) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}
