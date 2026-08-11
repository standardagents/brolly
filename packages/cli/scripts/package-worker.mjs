import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..');
const root = resolve(cli, '../..');
const worker = resolve(cli, 'worker');
await rm(worker, { recursive: true, force: true });
await mkdir(worker, { recursive: true });
await cp(resolve(root, 'apps/guard-worker/dist/brolly_guard/index.js'), resolve(cli, 'worker/index.js'));
await cp(resolve(root, 'apps/guard-worker/dist/client'), resolve(cli, 'worker/client'), { recursive: true });
await cp(resolve(root, 'apps/guard-worker/migrations'), resolve(cli, 'worker/migrations'), { recursive: true });
