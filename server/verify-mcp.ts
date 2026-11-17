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
  check('tools/list advertises 11 tools', tools.length === 11, String(tools.length));

  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const required of ['list_screens', 'screen_sheet', 'screen_family', 'apply_labels', 'server_info']) {
    check('tool present: ' + required, byName.has(required));
  }

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

  const info = await rpc(4, 'tools/call', { name: 'server_info', arguments: {} });
  const infoText = info.result?.content?.[0]?.text ?? '';
  check('server_info answers ok', infoText.indexOf('"ok": true') !== -1);

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
