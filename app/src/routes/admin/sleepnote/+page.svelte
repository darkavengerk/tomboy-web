<script lang="ts">
	import {
		validateSlipBox,
		type ValidationSummary,
		type ChainResult,
		type SlipNoteCheckResult,
		type SlipField,
		type SectionHeading
	} from '$lib/sleepnote/validator.js';
	import { pushToast } from '$lib/stores/toast.js';

	interface ProblemRow {
		guid: string;
		title: string;
		section: SectionHeading;
		headTitle: string;
		isHead: boolean;
		isTail: boolean;
		prev?: SlipField;
		next?: SlipField;
		issues: { code: string; message: string }[];
	}

	interface ChainIssueRow {
		section: SectionHeading;
		headTitle: string;
		message: string;
	}

	let running = $state(false);
	let summary = $state<ValidationSummary | null>(null);
	let error = $state<string | null>(null);

	async function runCheck() {
		if (running) return;
		running = true;
		error = null;
		try {
			summary = await validateSlipBox();
			const s = summary.stats;
			pushToast(
				`검사 완료: 검증 ${s.notesValidated}개 · 문제 ${s.notesWithIssues}개`,
				{ kind: s.notesWithIssues > 0 ? 'error' : 'info' }
			);
		} catch (e) {
			error = String(e);
			pushToast('검사 실패: ' + error, { kind: 'error' });
		} finally {
			running = false;
		}
	}

	function collectProblemRows(s: ValidationSummary): ProblemRow[] {
		const out: ProblemRow[] = [];
		for (const chain of s.chains) {
			for (const node of chain.nodes) {
				if (node.result.issues.length === 0) continue;
				out.push({
					guid: node.result.guid,
					title: node.result.title,
					section: chain.head.section,
					headTitle: chain.head.title,
					isHead: node.isHead,
					isTail: node.isTail,
					prev: node.result.prev,
					next: node.result.next,
					issues: node.result.issues
				});
			}
		}
		return out;
	}

	function collectChainIssues(s: ValidationSummary): ChainIssueRow[] {
		const out: ChainIssueRow[] = [];
		for (const chain of s.chains) {
			for (const msg of chain.chainIssues) {
				out.push({
					section: chain.head.section,
					headTitle: chain.head.title,
					message: msg
				});
			}
		}
		return out;
	}

	function hasAnyIssues(s: ValidationSummary): boolean {
		if (!s.indexFound) return true;
		if (s.chains.some((c) => c.chainIssues.length > 0)) return true;
		if (s.chains.some((c) => c.nodes.some((n) => n.result.issues.length > 0))) return true;
		if (s.unreachableSlipBoxNotes.length > 0) return true;
		return false;
	}

	function fieldDesc(f: SlipNoteCheckResult['prev']): string {
		if (!f) return '—';
		if (f.kind === 'none') return f.raw ? `없음 (${f.raw})` : '없음';
		if (f.kind === 'link') return `→ ${f.target ?? '?'}`;
		return `⚠ ${f.raw ?? ''}`;
	}

	const problems = $derived(summary ? collectProblemRows(summary) : []);
	const chainIssues = $derived(summary ? collectChainIssues(summary) : []);
</script>

<div class="header-row">
	<h2 class="page-title">슬립노트</h2>
	<button class="btn" onclick={runCheck} disabled={running}>
		{running ? '검사 중...' : '형식 검사'}
	</button>
</div>

<p class="intro">
	<code>[0] Slip-Box</code> 노트북 노트들이 정해진 형식에 맞는지 검사합니다. 인덱스 노트(<code>1c97d161…</code>)의
	<code>이론</code> / <code>실용</code> / <code>기록</code> 섹션 아래 링크 중 제목이
	<code>Slip-Box::</code>로 시작하거나 <code>yyyy-mm-dd HH:mm</code>으로 시작하는 것만 HEAD로 삼아
	<code>이전</code>/<code>다음</code> 링크드 리스트를 따라갑니다. 각 노트는 다음 형식이어야 합니다:
</p>
<pre class="format-example"
>제목
(공백)
이전: 없음  | &lt;내부 링크&gt;
다음: 없음  | &lt;내부 링크&gt;
(공백)
본문 ...</pre>

