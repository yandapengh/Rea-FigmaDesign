/// <reference lib="es2022" />
/** CLI: Tier 1.5 onion normalization summary (read-only). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AstGraphDB } from './db';
import { Graph } from './core/graph';
import { onionHashes, onionScreenGroups } from './core/onion';

const ROOT = resolve(__dirname, '..');
const dbPath = AstGraphDB.resolveLatestGraphDb(ROOT) ?? '';
if (!dbPath || !existsSync(dbPath)) { console.error('no database'); process.exit(1); }

const g = new Graph(dbPath);
const hashes = onionHashes(g, dbPath);
const groups = onionScreenGroups(g, hashes);
const t1 = new Set<string>();
let merges = 0;
for (const group of groups) {
  for (const key of group.tier1Keys) t1.add(key);
  if (group.tier1Keys.length > 1) merges += 1;
}
console.log('tier15  db=' + dbPath);
console.log('nodes=' + g.nodes.size.toLocaleString('en-US') + '  screens=' + groups.reduce((a, x) => a + x.ids.length, 0));
console.log('tier1 groups=' + t1.size + '  tier1.5 groups=' + groups.length + '  merged groups=' + merges);
