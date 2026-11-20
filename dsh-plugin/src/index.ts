/**
 * DSH plugin: slash commands for the Rea-FigmaDesign query layer.
 *
 * Commands run in the UI command plane — no model turn, no tokens. They spawn the
 * repo CLI with execFile (never a shell string) and report the result as text.
 *
 * Config (from cordis.patch.yml):
 *   root: absolute path to the Rea-FigmaDesign checkout
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'dsh-plugin-rea-figma';
export const inject = ['commands'];

interface PluginConfig {
  root?: string;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

function exec(bin: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 180000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: String(stdout ?? ''), err: String(stderr ?? '') });
    });
  });
}

function tail(text: string, lines: number): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

export function apply(ctx: { commands: { register: (def: Record<string, unknown>) => unknown } }, config: PluginConfig = {}): void {
  const root = config.root || process.env.REA_FIGMA_ROOT || '';
  const tsxCli = root ? join(root, 'node_modules/tsx/dist/cli.mjs') : '';
  const nodeBin = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].find((p) => existsSync(p)) ?? 'node';

  const requireRoot = (): string | null => (root ? null : 'Rea-FigmaDesign root is not configured: set config.root in cordis.patch.yml');

  ctx.commands.register({
    name: 'rea-figma-review',
    description: 'build the Rea-FigmaDesign review board and open it',
    recordInput: false,
    handler: async () => {
      const missing = requireRoot();
      if (missing) return { kind: 'error', text: missing };
      const res = await exec(nodeBin, [tsxCli, join(root, 'server/review-all.ts')], root);
      if (res.code !== 0) {
        return { kind: 'error', text: 'review failed (exit ' + res.code + '):\n' + tail(res.err || res.out, 12) };
      }
      const unique = /unique=(\d+)/.exec(res.out);
      const html = join(root, '.scratch/review.html');
      if (!existsSync(html)) return { kind: 'error', text: 'review.html was not written: ' + html };
      exec('/usr/bin/open', [html], root);
      return {
        kind: 'success',
        text: 'Review board ready' + (unique ? ' (' + unique[1] + ' unique screens)' : '') + ': ' + html,
      };
    },
  });

  ctx.commands.register({
    name: 'rea-figma-doctor',
    description: 'run the Rea-FigmaDesign preflight check',
    recordInput: false,
    handler: async () => {
      const missing = requireRoot();
      if (missing) return { kind: 'error', text: missing };
      const res = await exec(nodeBin, [tsxCli, join(root, 'server/doctor.ts')], root);
      const last = tail(res.out, 3);
      if (res.code !== 0) {
        return { kind: 'error', text: 'doctor failed (exit ' + res.code + ')\n' + last + (res.err ? '\n' + tail(res.err, 5) : '') };
      }
      return { kind: 'success', text: 'doctor OK\n' + last };
    },
  });
}
