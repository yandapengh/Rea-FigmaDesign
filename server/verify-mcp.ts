/// <reference lib="es2022" />
/**
 * MCP surface guard: the server must advertise the exact tool set, constraints and
 * annotations that the docs promise. Drift here is silent for users, so it is checked.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const SERVER = resolve(ROOT, 'server/mcp.ts');

let failures = 0;

function check(name: string, ok: boolean, detail: string = ''): void {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures += 1;
}

interface Rpc {
  id?: number;
  result?: {
    tools?: Array<{
      name: string;
      inputSchema: { properties?: Record<string, { enum?: string[] }> };
      annotations?: Record<string, unknown>;
    }>;
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  error?: unknown;
}

async function main(): Promise<void> {
  const child = spawn(process.execPath, [TSX, SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (m: Rpc) => void>();
  let buffer = '';

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number') {
        const settle = waiting.get(msg.id);
        if (settle) {
          waiting.delete(msg.id);
          settle(msg);
        }
      }
    }
  });

  const rpc = (id: number, method: string, params: Record<string, unknown>): Promise<Rpc> =>
    new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => rejectRpc(new Error('timeout: ' + method)), 20000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolveRpc(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '1' },
  });

  const list = await rpc(2, 'tools/list', {});
  const tools = list.result?.tools ?? [];
  check('tools/list advertises 16 tools', tools.length === 16, String(tools.length));

  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const required of [
    'list_projects',
    'configure_project',
    'list_screens',
    'screen_sheet',
    'screen_family',
    'list_categories',
    'category_report',
    'health_check',
    'build_review_board',
    'apply_labels',
    'server_info',
  ]) {
    check('tool present: ' + required, byName.has(required));
  }
  check('legacy tool removed: review_queue', !byName.has('review_queue'));
  check('list_projects is read-only', byName.get('list_projects')?.annotations?.readOnlyHint === true);
  check('configure_project is destructive', byName.get('configure_project')?.annotations?.destructiveHint === true);

  const screens = byName.get('list_screens');
  const enumValues = screens?.inputSchema.properties?.archetype?.enum ?? [];
  check(
    'list_screens archetype is an enum',
    JSON.stringify(enumValues) === JSON.stringify(['page', 'overlay-panel', 'overlay', 'unknown']),
    enumValues.join(','),
  );
  check('list_screens is read-only', screens?.annotations?.readOnlyHint === true);
  const apply = byName.get('apply_labels');
  check('apply_labels is destructive', apply?.annotations?.destructiveHint === true);
  check('apply_labels is not read-only', apply?.annotations?.readOnlyHint === false);

  const unknown = await rpc(3, 'tools/call', { name: 'not_a_tool', arguments: {} });
  check('unknown tool returns a JSON-RPC error', unknown.error !== undefined);

  const badArchetype = await rpc(5, 'tools/call', { name: 'list_screens', arguments: { archetype: 'popup' } });
  const badText = badArchetype.result?.content?.[0]?.text ?? '';
  check('invalid archetype is rejected', badText.indexOf('invalid archetype') !== -1);

  const noConfirm = await rpc(6, 'tools/call', { name: 'apply_labels', arguments: { rows: [{ id: '1:1' }] } });
  const noConfirmText = noConfirm.result?.content?.[0]?.text ?? '';
  check('apply_labels without confirm is refused', noConfirmText.indexOf('mutating') !== -1);

  const info = await rpc(4, 'tools/call', { name: 'server_info', arguments: {} });
  const infoText = info.result?.content?.[0]?.text ?? '';
  check('server_info answers ok', infoText.indexOf('"ok": true') !== -1);

  const health = await rpc(7, 'tools/call', { name: 'health_check', arguments: {} });
  const healthText = health.result?.content?.[0]?.text ?? '';
  check('health_check answers ok', healthText.indexOf('"ok": true') !== -1);

  const cats = await rpc(8, 'tools/call', { name: 'list_categories', arguments: {} });
  const catsText = cats.result?.content?.[0]?.text ?? '';
  check('list_categories answers ok', catsText.indexOf('"ok": true') !== -1);

  const badCat = await rpc(9, 'tools/call', { name: 'category_report', arguments: { category: '__non_existent_cat__' } });
  check('category_report rejects unknown category', badCat.result?.isError === true);

  const projs = await rpc(10, 'tools/call', { name: 'list_projects', arguments: {} });
  const projsText = projs.result?.content?.[0]?.text ?? '';
  check('list_projects answers ok', projsText.indexOf('"ok": true') !== -1);

  const cfgNoConfirm = await rpc(11, 'tools/call', { name: 'configure_project', arguments: { project: 'any' } });
  const cfgNoConfirmText = cfgNoConfirm.result?.content?.[0]?.text ?? '';
  check('configure_project without confirm is refused', cfgNoConfirmText.indexOf('mutating') !== -1);

  child.kill();

  console.log('');
  if (failures > 0) {
    console.log('RESULT: FAIL (' + failures + ')');
    process.exit(1);
  }
  console.log('RESULT: OK — MCP surface, constraints and annotations match the contract');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
