<script lang="ts">
	import type { CodegraphData, CodegraphNode } from '$lib/codegraph/codegraphTypes.js';
	import { githubLink } from '$lib/codegraph/githubLink.js';
	import { nodeColor } from '$lib/codegraph/nodeColor.js';

	type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

	interface NeighborRow {
		id: string;
		title: string;
		sourceFile: string;
		sourceLocation: string | null;
		confidence: Confidence;
		direction: 'outbound' | 'inbound';
		relation: string;
	}

	interface NeighborSection {
		direction: 'outbound' | 'inbound';
		relation: string;
		rows: NeighborRow[];
	}

	interface Props {
		open: boolean;
		selected: CodegraphNode | null;
		data: CodegraphData | null;
		onclose: () => void;
		onneighborclick: (id: string) => void;
	}

	let { open, selected, data, onclose, onneighborclick }: Props = $props();

	const confidenceRank: Record<Confidence, number> = {
		EXTRACTED: 1,
		INFERRED: 2,
		AMBIGUOUS: 3
	};

	function groupAndSort(
		rows: NeighborRow[],
		direction: 'outbound' | 'inbound'
	): NeighborSection[] {
		const buckets = new Map<string, NeighborRow[]>();
		for (const row of rows) {
			const list = buckets.get(row.relation);
			if (list) {
				list.push(row);
			} else {
				buckets.set(row.relation, [row]);
			}
		}
		const sections: NeighborSection[] = [];
		for (const [relation, bucket] of buckets) {
			bucket.sort((a, b) => {
				const rankDiff = confidenceRank[a.confidence] - confidenceRank[b.confidence];
				if (rankDiff !== 0) return rankDiff;
				if (a.title < b.title) return -1;
				if (a.title > b.title) return 1;
				return 0;
			});
			sections.push({ direction, relation, rows: bucket });
		}
		sections.sort((a, b) => {
			if (a.relation < b.relation) return -1;
			if (a.relation > b.relation) return 1;
			return 0;
		});
		return sections;
	}

	const sections = $derived.by((): NeighborSection[] => {
		if (!selected || !data) return [];
		const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		const out: NeighborRow[] = [];
		const inbound: NeighborRow[] = [];
		for (const link of data.links) {
			if (link.source === selected.id) {
				const n = nodeById.get(link.target);
				if (!n) continue;
				out.push({
					id: n.id,
					title: n.title,
					sourceFile: n.sourceFile,
					sourceLocation: n.sourceLocation,
					confidence: link.confidence,
					direction: 'outbound',
					relation: link.relation
				});
			} else if (link.target === selected.id) {
				const n = nodeById.get(link.source);
				if (!n) continue;
				inbound.push({
					id: n.id,
					title: n.title,
					sourceFile: n.sourceFile,
					sourceLocation: n.sourceLocation,
					confidence: link.confidence,
					direction: 'inbound',
					relation: link.relation
				});
			}
		}
		return groupAndSort(out, 'outbound').concat(groupAndSort(inbound, 'inbound'));
	});

	const githubHref = $derived.by((): string | null => {
		if (!selected || !data) return null;
		if (!selected.sourceFile) return null;
		return githubLink(data.meta, selected.sourceFile, selected.sourceLocation);
	});

	const communityLabel = $derived.by((): string => {
		if (!selected || !data) return '';
		return data.communityLabels[String(selected.community)] ?? '';
	});

	function handleGithubClick() {
		if (!githubHref) return;
		window.open(githubHref, '_blank', 'noopener');
	}

	function handleNeighborClick(id: string) {
		onneighborclick(id);
	}

	function sectionHeader(section: NeighborSection): string {
		const arrow = section.direction === 'outbound' ? '→' : '←';
		return `${arrow} ${section.relation} (${section.rows.length})`;
	}
</script>

