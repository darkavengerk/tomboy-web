#!/usr/bin/env node
// Dev-only sync script. Run from inside `app/` after each `/graphify app/src`.
//   node scripts/sync-codegraph.mjs
// Copies graphify-out/graph.json verbatim into static/codegraph.json,
// derives static/codegraph-meta.json from git remote/branch, and parses
// graphify-out/GRAPH_REPORT.md community headers into
// static/codegraph-communities.json.

import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// scripts/ is inside app/, so app root is one level up.
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..');
const SRC_GRAPH = resolve(REPO_ROOT, 'graphify-out/graph.json');
const SRC_REPORT = resolve(REPO_ROOT, 'graphify-out/GRAPH_REPORT.md');
const OUT_DIR = resolve(APP_ROOT, 'static');
const OUT_GRAPH = resolve(OUT_DIR, 'codegraph.json');
const OUT_META = resolve(OUT_DIR, 'codegraph-meta.json');
const OUT_COMMUNITIES = resolve(OUT_DIR, 'codegraph-communities.json');

/**
 * Normalize SSH/HTTPS git remote URL to https://github.com/<owner>/<repo>.
 * @param {string} remoteUrl
 * @returns {string}
 */
export function normalizeRepoUrl(remoteUrl) {
	let url = String(remoteUrl).trim();
	const sshMatch = url.match(/^git@github\.com:(.+)$/);
	if (sshMatch) {
		url = `https://github.com/${sshMatch[1]}`;
	}
	if (url.endsWith('.git')) {
		url = url.slice(0, -4);
	}
	return url;
}

/**
 * Parse community labels out of graphify's GRAPH_REPORT.md.
 *
 * Primary format (current graphify output):
 *   ### Community 0 - "Home Note & Misc Utils"
 *
 * Fallback format (graceful degradation if graphify ever switches):
 *   ### Community 0: Home Note & Misc Utils
 *
 * Returns a `{ [communityId: string]: label }` map. Returns `{}` when no
 * matching headers are found.
 * @param {string} reportText
 * @returns {Record<string, string>}
 */
export function parseCommunityLabels(reportText) {
	/** @type {Record<string, string>} */
	const result = {};
	if (!reportText) return result;
	const lines = String(reportText).split(/\r?\n/);
	const dashQuoted = /^### Community (\d+)\s*-\s*"(.+)"\s*$/;
	const colonForm = /^### Community (\d+)\s*:\s*(.+?)\s*$/;
	for (const line of lines) {
		const m1 = line.match(dashQuoted);
		if (m1) {
			result[m1[1]] = m1[2];
			continue;
		}
		const m2 = line.match(colonForm);
		if (m2) {
			result[m2[1]] = m2[2];
		}
	}
	return result;
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

function resolveBranch() {
	try {
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			encoding: 'utf8',
			cwd: REPO_ROOT
		}).trim();
		if (!branch || branch === 'HEAD') return 'main';
		return branch;
	} catch {
		return 'main';
	}
}

function resolveRepoUrl() {
	const raw = execSync('git config --get remote.origin.url', {
		encoding: 'utf8',
		cwd: REPO_ROOT
	}).trim();
	return normalizeRepoUrl(raw);
}

async function main() {
	if (!(await pathExists(SRC_GRAPH))) {
		console.error("graphify가 아직 실행되지 않았습니다 — '/graphify app/src'를 먼저 돌려주세요");
		process.exit(1);
	}

	// 1. Verbatim byte-for-byte copy of graph.json.
	await copyFile(SRC_GRAPH, OUT_GRAPH);

	// 2. Read graph back to count nodes/links for the meta sidecar.
	//    (Reading the file we just copied means we agree with what's served.)
	const graphRaw = await readFile(SRC_GRAPH, 'utf8');
	const graph = JSON.parse(graphRaw);
	const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
	const linkCount = Array.isArray(graph.links) ? graph.links.length : 0;

	// 3. Git-derived meta.
	const repoUrl = resolveRepoUrl();
	const branch = resolveBranch();
	const meta = {
		repoUrl,
		branch,
		syncedAt: new Date().toISOString(),
		nodeCount,
		linkCount
	};
	await writeFile(OUT_META, JSON.stringify(meta, null, 2) + '\n', 'utf8');

	// 4. Community labels (optional; empty map if report missing or no matches).
	let communities = {};
	if (await pathExists(SRC_REPORT)) {
		const reportText = await readFile(SRC_REPORT, 'utf8');
		communities = parseCommunityLabels(reportText);
	}
	await writeFile(OUT_COMMUNITIES, JSON.stringify(communities, null, 2) + '\n', 'utf8');

	console.log(
		`codegraph synced: ${nodeCount} nodes, ${linkCount} links → static/codegraph*.json`
	);
}

main().catch((err) => {
	console.error(err && err.message ? err.message : err);
	process.exit(1);
});
