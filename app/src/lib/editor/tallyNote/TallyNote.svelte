<!--
  집계(투표/퀴즈) 전용 노트 뷰.

  같은 노트를 모드에 따라 다르게 렌더:
  - 게스트(로그인 X): 보기를 라디오(단일)/체크박스(중복가능)로 골라 제출. 제출
    후엔 잠금 — 퀴즈 점수 + (결과 공개 시) 막대 차트.
  - 호스트(나): 실시간 결과 대시보드(막대 차트 + 정답률 + 투표자 수) + '결과 공개'
    토글 + 공유 안내 + Ctrl→편집(raw 토글).

  순수 뷰 — 노트 본문은 그대로. 표는 별도 Firestore polls/{guid} 에 산다
  (tallyClient). 1인 1표는 브라우저(익명 uid) 단위 soft 강제.
-->
<script lang="ts">
	import { mode } from '$lib/stores/guestMode.svelte.js';
	import { modKeys } from '$lib/desktop/modKeys.svelte.js';
	import {
		aggregate,
		scoreBallot,
		ensurePollMeta,
		setResultsPublic,
		subscribePollMeta,
		subscribeBallots,
		getMyBallot,
		castBallot,
		type TallySpec,
		type PollMeta,
		type Ballot
	} from '$lib/tally';
	import TallyResultChart from './TallyResultChart.svelte';

	let {
		spec,
		guid,
		onraw
	}: { spec: TallySpec; guid: string; onraw?: () => void } = $props();

	const isGuest = $derived(mode.value === 'guest');

	let meta = $state<PollMeta | null>(null);
	let ballots = $state<Ballot[]>([]);
	let myBallot = $state<Ballot | null>(null);
	let loadingMine = $state(true);

	// 게스트 진행 중 선택: 문제순번 → 보기 인덱스 배열.
	let picks = $state<Record<number, number[]>>({});
	let submitting = $state(false);
	let submitErr = $state<string | null>(null);
	let togglingPublic = $state(false);
	let copied = $state(false);

	// 공유 링크 — uid 가 아니라 노트 제목 기반(/poll/<제목>). 게스트는 이 링크로
	// 들어오면 제목→guid 로 풀려 같은 투표를 본다.
	const shareUrl = $derived(
		typeof window !== 'undefined' && spec.title
			? `${window.location.origin}/poll/${encodeURIComponent(spec.title)}`
			: ''
	);

	async function copyShareUrl(): Promise<void> {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* 클립보드 거부(권한/비보안 컨텍스트) — 사용자가 입력칸에서 직접 복사 */
		}
	}

	const resultsPublic = $derived(meta?.resultsPublic ?? false);
	const results = $derived(aggregate(spec, ballots));
	const voterCount = $derived(ballots.length);
	const hasVoted = $derived(!!myBallot);
	const myScore = $derived(myBallot ? scoreBallot(spec, myBallot.answers) : null);
	const allAnswered = $derived(
		spec.questions.length > 0 && spec.questions.every((q) => (picks[q.index]?.length ?? 0) > 0)
	);

	// 메타 구독(호스트·게스트 공통).
	$effect(() => {
		const g = guid;
		if (!g) return;
		return subscribePollMeta(g, (m) => (meta = m));
	});

	// 호스트: 메타 보장 후 표 실시간 집계. 메타가 없으면 ballot read rule 의
	// get(meta) 가 실패해 리스너가 죽으므로(이후 표가 안 보임), ensurePollMeta 를
	// 먼저 끝낸 뒤 구독한다.
	$effect(() => {
		const g = guid;
		if (!g || isGuest) return;
		let unsub: (() => void) | null = null;
		let cancelled = false;
		ensurePollMeta(g)
			.catch(() => {})
			.finally(() => {
				if (cancelled) return;
				unsub = subscribeBallots(g, (b) => (ballots = b));
			});
		return () => {
			cancelled = true;
			unsub?.();
		};
	});

	// 게스트: 내 표(이미 투표했는지) 로드.
	$effect(() => {
		const g = guid;
		if (!g || !isGuest) {
			loadingMine = false;
			return;
		}
		loadingMine = true;
		let cancelled = false;
		getMyBallot(g)
			.then((b) => {
				if (!cancelled) {
					myBallot = b;
					loadingMine = false;
				}
			})
			.catch(() => {
				if (!cancelled) loadingMine = false;
			});
		return () => {
			cancelled = true;
		};
	});

	// 게스트: 결과가 공개일 때만 표 구독(비공개면 권한 거부 → 빈 배열).
	$effect(() => {
		const g = guid;
		if (!g || !isGuest) return;
		if (!resultsPublic) {
			ballots = [];
			return;
		}
		return subscribeBallots(g, (b) => (ballots = b));
	});

	function isPicked(qi: number, oi: number): boolean {
		return (picks[qi] ?? []).includes(oi);
	}

	function pick(qi: number, oi: number, multi: boolean): void {
		const cur = picks[qi] ?? [];
		if (multi) {
			picks = { ...picks, [qi]: cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi] };
		} else {
			picks = { ...picks, [qi]: [oi] };
		}
	}

	async function submit(): Promise<void> {
		if (!allAnswered || submitting) return;
		submitting = true;
		submitErr = null;
		try {
			const answers: Record<number, number[]> = {};
			for (const q of spec.questions) {
				answers[q.index] = (picks[q.index] ?? []).slice().sort((a, b) => a - b);
			}
			await castBallot(guid, answers);
			myBallot = { voterUid: '', answers };
		} catch {
			submitErr = '제출에 실패했습니다. 이미 투표했거나 공유가 활성화되지 않았을 수 있습니다.';
		} finally {
			submitting = false;
		}
	}

	async function togglePublic(): Promise<void> {
		if (togglingPublic) return;
		togglingPublic = true;
		try {
			await setResultsPublic(guid, !resultsPublic);
		} catch {
			/* 토글 실패는 조용히 — 다음 메타 스냅샷이 실제 상태 반영 */
		} finally {
			togglingPublic = false;
		}
	}

	/** 게스트 제출 후: 내가 고른 보기인지 + 퀴즈 정/오답. */
	function mine(qi: number): number[] {
		return myBallot?.answers?.[qi] ?? [];
	}