{#if open}
	<aside class="code-panel" aria-label="코드 노드 상세">
		{#if !selected || !data}
			<header class="panel-header empty">
				<button
					type="button"
					class="close-btn"
					aria-label="닫기"
					onclick={onclose}>×</button>
			</header>
			<div class="panel-body empty-body">
				<p class="placeholder">노드를 선택해주세요</p>
			</div>
		{:else}
			<header class="panel-header">
				<div class="header-main">
					<div class="header-text">
						<h2 class="title" title={selected.title}>{selected.title}</h2>
						<p class="subline">
							{selected.sourceFile}{selected.sourceLocation
								? ` · ${selected.sourceLocation}`
								: ''}
						</p>
					</div>
					<div class="header-actions">
						<button
							type="button"
							class="github-btn"
							title="GitHub에서 보기"
							disabled={!githubHref}
							onclick={handleGithubClick}>↗ GitHub</button>
						<button
							type="button"
							class="close-btn"
							aria-label="닫기"
							onclick={onclose}>×</button>
					</div>
				</div>
				<div class="chips">
					<span
						class="chip community-chip"
						style="background-color: {nodeColor(selected.community)};"
						>community {selected.community}{communityLabel
							? ` (${communityLabel})`
							: ''}</span>
					<span class="chip neutral-chip">degree {selected.degree}</span>
					<span class="chip neutral-chip">{selected.fileType.toLowerCase()}</span>
				</div>
			</header>
			<div class="panel-body">
				{#if sections.length === 0}
					<p class="placeholder">연결된 이웃이 없습니다</p>
				{:else}
					{#each sections as section (section.direction + '|' + section.relation)}
						<section class="neighbor-section">
							<h3 class="section-header">{sectionHeader(section)}</h3>
							<ul class="neighbor-list">
								{#each section.rows as row (row.id + '|' + row.relation + '|' + row.direction)}
									<li>
										<button
											type="button"
											class="neighbor-row"
											onclick={() => handleNeighborClick(row.id)}
										>
											<span class="row-arrow" aria-hidden="true"
												>{row.direction === 'outbound' ? '↗' : '↙'}</span>
											<span class="row-text">
												<span class="row-title">{row.title}</span>
												<span class="row-loc"
													>{row.sourceFile}{row.sourceLocation
														? ` · ${row.sourceLocation}`
														: ''}</span>
											</span>
											<span
												class="confidence-dot {row.confidence === 'EXTRACTED'
													? 'extracted'
													: row.confidence === 'INFERRED'
														? 'inferred'
														: 'ambiguous'}"
												aria-label={row.confidence}
											></span>
										</button>
									</li>
								{/each}
							</ul>
						</section>
					{/each}
				{/if}
			</div>
		{/if}
	</aside>
{/if}

<style>
	.code-panel {
		position: fixed;
		bottom: 24px;
		right: 24px;
		width: 420px;
		height: 60vh;
		display: flex;
		flex-direction: column;
		background: rgba(20, 24, 34, 0.95);
		color: rgba(230, 237, 243, 0.92);
		border: 1px solid rgba(120, 130, 150, 0.25);
		border-radius: 12px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		pointer-events: auto;
		z-index: 50;
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	.panel-header {
		padding: 12px 16px;
		border-bottom: 1px solid rgba(120, 130, 150, 0.15);
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex-shrink: 0;
	}

	.panel-header.empty {
		justify-content: flex-end;
		flex-direction: row;
		border-bottom: none;
	}

	.header-main {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}

	.header-text {
		flex: 1;
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.subline {
		margin: 2px 0 0;
		font-size: 12px;
		color: rgba(180, 190, 210, 0.7);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.github-btn {
		background: rgba(120, 130, 150, 0.15);
		border: 1px solid rgba(120, 130, 150, 0.3);
		border-radius: 6px;
		padding: 4px 10px;
		color: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.github-btn:hover:not(:disabled) {
		background: rgba(120, 130, 150, 0.25);
	}

	.github-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: inherit;
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 8px;
		border-radius: 6px;
	}

	.close-btn:hover {
		background: rgba(120, 130, 150, 0.15);
		color: rgba(255, 255, 255, 1);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.chip {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 11px;
		line-height: 1.4;
	}

	.community-chip {
		color: #fff;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
	}

	.neutral-chip {
		background: rgba(120, 130, 150, 0.2);
		color: rgba(220, 230, 245, 0.85);
	}

	.panel-body {
		padding: 8px 16px 16px;
		overflow-y: auto;
		flex: 1;
	}

	.empty-body {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.placeholder {
		text-align: center;
		color: rgba(180, 190, 210, 0.6);
		font-size: 13px;
		margin: 0;
	}

	.neighbor-section {
		margin-top: 12px;
	}

	.neighbor-section:first-child {
		margin-top: 4px;
	}

	.section-header {
		margin: 0 0 6px;
		font-size: 13px;
		font-weight: 600;
		color: rgba(210, 220, 235, 0.9);
	}

	.neighbor-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.neighbor-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		cursor: pointer;
		border-radius: 6px;
		background: transparent;
		border: none;
		color: inherit;
		text-align: left;
		font: inherit;
	}

	.neighbor-row:hover {
		background-color: rgba(120, 130, 150, 0.1);
	}

	.row-arrow {
		flex-shrink: 0;
		color: rgba(180, 190, 210, 0.6);
		font-size: 12px;
		width: 12px;
	}

	.row-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.row-title {
		font-size: 13px;
		color: rgba(230, 237, 243, 0.92);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row-loc {
		font-size: 11px;
		color: rgba(170, 180, 200, 0.65);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.confidence-dot {
		flex-shrink: 0;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}

	.confidence-dot.extracted {
		background: #4ade80;
	}

	.confidence-dot.inferred {
		background: #fbbf24;
	}

	.confidence-dot.ambiguous {
		background: #f87171;
	}
</style>
