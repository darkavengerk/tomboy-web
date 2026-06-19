import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { BridgeStatus, ServiceProbe, DiskInfo } from './statusClient.js';

/**
 * BridgeStatus → 에디터 블록 노드 배열(스냅샷 본문).
 *
 * 섹션은 `---` 한 줄(가로 구분선, 전 브라우저 안전)로 나눈다. 표는 ```csv 펜스
 * 블록(에디터가 표로 렌더). 섹션 제목은 heading 대신 **굵은 단락** — heading 은
 * .note 라운드트립에서 단락으로 납작해지지만(아카이버가 heading 태그 미emit),
 * bold 마크는 그대로 보존되어 동기화 후에도 모양이 유지된다.
 *
 * 모든 게터는 방어적 — 필드가 없거나 형식이 어긋나도 throw 하지 않는다.
 */

function fmtBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n < 1024) return `${n}B`;
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}

function fmtDuration(s: number): string {
	if (!Number.isFinite(s) || s < 0) return '—';
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}일 ${h}시간`;
	if (h > 0) return `${h}시간 ${m}분`;
	return `${m}분`;
}

function fmtDateTime(iso: string | null): string {
	if (!iso) return '—';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusGlyph(s: ServiceProbe): string {
	if (s.status === 'up') return '✅';
	if (s.status === 'unconfigured') return '➖ 미설정';
	return '❌ 끊김';
}

// ── 노드 빌더 ──────────────────────────────────────────────────────────────

function para(schema: Schema, text: string): PMNode {
	const p = schema.nodes.paragraph;
	return text ? p.create(null, schema.text(text)) : p.create();
}

function boldPara(schema: Schema, text: string): PMNode {
	const boldMark = schema.marks.bold ?? schema.marks.strong;
	const marks = boldMark ? [boldMark.create()] : [];
	return schema.nodes.paragraph.create(null, schema.text(text, marks));
}

function divider(schema: Schema): PMNode {
	return schema.nodes.paragraph.create(null, schema.text('---'));
}

/** ```csv … ``` 펜스 블록(에디터가 표로 렌더). 값에 쉼표가 없도록 호출 측이 보장. */
function csvBlock(schema: Schema, lines: string[]): PMNode[] {
	return [para(schema, '```csv'), ...lines.map((l) => para(schema, l)), para(schema, '```')];
}

// ── 섹션 ───────────────────────────────────────────────────────────────────

function systemSection(schema: Schema, s: BridgeStatus): PMNode[] {
	const sys = s.system ?? ({} as BridgeStatus['system']);
	const load = Array.isArray(sys.load) ? sys.load.join(' / ') : '—';
	const temp = typeof sys.cpu_temp_c === 'number' ? ` · 온도 ${sys.cpu_temp_c}°C` : '';
	const memPct =
		sys.mem_total_bytes > 0 ? Math.round((sys.mem_used_bytes / sys.mem_total_bytes) * 100) : 0;
	const out: PMNode[] = [
		boldPara(schema, '🖥 시스템'),
		para(
			schema,
			`가동 ${fmtDuration(sys.uptime_s)} · 부하 ${load} · 코어 ${sys.cpu_count ?? '—'}${temp}`
		),
		para(
			schema,
			`메모리 ${fmtBytes(sys.mem_used_bytes)} / ${fmtBytes(sys.mem_total_bytes)} (${memPct}%)`
		)
	];
	const disks = Array.isArray(s.disks) ? s.disks : [];
	if (disks.length > 0) {
		const rows = disks.map(
			(d: DiskInfo) =>
				`${d.mount},${fmtBytes(d.size_bytes)},${fmtBytes(d.used_bytes)},${fmtBytes(d.avail_bytes)},${d.use_pct}%`
		);
		out.push(...csvBlock(schema, ['마운트,용량,사용,여유,사용률', ...rows]));
	}
	return out;
}

function servicesSection(schema: Schema, s: BridgeStatus): PMNode[] {
	const services = Array.isArray(s.services) ? s.services : [];
	const rows = services.map((p) => {
		const latency = p.status === 'up' && typeof p.latency_ms === 'number' ? `${p.latency_ms}ms` : '';
		return `${p.name},${statusGlyph(p)},${latency}`;
	});
	return [
		boldPara(schema, '🔌 서비스'),
		...csvBlock(schema, ['서비스,상태,응답', ...rows])
	];
}

function filesSection(schema: Schema, s: BridgeStatus): PMNode[] {
	const f = s.files ?? { count: 0, total_bytes: 0, latest_mtime: null };
	return [
		boldPara(schema, '🗂 파일 저장소'),
		para(
			schema,
			`파일 ${f.count ?? 0}개 · ${fmtBytes(f.total_bytes ?? 0)} · 최근 ${fmtDateTime(f.latest_mtime)}`
		)
	];
}

function connectionsSection(schema: Schema, s: BridgeStatus): PMNode[] {
	const c =
		s.connections ??
		({
			spectator_sessions: 0,
			folder_cache: 0,
			hosts_ssh: 0,
			hosts_remarkable: 0,
			hosts_wol: 0
		} as BridgeStatus['connections']);
	return [
		boldPara(schema, '🛰 연결·구성'),
		para(schema, `스펙테이터 세션 ${c.spectator_sessions ?? 0} · 폴더 캐시 ${c.folder_cache ?? 0}`),
		para(
			schema,
			`호스트 — 터미널 ${c.hosts_ssh ?? 0} · 리마커블 ${c.hosts_remarkable ?? 0} · WOL ${c.hosts_wol ?? 0}`
		)
	];
}

function bridgeSection(schema: Schema, s: BridgeStatus): PMNode[] {
	const b = s.bridge ?? ({} as BridgeStatus['bridge']);
	return [
		boldPara(schema, '⚙ 브릿지'),
		para(
			schema,
			`${b.public_host ?? '—'} · 포트 ${b.port ?? '—'} · 프로세스 가동 ${fmtDuration(b.uptime_s)} · node ${b.node ?? '—'}`
		),
		para(schema, `갱신 ${fmtDateTime(s.fetched_at)}`)
	];
}

/** 전체 대시보드 본문 노드(제목 아래에 들어갈 블록들). 섹션 사이에 `---`. */
export function buildBridgeDashboardNodes(schema: Schema, status: BridgeStatus): PMNode[] {
	const sections = [
		systemSection(schema, status),
		servicesSection(schema, status),
		filesSection(schema, status),
		connectionsSection(schema, status),
		bridgeSection(schema, status)
	];
	const out: PMNode[] = [];
	sections.forEach((sec, i) => {
		if (i > 0) out.push(divider(schema));
		out.push(...sec);
	});
	return out;
}

// 포맷터는 테스트에서 단독 검증 가능하도록 노출.
export const _internal = { fmtBytes, fmtDuration, fmtDateTime, statusGlyph };
