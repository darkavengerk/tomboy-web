import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = typeof nodeSpawn;

export interface RemarkableSshConfig {
  host: string;
  user: string;
  keyPath: string;
}

export interface RemarkableMetadata {
  uuid: string;
  type: string;
  visibleName: string;
  parent: string;
  lastModified: number; // epoch ms; 0 if unknown
}

const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

/**
 * SSH into rmrk and `cat` every metadata file, separated by `===<uuid>.metadata===`
 * lines. Returns the raw stdout for parseMetadataDump to consume.
 */
export async function fetchMetadataDump(
  cfg: RemarkableSshConfig,
  opts: { spawn?: SpawnFn; maxStdoutBytes?: number } = {}
): Promise<string> {
  const spawn = opts.spawn ?? nodeSpawn;
  const remoteCmd = `cd ${XOCHITL_DIR} && for f in *.metadata; do echo "===$f==="; cat "$f"; done`;
  const args = [
    '-p', '22',
    '-i', cfg.keyPath,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=5',
    `${cfg.user}@${cfg.host}`,
    remoteCmd
  ];
  return await runCapture(spawn, 'ssh', args, { maxStdoutBytes: opts.maxStdoutBytes });
}

/**
 * Parse the metadata dump into a flat list. Malformed JSON entries are
 * silently skipped (defensive — xochitl may have transient writes).
 */
export function parseMetadataDump(dump: string): RemarkableMetadata[] {
  const out: RemarkableMetadata[] = [];
  const lines = dump.split('\n');
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const m = /^===(.+)\.metadata===$/.exec(header);
    if (!m) {
      i++;
      continue;
    }
    const uuid = m[1];
    // Body is the next consecutive lines until the next ===…=== or EOF.
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^===.+===$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    try {
      const json = JSON.parse(body.join('\n')) as Partial<RemarkableMetadata> & {
        lastModified?: string | number;
      };
      out.push({
        uuid,
        type: String(json.type ?? ''),
        visibleName: String(json.visibleName ?? ''),
        parent: String(json.parent ?? ''),
        lastModified: Number(json.lastModified ?? 0)
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * rsync `<uuid>.*` from rmrk to local dest.
 */
export async function rsyncPage(
  cfg: RemarkableSshConfig,
  uuid: string,
  destDir: string,
  opts: { spawn?: SpawnFn } = {}
): Promise<void> {
  const spawn = opts.spawn ?? nodeSpawn;
  const sshCmd = `ssh -p 22 -i ${cfg.keyPath} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5`;
  const remote = `${cfg.user}@${cfg.host}:${XOCHITL_DIR}/${uuid}.*`;
  const args = ['-avz', '-e', sshCmd, remote, `${destDir}/`];
  await runCapture(spawn, 'rsync', args);
}

export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export interface RunCaptureOpts {
  maxStdoutBytes?: number;
}

function runCapture(spawn: SpawnFn, cmd: string, args: string[], opts: RunCaptureOpts = {}): Promise<string> {
  const limit = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let outSize = 0;
    let errOut = '';
    child.stdout?.on('data', (d: Buffer) => {
      if (settled) return;
      outSize += d.length;
      if (outSize > limit) {
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        reject(new Error(`${cmd} stdout exceeded ${limit} bytes`));
        return;
      }
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errOut.length < 8192) errOut += d.toString('utf8');
    });
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(out);
      else reject(new Error(errOut.trim().slice(0, 400) || `${cmd} exit ${code}`));
    });
  });
}
