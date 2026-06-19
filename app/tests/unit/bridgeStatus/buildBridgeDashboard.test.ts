import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { buildBridgeDashboardNodes, _internal } from '$lib/bridgeStatus/buildBridgeDashboard.js';
import type { BridgeStatus } from '$lib/bridgeStatus/statusClient.js';

const GiB = 1024 ** 3;

const STATUS: BridgeStatus = {
	fetched_at: '2026-06-19T01:48:00.000Z',
	system: {
		uptime_s: 1054800,
		load: [0.4, 0.3, 0.2],
		cpu_count: 4,
		cpu_temp_c: 48.2,
		mem_total_bytes: 4 * GiB,
		mem_used_bytes: 1.2 * GiB
	},
	disks: [
		{ mount: '/files', size_bytes: 28 * GiB, used_bytes: 6 * GiB, avail_bytes: 22 * GiB, use_pct: 22 },
		{ mount: '/(루트)', size_bytes: 16 * GiB, used_bytes: 4 * GiB, avail_bytes: 12 * GiB, use_pct: 26 }
	],
	services: [
		{ name: 'ocr', status: 'up', latency_ms: 42 },
		{ name: 'music', status: 'up', latency_ms: 55 },
		{ name: 'automation', status: 'unconfigured', latency_ms: null },
		{ name: 'rag', status: 'down', latency_ms: null }
	],
	files: { count: 37, total_bytes: 6 * GiB, latest_mtime: '2026-06-19T01:48:00.000Z' },
	connections: { spectator_sessions: 1, folder_cache: 3, hosts_ssh: 4, hosts_remarkable: 1, hosts_wol: 2 },
	bridge: { port: 3000, uptime_s: 432000, node: 'v22.0.0', public_host: 'bridge.example' }
};

let ed: Editor;
afterEach(() => ed?.destroy());

function schema(): Schema {
	ed = new Editor({ extensions: [StarterKit] });
	return ed.state.schema;
}

function lines(nodes: PMNode[]): string[] {
	return nodes.map((n) => n.textContent);
}

describe('buildBridgeDashboardNodes', () => {
	it('5개 섹션 헤더를 모두 그린다', () => {
		const s = schema();
		const ls = lines(buildBridgeDashboardNodes(s, STATUS));
		expect(ls).toContain('🖥 시스템');
		expect(ls).toContain('🔌 서비스');
		expect(ls).toContain('🗂 파일 저장소');
		expect(ls).toContain('🛰 연결·구성');
		expect(ls).toContain('⚙ 브릿지');
	});

	it('섹션 사이에 --- 구분선 4개', () => {
		const s = schema();
		const dividers = buildBridgeDashboardNodes(s, STATUS).filter((n) => n.textContent === '---');
		expect(dividers).toHaveLength(4);
	});

	it('디스크/서비스 csv 펜스 블록 2개', () => {
		const s = schema();
		const ls = lines(buildBridgeDashboardNodes(s, STATUS));
		expect(ls.filter((l) => l === '```csv')).toHaveLength(2);
		expect(ls.filter((l) => l === '```')).toHaveLength(2);
		expect(ls).toContain('마운트,용량,사용,여유,사용률');
		expect(ls).toContain('/files,28GB,6GB,22GB,22%');
	});

	it('서비스 상태가 글리프+지연으로 행이 된다', () => {
		const s = schema();
		const ls = lines(buildBridgeDashboardNodes(s, STATUS));
		expect(ls).toContain('서비스,상태,응답');
		expect(ls).toContain('ocr,✅,42ms');
		expect(ls).toContain('automation,➖ 미설정,');
		expect(ls).toContain('rag,❌ 끊김,');
	});

	it('섹션 헤더는 bold 마크가 붙는다', () => {
		const s = schema();
		const nodes = buildBridgeDashboardNodes(s, STATUS);
		const header = nodes.find((n) => n.textContent === '🖥 시스템');
		expect(header).toBeDefined();
		const inline = header!.firstChild;
		expect(inline?.marks.some((m) => m.type.name === 'bold')).toBe(true);
	});

	it('시스템/연결 요약 텍스트', () => {
		const s = schema();
		const ls = lines(buildBridgeDashboardNodes(s, STATUS));
		expect(ls.some((l) => l.includes('가동 12일') && l.includes('온도 48.2°C'))).toBe(true);
		expect(ls.some((l) => l.includes('메모리') && l.includes('(30%)'))).toBe(true);
		expect(ls.some((l) => l.includes('호스트 — 터미널 4 · 리마커블 1 · WOL 2'))).toBe(true);
		expect(ls.some((l) => l.includes('포트 3000') && l.includes('node v22.0.0'))).toBe(true);
	});

	it('필드 누락/형식 오류에도 throw 하지 않는다', () => {
		const s = schema();
		const nodes = buildBridgeDashboardNodes(s, {} as BridgeStatus);
		expect(nodes.length).toBeGreaterThan(0);
		const ls = lines(nodes);
		expect(ls).toContain('🖥 시스템');
		expect(ls).toContain('🔌 서비스'); // 빈 서비스라도 헤더+빈 표
	});
});

describe('포맷터(_internal)', () => {
	it('fmtBytes', () => {
		expect(_internal.fmtBytes(0)).toBe('0B');
		expect(_internal.fmtBytes(512)).toBe('512B');
		expect(_internal.fmtBytes(1536)).toBe('1.5KB');
		expect(_internal.fmtBytes(6 * GiB)).toBe('6GB');
		expect(_internal.fmtBytes(-1)).toBe('—');
	});
	it('fmtDuration', () => {
		expect(_internal.fmtDuration(1054800)).toBe('12일 5시간');
		expect(_internal.fmtDuration(3700)).toBe('1시간 1분');
		expect(_internal.fmtDuration(120)).toBe('2분');
		expect(_internal.fmtDuration(-5)).toBe('—');
	});
	it('statusGlyph', () => {
		expect(_internal.statusGlyph({ name: 'x', status: 'up', latency_ms: 1 })).toBe('✅');
		expect(_internal.statusGlyph({ name: 'x', status: 'unconfigured', latency_ms: null })).toBe('➖ 미설정');
		expect(_internal.statusGlyph({ name: 'x', status: 'down', latency_ms: null })).toBe('❌ 끊김');
	});
});
