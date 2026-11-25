/// <reference lib="es2022" />
/** CLI: print UX spatial feature sheet for one screen node. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AstGraphDB } from './db';
import { Graph } from './core/graph';
import { UX_FEATURES, uxFeatures } from './core/ux';

const ROOT = resolve(__dirname, '..');
const id = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
if (!id) { console.error('usage: tsx server/ux.ts <node-id>'); process.exit(1); }
const dbPath = AstGraphDB.resolveLatestGraphDb(ROOT) ?? '';
if (!dbPath || !existsSync(dbPath)) { console.error('no database'); process.exit(1); }

const g = new Graph(dbPath);
if (!g.nodes.has(id)) { console.error('node not found: ' + id); process.exit(1); }
const values = uxFeatures(g, id);
console.log('ux  ' + id + '  ' + (g.nodes.get(id)?.name ?? ''));
UX_FEATURES.forEach((name, i) => console.log((name + '').padEnd(16) + values[i].toFixed(3)));
