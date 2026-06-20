import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { writeBridgeDashboard } from '$lib/bridgeStatus/writeBridgeDashboard.js';
import type { BridgeStatus } from '$lib/bridgeStatus/statusClient.js';

const GiB = 1024 ** 3;
const STATUS: BridgeStatus = {
	fetched_at: '2026-06-19T01:48:00.000Z',
	system: { uptime_s: 1000, load: [0.1, 0.2, 0.3], cpu_count: 4, cpu_temp_c: null, mem_total_bytes: 4 * GiB, mem_used_bytes: GiB },
	disks: [{ mount: '/files', size_bytes: 10 * GiB, used_bytes: GiB, avail_bytes: 9 * GiB, use_pct: 10 }],
	services: [{ name: 'ocr', status: 'up', latency_ms: 5 }],
	files: { count: 2, total_bytes: GiB, latest_mtime: null },
	connections: { spectator_sessions: 0, folder_cache: 0, hosts_ssh: 1, hosts_remarkable: 0, hosts_wol: 0 },
	bridge: { port: 3000, uptime_s: 60, node: 'v22', public_host: 'b.ex' }
};

let ed: Editor;
afterEach(() => ed?.destroy());

describe('writeBridgeDashboard', () => {
	it('제목은 두고 본문을 대시보드로 교체', () => {
		ed = new Editor({
			extensions: [StarterKit],
			content: `<p>브릿지::현황</p><p>오래된 본문</p><ul><li><p>쓰레기</p></li></ul>`
		});
		const ok = writeBridgeDashboard(ed.view, STATUS);
		expect(ok).toBe(true);
		// 제목 보존.
		expect(ed.state.doc.firstChild?.textContent).toBe('브릿지::현황');
		const text = ed.state.doc.textContent;
		// 옛 본문 제거.
		expect(text).not.toContain('오래된 본문');
		expect(text).not.toContain('쓰레기');
		// 대시보드 삽입.
		expect(text).toContain('🖥 시스템');
		expect(text).toContain('🔌 서비스');
		expect(text).toContain('⚙ 브릿지');
	});

	it('두 번 호출해도 한 벌만 남는다(멱등 교체)', () => {
		ed = new Editor({ extensions: [StarterKit], content: `<p>브릿지::x</p>` });
		writeBridgeDashboard(ed.view, STATUS);
		writeBridgeDashboard(ed.view, STATUS);
		const headers = ed.state.doc.textContent.match(/🖥 시스템/g) ?? [];
		expect(headers).toHaveLength(1);
		expect(ed.state.doc.firstChild?.textContent).toBe('브릿지::x');
	});

	it('파괴된 view → false (no-op)', () => {
		ed = new Editor({ extensions: [StarterKit], content: `<p>브릿지::x</p>` });
		const view = ed.view;
		ed.destroy();
		expect(writeBridgeDashboard(view, STATUS)).toBe(false);
	});
});