</script>

<div class="tally-root">
	<header class="tally-header">
		<h1 class="tally-title">🗳 {spec.title || '집계'}</h1>
		{#if !isGuest}
			<span class="voter-count">투표 {voterCount}명</span>
		{/if}
		{#if onraw && modKeys.ctrl}
			<button class="raw-edit-btn" type="button" title="편집 (일반 노트로 보기)" onclick={() => onraw?.()}>
				✎ 편집
			</button>
		{/if}
	</header>

	{#if spec.questions.length === 0}
		<p class="tally-empty">
			문제가 없습니다.{#if !isGuest} 본문에 「질문 |중복가능|정답:N」 줄과 보기 리스트를 추가하세요 (Ctrl→편집).{/if}
		</p>
	{:else if isGuest}
		<!-- ── 게스트 ─────────────────────────────────────────── -->
		{#if loadingMine}
			<p class="tally-info">불러오는 중...</p>
		{:else if hasVoted}
			<div class="tally-done">✓ 제출 완료</div>
			{#if myScore && myScore.scored > 0}
				<div class="tally-score">퀴즈 점수: <strong>{myScore.correct}/{myScore.scored}</strong></div>
			{/if}
			{#each spec.questions as q (q.index)}
				<section class="q-block">
					<h2 class="q-text">{q.text || `문제 ${q.index + 1}`}</h2>
					<ul class="q-review">
						{#each q.options as opt, oi (oi)}
							{@const picked = mine(q.index).includes(oi)}
							{@const correct = q.correctIndex === oi}
							<li class="opt-review" class:picked class:correct class:wrong={picked && q.correctIndex !== null && !correct}>
								<span class="opt-mark">{picked ? '●' : '○'}</span>
								<span class="opt-label">{opt}</span>
								{#if q.correctIndex !== null && correct}<span class="opt-tag correct-tag">정답</span>{/if}
							</li>
						{/each}
					</ul>
					{#if resultsPublic}
						<TallyResultChart question={q} result={results[q.index]} />
						{#if results[q.index].correctRate !== null}
							<div class="rate">정답률 {Math.round(results[q.index].correctRate! * 100)}%</div>
						{/if}
					{/if}
				</section>
			{/each}
			{#if !resultsPublic}
				<p class="tally-info">결과는 비공개입니다. 주최자가 공개하면 여기에 표시됩니다.</p>
			{/if}
		{:else}
			<!-- 투표 폼 -->
			{#each spec.questions as q (q.index)}
				<section class="q-block">
					<h2 class="q-text">
						{q.text || `문제 ${q.index + 1}`}
						{#if q.allowMultiple}<span class="q-hint">(중복 선택 가능)</span>{/if}
					</h2>
					<ul class="q-options">
						{#each q.options as opt, oi (oi)}
							<li>
								<label class="opt" class:selected={isPicked(q.index, oi)}>
									<input
										type={q.allowMultiple ? 'checkbox' : 'radio'}
										name={`q-${guid}-${q.index}`}
										checked={isPicked(q.index, oi)}
										onchange={() => pick(q.index, oi, q.allowMultiple)}
									/>
									<span class="opt-label">{opt}</span>
								</label>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
			{#if submitErr}<p class="tally-err">{submitErr}</p>{/if}
			<button class="submit-btn" type="button" disabled={!allAnswered || submitting} onclick={submit}>
				{submitting ? '제출 중...' : '투표 제출'}
			</button>
			{#if !allAnswered}<p class="tally-info">모든 문제에 답해야 제출할 수 있습니다.</p>{/if}
		{/if}
	{:else}
		<!-- ── 호스트(나) ─────────────────────────────────────── -->
		{#if shareUrl}
			<div class="share-row">
				<span class="share-label">공유 링크</span>
				<input
					class="share-url"
					type="text"
					readonly
					value={shareUrl}
					onclick={(e) => e.currentTarget.select()}
				/>
				<button class="copy-btn" type="button" onclick={copyShareUrl}>
					{copied ? '복사됨 ✓' : '복사'}
				</button>
			</div>
		{/if}
		<div class="host-controls">
			<label class="public-toggle">
				<input type="checkbox" checked={resultsPublic} disabled={togglingPublic} onchange={togglePublic} />
				결과 공개 (모두에게 표시)
			</label>
		</div>
		<p class="tally-hint">
			다른 사람이 투표하려면 이 노트를 <strong>공유 노트북</strong>에 넣고(설정 → 공유) 공유 모드 규칙을 적용해야 합니다.
		</p>
		{#each spec.questions as q (q.index)}
			<section class="q-block">
				<h2 class="q-text">
					{q.text || `문제 ${q.index + 1}`}
					{#if q.allowMultiple}<span class="q-hint">(중복)</span>{/if}
					{#if q.correctIndex !== null}<span class="q-hint">· 정답: {q.options[q.correctIndex]}</span>{/if}
				</h2>
				<TallyResultChart question={q} result={results[q.index]} />
				<div class="q-stats">
					<span>응답 {results[q.index].total}명</span>
					{#if results[q.index].correctRate !== null}
						<span class="rate">정답률 {Math.round(results[q.index].correctRate! * 100)}%</span>
					{/if}
				</div>
			</section>
		{/each}
	{/if}
</div>

<style>
	.tally-root {
		max-width: 720px;
		margin: 0 auto;
		padding: 0.75rem 1rem 4rem;
		overflow-y: auto;
		height: 100%;
		box-sizing: border-box;
	}
	.tally-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}
	.tally-title {
		font-size: 1.25rem;
		font-weight: 700;
		margin: 0;
		flex: 1 1 auto;
		min-width: 0;
	}
	.voter-count {
		font-size: 0.85rem;
		color: var(--text-muted, #888);
		white-space: nowrap;
	}
	.raw-edit-btn {
		font-size: 0.8rem;
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--border-color, #ccc);
		border-radius: 6px;
		background: var(--bg-surface, #fff);
		cursor: pointer;
	}
	.q-block {
		margin: 1rem 0 1.5rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--border-color, #eee);
	}
	.q-text {
		font-size: 1.05rem;
		font-weight: 600;
		margin: 0 0 0.6rem;
	}
	.q-hint {
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-muted, #888);
		margin-left: 0.3rem;
	}
	.q-options,
	.q-review {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--border-color, #ddd);
		border-radius: 10px;
		cursor: pointer;
		transition: background 0.12s, border-color 0.12s;
	}
	.opt:hover {
		background: var(--bg-hover, #f5f5f5);
	}
	.opt.selected {
		border-color: #3b82f6;
		background: rgba(59, 130, 246, 0.08);
	}
	.opt input {
		margin: 0;
		flex: none;
	}
	.opt-label {
		flex: 1 1 auto;
		min-width: 0;
	}
	.opt-review {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--border-color, #eee);
		border-radius: 8px;
	}
	.opt-review.picked {
		font-weight: 600;
		border-color: #3b82f6;
		background: rgba(59, 130, 246, 0.06);
	}
	.opt-review.correct {
		border-color: #10b981;
		background: rgba(16, 185, 129, 0.08);
	}
	.opt-review.wrong {
		border-color: #ef4444;
		background: rgba(239, 68, 68, 0.07);
	}
	.opt-mark {
		flex: none;
		color: #3b82f6;
	}
	.opt-tag {
		font-size: 0.72rem;
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		flex: none;
	}
	.correct-tag {
		background: #10b981;
		color: #fff;
	}
	.submit-btn {
		width: 100%;
		padding: 0.85rem;
		font-size: 1rem;
		font-weight: 700;
		color: #fff;
		background: #3b82f6;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		margin-top: 0.5rem;
	}
	.submit-btn:disabled {
		background: var(--border-color, #ccc);
		cursor: not-allowed;
	}
	.tally-done {
		font-size: 1.1rem;
		font-weight: 700;
		color: #10b981;
		margin: 0.5rem 0;
	}
	.tally-score {
		font-size: 1rem;
		margin-bottom: 0.75rem;
	}
	.tally-info,
	.tally-hint,
	.tally-empty {
		font-size: 0.85rem;
		color: var(--text-muted, #888);
		margin: 0.5rem 0;
	}
	.tally-err {
		font-size: 0.85rem;
		color: #ef4444;
		margin: 0.5rem 0;
	}
	.share-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0;
		flex-wrap: wrap;
	}
	.share-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-muted, #777);
		flex: none;
	}
	.share-url {
		flex: 1 1 12rem;
		min-width: 0;
		padding: 0.45rem 0.6rem;
		font-size: 0.85rem;
		border: 1px solid var(--border-color, #ddd);
		border-radius: 8px;
		background: var(--bg-surface, #fafafa);
		color: inherit;
	}
	.copy-btn {
		flex: none;
		padding: 0.45rem 0.8rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: #fff;
		background: #3b82f6;
		border: none;
		border-radius: 8px;
		cursor: pointer;
	}
	.host-controls {
		margin: 0.5rem 0;
	}
	.public-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.95rem;
		cursor: pointer;
	}
	.q-stats {
		display: flex;
		gap: 1rem;
		font-size: 0.85rem;
		color: var(--text-muted, #888);
		margin-top: 0.4rem;
	}
	.rate {
		color: #10b981;
		font-weight: 600;
	}
</style>
