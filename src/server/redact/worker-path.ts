import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Source tree (dev/tests: node strips types) or the bundled dist/<name>.mjs next to the server bundle. */
export const workerPath = (name: string) => (existsSync(join(here, `${name}.ts`)) ? join(here, `${name}.ts`) : join(here, `${name}.mjs`));