{#if error}
	<div class="notice error">오류: {error}</div>
{/if}

{#if summary}
	{@const s = summary}
	<section class="cards">
		<div class="card">
			<div class="card-label">Slip-Box 노트</div>
			<div class="card-value">{s.stats.slipBoxNotes}</div>
		</div>
		<div class="card">
			<div class="card-label">HEAD 추출</div>
			<div class="card-value">{s.stats.headsExtracted}</div>
		</div>
		<div class="card">
			<div class="card-label">검증된 노트</div>
			<div class="card-value">{s.stats.notesValidated}</div>
		</div>
		<div class="card" class:warn={s.stats.notesWithIssues > 0}>
			<div class="card-label">문제 있는 노트</div>
			<div class="card-value">{s.stats.notesWithIssues}</div>
		</div>
	</section>

	{#if !s.indexFound}
		<div class="notice error">
			인덱스 노트를 찾을 수 없습니다. GUID: <code>1c97d161-1489-4c32-93d9-d8c383330b9c</code>
		</div>
	{:else if !hasAnyIssues(s)}
		<div class="notice ok">모든 슬립노트가 형식에 맞습니다. 🎉</div>
	{:else}
		{#if chainIssues.length > 0}
			<section class="block">
				<h3 class="block-title">체인 구조 문제 ({chainIssues.length})</h3>
				<ul class="chain-issues">
					{#each chainIssues as ci}
						<li>
							<span class="section-chip">{ci.section}</span>
							<span class="head-ref">{ci.headTitle}</span>
							<span class="chain-issue-msg">{ci.message}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if problems.length > 0}
			<section class="block">
				<h3 class="block-title">형식 오류 노트 ({problems.length})</h3>
				<table class="problem-table">
					<thead>
						<tr>
							<th>섹션</th>
							<th>HEAD</th>
							<th>제목</th>
							<th>이전</th>
							<th>다음</th>
							<th>문제</th>
						</tr>
					</thead>
					<tbody>
						{#each problems as row}
							<tr>
								<td><span class="section-chip">{row.section}</span></td>
								<td class="head-ref small">{row.headTitle}</td>
								<td>
									<a href={'/note/' + row.guid} class="note-link">{row.title}</a>
									{#if row.isHead}<span class="tag">HEAD</span>{/if}
									{#if row.isTail}<span class="tag">TAIL</span>{/if}
								</td>
								<td class="field">{fieldDesc(row.prev)}</td>
								<td class="field">{fieldDesc(row.next)}</td>
								<td>
									<ul class="issues">
										{#each row.issues as issue}
											<li class="issue"><code>{issue.code}</code> {issue.message}</li>
										{/each}
									</ul>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}

		{#if s.unreachableSlipBoxNotes.length > 0}
			<section class="block">
				<h3 class="block-title">
					도달 불가 노트 ({s.unreachableSlipBoxNotes.length})
				</h3>
				<p class="block-hint">
					<code>[0] Slip-Box</code>에 속하지만 인덱스의 어떤 체인에서도 도달할 수 없는 노트들입니다.
				</p>
				<table class="problem-table">
					<thead>
						<tr>
							<th>제목</th>
							<th>형식 문제</th>
						</tr>
					</thead>
					<tbody>
						{#each s.unreachableSlipBoxNotes as u}
							<tr>
								<td>
									<a href={'/note/' + u.guid} class="note-link">{u.title}</a>
								</td>
								<td>
									{#if u.issues.length === 0}
										<span class="ok-mark">형식 문제 없음</span>
									{:else}
										<ul class="issues">
											{#each u.issues as issue}
												<li class="issue"><code>{issue.code}</code> {issue.message}</li>
											{/each}
										</ul>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}
	{/if}
{/if}

<style>
	.header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.page-title { font-size: 1.1rem; font-weight: 600; margin: 0; }
	.intro {
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		line-height: 1.5;
		margin: 0 0 10px;
	}
	.intro code, .block-hint code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: var(--color-bg-secondary, #f3f4f6);
		padding: 0 4px;
		border-radius: 3px;
	}
	.format-example {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 6px;
		padding: 10px 14px;
		font-size: 0.82rem;
		color: var(--color-text-secondary, #4b5563);
		margin: 0 0 20px;
		white-space: pre-wrap;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.btn {
		background: var(--color-primary, #2563eb);
		color: white;
		border: none;
		padding: 8px 16px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 500;
	}
	.btn:disabled { opacity: 0.6; cursor: not-allowed; }

	.notice {
		padding: 14px 16px;
		border-radius: 8px;
		font-size: 0.9rem;
		margin-bottom: 16px;
	}
	.notice.ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
	.notice.error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 12px;
		margin-bottom: 20px;
	}
	.card {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 10px;
		padding: 14px;
	}
	.card.warn { border-color: #f59e0b; background: #fffbeb; }
	.card-label {
		font-size: 0.72rem;
		color: var(--color-text-secondary, #6b7280);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 4px;
	}
	.card-value { font-size: 1.6rem; font-weight: 600; line-height: 1.1; }

	.block {
		margin-bottom: 24px;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		overflow: hidden;
	}
	.block-title {
		margin: 0;
		padding: 10px 14px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		font-size: 0.9rem;
		font-weight: 600;
	}
	.block-hint {
		padding: 8px 14px;
		margin: 0;
		font-size: 0.8rem;
		color: var(--color-text-secondary, #6b7280);
		border-bottom: 1px solid var(--color-border, #e5e7eb);
	}

	.chain-issues {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.chain-issues li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		font-size: 0.85rem;
	}
	.chain-issues li:last-child { border-bottom: none; }
	.chain-issue-msg { color: #b91c1c; flex: 1; }

	.section-chip {
		background: #e0e7ff;
		color: #3730a3;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 600;
		white-space: nowrap;
	}
	.head-ref {
		font-weight: 500;
	}
	.head-ref.small {
		font-size: 0.8rem;
		color: var(--color-text-secondary, #6b7280);
	}

	.problem-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.problem-table th, .problem-table td {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		vertical-align: top;
	}
	.problem-table tr:last-child td { border-bottom: none; }
	.problem-table th {
		background: var(--color-bg-secondary, #f7f7f8);
		font-weight: 500;
		color: var(--color-text-secondary, #6b7280);
		font-size: 0.75rem;
	}
	.problem-table td.field {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
	}
	.note-link {
		color: var(--color-primary, #2563eb);
		text-decoration: none;
	}
	.note-link:hover { text-decoration: underline; }
	.tag {
		display: inline-block;
		background: #1f2937;
		color: white;
		font-size: 0.65rem;
		padding: 1px 5px;
		border-radius: 3px;
		margin-left: 4px;
		vertical-align: middle;
	}
	.issues {
		list-style: none;
		padding: 0;
		margin: 0;
		font-size: 0.8rem;
	}
	.issue { padding: 2px 0; color: #b91c1c; }
	.issue code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: #fef2f2;
		padding: 0 4px;
		border-radius: 3px;
		font-size: 0.75rem;
		color: #991b1b;
	}
	.ok-mark { color: #059669; font-size: 0.8rem; }
</style>
