#!/usr/bin/env node
// Deploys the bridge: SSHes into the bridge host and rebuilds + restarts
// the Podman/Quadlet unit. Run via `npm run deploy` from bridge/.
//
// Reads connection options from bridge/.env (loaded via `node --env-file`).
// See bridge/.env.example for the variables.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = resolve(here, '..');
const envFile = resolve(bridgeDir, '.env');

// Minimal .env loader (KEY=VALUE, # comments, optional quotes). Existing
// process.env values win, so CLI overrides like `BRIDGE_DEPLOY_HOST=x npm
// run deploy` still work.
if (existsSync(envFile)) {
	for (const raw of readFileSync(envFile, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (!(key in process.env)) process.env[key] = val;
	}
}

const host = process.env.BRIDGE_DEPLOY_HOST;
if (!host) {
	console.error('error: BRIDGE_DEPLOY_HOST is not set.');
	if (!existsSync(envFile)) {
		console.error(`hint: copy bridge/.env.example to bridge/.env and fill it in.`);
	}
	process.exit(1);
}

const port = process.env.BRIDGE_DEPLOY_PORT;
const keyFile = process.env.BRIDGE_DEPLOY_KEY;
const remotePath = process.env.BRIDGE_DEPLOY_PATH || '~/tomboy-web/bridge';
const branch = process.env.BRIDGE_DEPLOY_BRANCH; // optional, e.g. main
const imageTag = process.env.BRIDGE_DEPLOY_IMAGE_TAG || 'term-bridge:latest';
const containerUnit = process.env.BRIDGE_DEPLOY_CONTAINER_UNIT || 'term-bridge.container';
const serviceName = process.env.BRIDGE_DEPLOY_SERVICE || 'term-bridge.service';
const extraSshArgs = (process.env.BRIDGE_DEPLOY_SSH_ARGS || '').trim();

const pullCmd = branch ? `git pull --ff-only origin ${branch}` : 'git pull --ff-only';

const remoteScript = [
	`set -euo pipefail`,
	`cd ${remotePath}`,
	pullCmd,
	`podman build -t ${imageTag} .`,
	`mkdir -p ~/.config/containers/systemd`,
	`cp deploy/${containerUnit} ~/.config/containers/systemd/`,
	`systemctl --user daemon-reload`,
	`systemctl --user restart ${serviceName}`,
	`systemctl --user --no-pager status ${serviceName} | head -n 20`,
].join(' && ');

const sshArgs = [];
if (port) sshArgs.push('-p', port);
if (keyFile) sshArgs.push('-i', keyFile);
if (extraSshArgs) sshArgs.push(...extraSshArgs.split(/\s+/));
sshArgs.push(host, 'bash', '-lc', remoteScript);

console.log(`→ ssh ${host}${port ? ` -p ${port}` : ''}  (path: ${remotePath})`);
const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
	if (signal) {
		console.error(`ssh terminated by signal ${signal}`);
		process.exit(1);
	}
	process.exit(code ?? 1);
});
child.on('error', (err) => {
	console.error(`failed to spawn ssh: ${err.message}`);
	process.exit(1);
});
