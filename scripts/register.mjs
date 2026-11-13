// `node --import ./scripts/register.mjs file.ts`: runs TypeScript that imports `./x.js` for `./x.ts`.
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
