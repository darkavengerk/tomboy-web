<script lang="ts">
	import type { DiaryDetail } from '$lib/bridgeStatus/statusClient.js';

	let { detail }: { detail: DiaryDetail } = $props();

	const STALE_WARN = 30;
	const STALE_CRIT = 180;

	let staleClass = $derived.by(() => {
		const m = detail.inbox.stale_minutes;
		if (m == null) return 'idle';
		if (m >= STALE_CRIT) return 'crit';
		if (m >= STALE_WARN) return 'warn';
		return 'ok';
	});

	let maxFolder = $derived(Math.max(1, ...detail.inbox.per_folder.map((f) => f.count)));

	function fmtAgo(min: number | null): string {
		if (min == null) return '데이터 없음';
		if (min < 60) return `${min}분 전`;
		const h = Math.floor(min / 60);
		if (h < 24) return `${h}시간 ${min % 60}분 전`;
		return `${Math.floor(h / 24)}일 전`;
	}
	function fmtDateTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return String(iso);
		const p = (n: number) => String(n).padStart(2, '0');
		return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	const RESULT_LABEL: Record<string, string> = {
		success: '✅ 성공',
		failed: '❌ 실패',
		running: '⏳ 실행 중',
		unknown: '· 알 수 없음'
	};
</script>

<div class="diary-detail">
	<section>
		<h3>📥 Push 신선도</h3>
		<div class="stale-badge {staleClass}">
			마지막 도착 {fmtAgo(detail.inbox.stale_minutes)}
			{#if staleClass === 'crit'}· ⚠ 정체 의심{/if}
			{#if staleClass === 'warn'}· 지연{/if}
		</div>
		<p class="sub">
			inbox {detail.inbox.count}개 · 최근 {fmtDateTime(detail.inbox.newest_mtime)}
		</p>
		{#if detail.inbox.error}<p class="muted">{detail.inbox.error}</p>{/if}
	</section>

	<section>
		<h3>🗂 폴더별 backlog</h3>
		{#if detail.inbox.per_folder.length === 0}
			<p class="muted">대기 페이지 없음</p>
		{:else}
			<ul class="bars">
				{#each detail.inbox.per_folder as f (f.folder)}
					<li>
						<span class="flabel">{f.folder}</span>
						<span class="track">
							<span class="folder-bar" style="width: {(f.count / maxFolder) * 100}%"></span>
						</span>
						<span class="fcount">{f.count}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h3>🧠 마지막 OCR 실행</h3>
		{#if detail.ocr.status === 'unconfigured'}
			<p class="muted">trigger 서버 미설정 — inbox 신선도만 표시됩니다.</p>
		{:else if detail.ocr.status === 'unreachable'}
			<p class="muted">trigger 서버에 연결할 수 없습니다.</p>
		{:else}
			<table class="ocr">
				<tbody>
					<tr><th>결과</th><td>{RESULT_LABEL[detail.ocr.result ?? 'unknown']}</td></tr>
					<tr><th>시각</th><td>{fmtDateTime(detail.ocr.last_run_at)}</td></tr>
					<tr><th>exit</th><td>{detail.ocr.exit_code ?? '—'}</td></tr>
					{#if detail.ocr.summary}<tr><th>요약</th><td>{detail.ocr.summary}</td></tr>{/if}
				</tbody>
			</table>
			{#if detail.ocr.log_tail}
				<details><summary>로그 꼬리</summary><pre>{detail.ocr.log_tail}</pre></details>
			{/if}
		{/if}
	</section>
</div>

<style>
	.diary-detail { display: flex; flex-direction: column; gap: 1.1rem; }
	section h3 { margin: 0 0 0.4rem; font-size: 0.95rem; }
	.stale-badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 0.5rem; font-weight: 600; }
	.stale-badge.ok { background: #1f7a3f22; color: #1f7a3f; }
	.stale-badge.warn { background: #b9770022; color: #b97700; }
	.stale-badge.crit { background: #b3261e22; color: #b3261e; }
	.stale-badge.idle { background: #8884; color: #666; }
	.sub { margin: 0.35rem 0 0; font-size: 0.85rem; color: #555; }
	.muted { color: #888; font-size: 0.85rem; }
	.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
	.bars li { display: grid; grid-template-columns: 5.5rem 1fr 2rem; align-items: center; gap: 0.5rem; }
	.flabel { font-size: 0.85rem; }
	.track { background: #8882; border-radius: 0.4rem; height: 0.9rem; overflow: hidden; }
	.folder-bar { display: block; height: 100%; background: #3b6cb7; border-radius: 0.4rem; min-width: 2px; }
	.fcount { text-align: right; font-variant-numeric: tabular-nums; }
	table.ocr { border-collapse: collapse; font-size: 0.85rem; }
	table.ocr th { text-align: left; color: #666; padding: 0.15rem 0.8rem 0.15rem 0; font-weight: 500; }
	details pre { background: #1112; padding: 0.5rem; border-radius: 0.4rem; overflow: auto; font-size: 0.78rem; max-height: 12rem; }
</style>
