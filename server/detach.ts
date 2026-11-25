/// <reference lib="es2022" />
/** CLI: component-library detach recall (stage 6). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AstGraphDB } from './db';
import { Graph } from './core/graph';
import { syntheticDetachRecall } from './core/detach';

const ROOT = resolve(__dirname, '..');
const dbPath = AstGraphDB.resolveLatestGraphDb(ROOT) ?? '';
if (!dbPath || !existsSync(dbPath)) { console.error('no database'); process.exit(1); }

const g = new Graph(dbPath);
const r = syntheticDetachRecall(g, 300);
const pct = (n: number): number => Math.round((100 * n) / Math.max(1, r.sample));
console.log('detach  db=' + dbPath);
console.log('sample=' + r.sample + '  top1=' + pct(r.top1) + '%  top3=' + pct(r.top3) + '%  top5=' + pct(r.top5) + '%');
