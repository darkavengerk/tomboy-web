<script lang="ts">
	import { onMount } from 'svelte';
	import { getAllNotes, getNote } from '$lib/storage/noteStore.js';
	import { getHomeNoteGuid } from '$lib/core/home.js';
	import { deserializeContent } from '$lib/core/noteContentArchiver.js';
	import { buildGraph, type GraphData, type GraphNode } from '$lib/graph/buildGraph.js';
	import { toPlainText } from '$lib/graph/plainText.js';
	import { SLEEP_NOTE_GUID } from '$lib/graph/constants.js';
	import { FpsControls } from '$lib/graph/FpsControls.js';
	import type { ForceGraph3DInstance } from '3d-force-graph';

	let container: HTMLDivElement;
	let loading = $state(true);
	let progress = $state({ done: 0, total: 0 });
	let stats = $state({ nodes: 0, links: 0 });
	let graphData: GraphData | null = null;
	let fpsLocked = $state(false);

	// Selected-node preview panel state.
	let selected = $state<{
		node: GraphNode;
		text: string;
		backlinks: Array<{ id: string; title: string }>;
	} | null>(null);

	let fg: ForceGraph3DInstance | null = null;
	let disposed = false;

	onMount(() => {
		let cleanup: (() => void) | null = null;
		(async () => {
			try {
				const result = await init();
				if (disposed) return;
				cleanup = result;
			} catch (err) {
				console.error('[graph] init failed', err);
			}
		})();
		return () => {
			disposed = true;
			cleanup?.();
		};
	});

	async function init() {
		const [{ default: ForceGraph3D }, THREE, { default: SpriteText }] = await Promise.all([
			import('3d-force-graph'),
			import('three'),
			import('three-spritetext')
		]);

		// 1) Load + compute graph.
		const [notes, homeGuid] = await Promise.all([getAllNotes(), getHomeNoteGuid()]);
		if (disposed) return () => {};

		progress = { done: 0, total: notes.length };
		graphData = buildGraph(notes, {
			homeGuid: homeGuid ?? null,
			sleepGuid: SLEEP_NOTE_GUID,
			onProgress: (done, total) => {
				progress = { done, total };
			}
		});
		stats = { nodes: graphData.nodes.length, links: graphData.links.length };

		// 2) Build reverse-adjacency for backlinks panel.
		const backlinks = new Map<string, string[]>();
		for (const l of graphData.links) {
			const arr = backlinks.get(l.target) ?? [];
			arr.push(l.source);
			backlinks.set(l.target, arr);
		}
		const nodesById = new Map(graphData.nodes.map((n) => [n.id, n]));

		// 3) Instantiate the graph.
		const graph = new ForceGraph3D(container, { controlType: 'orbit' })
			.backgroundColor('#05060a')
			.nodeRelSize(4)
			.nodeLabel((n) => (n as GraphNode).title)
			.linkColor(() => 'rgba(140, 180, 220, 0.35)')
			.linkDirectionalArrowLength(2)
			.linkDirectionalArrowRelPos(0.9)
			.linkWidth(0.3)
			.linkOpacity(0.6)
			.cooldownTicks(200)
			.warmupTicks(40)
			.d3AlphaDecay(0.05)
			.d3VelocityDecay(0.3)
			.nodeThreeObject((raw) => {
				const node = raw as GraphNode;
				const group = new THREE.Group();
				const color = node.isHome ? '#f5c542' : node.isSleep ? '#9b6cff' : '#6aa9ff';
				const radius = 3 * node.size;
				const sphere = new THREE.Mesh(
					new THREE.SphereGeometry(radius, 10, 8),
					new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.9 })
				);
				group.add(sphere);
				const label = new SpriteText(node.title);
				label.color = node.isHome || node.isSleep ? '#ffffff' : '#cfd8e3';
				label.textHeight = 4 * node.size;
				label.backgroundColor = 'rgba(0,0,0,0.45)';
				label.padding = 1;
				label.position.set(0, radius + 2 + label.textHeight / 2, 0);
				group.add(label);
				return group;
			})
			.nodeThreeObjectExtend(false)
			.onNodeClick((raw) => {
				const node = raw as GraphNode;
				void openNode(node, nodesById, backlinks);
			})
			.graphData(graphData);

		fg = graph;

		// 4) Center camera on starting nodes (home + sleep) once the layout
		//    has stabilized.
		graph.onEngineStop(() => {
			const starters = graphData!.nodes.filter((n) => n.isHome || n.isSleep);
			if (starters.length === 0) return;
			const nodesWithPos = starters
				.map((n) => graph.graphData().nodes.find((x) => (x as GraphNode).id === n.id))
				.filter((x): x is NonNullable<typeof x> => !!x) as Array<
				GraphNode & { x?: number; y?: number; z?: number }
			>;
			if (nodesWithPos.length === 0) return;
			const avg = nodesWithPos.reduce(
				(acc, n) => ({
					x: acc.x + (n.x ?? 0),
					y: acc.y + (n.y ?? 0),
					z: acc.z + (n.z ?? 0)
				}),
				{ x: 0, y: 0, z: 0 }
			);
			avg.x /= nodesWithPos.length;
			avg.y /= nodesWithPos.length;
			avg.z /= nodesWithPos.length;
			const distance = 220;
			graph.cameraPosition({ x: avg.x, y: avg.y, z: avg.z + distance }, avg, 800);
		});

		loading = false;

		// 5) Install custom FPS controls alongside orbit.
		// We keep orbit enabled for trackpad-friendly rotation when the
		// pointer isn't locked, and switch to FPS when the user clicks to
		// enter pointer-lock mode via the "시점 이동" button.
		const camera = graph.camera();
		const renderer = graph.renderer();
		const fps = new FpsControls(camera, renderer.domElement);
		fps.onLockChange = (locked) => {
			fpsLocked = locked;
			// Disable orbit controls while FPS is active to avoid fighting.
			const orbit = graph.controls() as { enabled?: boolean } | null;
			if (orbit && 'enabled' in orbit) orbit.enabled = !locked;
		};

		// 6) Drive FPS movement from the graph's animation loop. 3d-force-graph
		// doesn't expose a public tick hook, so we use requestAnimationFrame.
		let lastTime = performance.now();
		let rafId = 0;
		const loop = (t: number) => {
			const dt = Math.min(0.1, (t - lastTime) / 1000);
			lastTime = t;
			fps.update(dt);
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);

		// Expose lock trigger for the button.
		enterFpsMode = () => fps.lock();

		return () => {
			cancelAnimationFrame(rafId);
			fps.dispose();
			graph._destructor();
		};
	}

	let enterFpsMode: (() => void) | null = null;

	async function openNode(
		node: GraphNode,
		nodesById: Map<string, GraphNode>,
		backlinks: Map<string, string[]>
	) {
		const data = await getNote(node.id);
		let text = '';
		if (data) {
			try {
				const doc = deserializeContent(data.xmlContent);
				text = toPlainText(doc, 1500);
			} catch {
				text = '(본문 파싱 실패)';
			}
		}
		const bls = (backlinks.get(node.id) ?? [])
			.map((id) => nodesById.get(id))
			.filter((n): n is GraphNode => !!n)
			.map((n) => ({ id: n.id, title: n.title }));
		selected = { node, text, backlinks: bls };
	}

	function focusNode(guid: string) {
		if (!fg) return;
		const data = (fg as unknown as { graphData: () => GraphData }).graphData();
		const target = data.nodes.find((n) => (n as GraphNode).id === guid) as
			| (GraphNode & { x?: number; y?: number; z?: number })
			| undefined;
		if (!target || target.x === undefined) return;
		const distance = 80;
		const distRatio = 1 + distance / Math.hypot(target.x, target.y ?? 0, target.z ?? 1);
		(fg as unknown as {
			cameraPosition: (p: { x: number; y: number; z: number }, look: unknown, ms?: number) => void;
		}).cameraPosition(
			{ x: target.x * distRatio, y: (target.y ?? 0) * distRatio, z: (target.z ?? 0) * distRatio },
			{ x: target.x, y: target.y ?? 0, z: target.z ?? 0 },
			1000
		);
	}

	function openInEditor(guid: string) {
		window.open(`/note/${guid}`, '_blank', 'noopener');
	}

	// Keep canvas sized to the container.
	$effect(() => {
		if (!fg || !container) return;
		const instance = fg;
		const el = container;
		const resize = () => {
			instance.width(el.clientWidth).height(el.clientHeight);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(el);
		return () => ro.disconnect();
	});
</script>

<svelte:head>
	<title>노트 그래프 — Tomboy Web</title>
</svelte:head>

<div class="graph-root">
	<div class="canvas" bind:this={container}></div>

	{#if loading}
		<div class="loading-overlay" role="status">
			<div class="loading-box">
				<div class="loading-title">그래프 계산 중…</div>
				{#if progress.total > 0}
					<div class="loading-progress">
						{progress.done} / {progress.total} 노트
					</div>
					<div class="bar">
						<div class="bar-fill" style="width: {(progress.done / progress.total) * 100}%"></div>
					</div>
				{:else}
					<div class="loading-progress">노트 로드 중…</div>
				{/if}
			</div>
		</div>
	{/if}

	<div class="top-bar">
		<a class="back" href="/desktop" title="데스크톱으로 돌아가기">← 데스크톱</a>
		<div class="stats">
			노드 {stats.nodes} · 링크 {stats.links}
		</div>
		<button
			type="button"
			class="fps-btn"
			onclick={() => enterFpsMode?.()}
			title="클릭 후 WASD + 마우스로 이동. ESC로 해제."
		>
			{fpsLocked ? '이동 중 (ESC로 해제)' : '시점 이동 (WASD)'}
		</button>
	</div>

	<div class="legend">
		<div><span class="dot home"></span> 홈 노트</div>
		<div><span class="dot sleep"></span> 슬립노트</div>
		<div><span class="dot normal"></span> 일반 노트</div>
		<div class="hint">크기 = 링크 수 (로그 스케일)</div>
	</div>

	{#if fpsLocked}
		<div class="crosshair" aria-hidden="true"></div>
		<div class="fps-hint">
			WASD: 이동 · Space/C: 상/하 · Shift: 빠르게 · ESC: 해제
		</div>
	{/if}

	{#if selected}
		<aside class="side-panel" aria-label="노트 미리보기">
			<div class="panel-header">
				<h2>{selected.node.title}</h2>
				<button
					type="button"
					class="close"
					onclick={() => (selected = null)}
					aria-label="닫기"
				>×</button>
			</div>

			<div class="panel-meta">
				링크 수 {selected.node.degree}
				{#if selected.node.isHome} · 홈{/if}
				{#if selected.node.isSleep} · 슬립노트{/if}
			</div>

			<div class="panel-body">
				{#if selected.text}
					<pre>{selected.text}</pre>
				{:else}
					<div class="muted">(내용 없음)</div>
				{/if}
			</div>

			{#if selected.backlinks.length > 0}
				<div class="backlinks">
					<div class="backlinks-title">이 노트를 가리키는 {selected.backlinks.length}개 노트</div>
					<ul>
						{#each selected.backlinks as bl (bl.id)}
							<li>
								<button type="button" onclick={() => focusNode(bl.id)}>
									{bl.title}
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="panel-actions">
				<button type="button" onclick={() => openInEditor(selected!.node.id)}>
					이 노트 열기 ↗
				</button>
			</div>
		</aside>
	{/if}
</div>

<style>
	.graph-root {
		position: fixed;
		inset: 0;
		background: #05060a;
		color: #e6edf3;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		overflow: hidden;
	}

	.canvas {
		position: absolute;
		inset: 0;
	}

	.top-bar {
		position: absolute;
		top: 12px;
		left: 12px;
		right: 12px;
		display: flex;
		align-items: center;
		gap: 12px;
		z-index: 10;
		pointer-events: none;
	}

	.top-bar > * {
		pointer-events: auto;
	}

	.back {
		color: #cfd8e3;
		text-decoration: none;
		padding: 6px 10px;
		border-radius: 4px;
		background: rgba(20, 24, 34, 0.75);
		border: 1px solid #2a3040;
		font-size: 0.85rem;
	}

	.back:hover {
		background: rgba(40, 50, 70, 0.85);
	}

	.stats {
		color: #8a94a6;
		font-size: 0.8rem;
		background: rgba(20, 24, 34, 0.6);
		padding: 5px 10px;
		border-radius: 4px;
	}

	.fps-btn {
		margin-left: auto;
		padding: 6px 12px;
		border-radius: 4px;
		border: 1px solid #3a7a50;
		background: #1f3a2a;
		color: #cfe8d8;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.fps-btn:hover {
		background: #2d5a3d;
	}

	.legend {
		position: absolute;
		bottom: 12px;
		left: 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		background: rgba(20, 24, 34, 0.75);
		border: 1px solid #2a3040;
		border-radius: 4px;
		font-size: 0.78rem;
		color: #cfd8e3;
		z-index: 10;
	}

	.dot {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		margin-right: 6px;
		vertical-align: middle;
	}

	.dot.home {
		background: #f5c542;
	}

	.dot.sleep {
		background: #9b6cff;
	}

	.dot.normal {
		background: #6aa9ff;
	}

	.hint {
		color: #7a8494;
		margin-top: 4px;
		font-size: 0.72rem;
	}

	.loading-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(5, 6, 10, 0.9);
		z-index: 20;
	}

	.loading-box {
		padding: 20px 32px;
		background: #14182a;
		border: 1px solid #2a3040;
		border-radius: 8px;
		min-width: 280px;
	}

	.loading-title {
		font-size: 1rem;
		margin-bottom: 8px;
	}

	.loading-progress {
		font-size: 0.85rem;
		color: #8a94a6;
		margin-bottom: 10px;
	}

	.bar {
		height: 6px;
		background: #1f2638;
		border-radius: 3px;
		overflow: hidden;
	}

	.bar-fill {
		height: 100%;
		background: linear-gradient(90deg, #3a7a50, #5ab378);
		transition: width 100ms linear;
	}

	.crosshair {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 8px;
		height: 8px;
		margin: -4px 0 0 -4px;
		border: 2px solid #e6edf3;
		border-radius: 50%;
		background: transparent;
		pointer-events: none;
		z-index: 15;
		mix-blend-mode: difference;
	}

	.fps-hint {
		position: absolute;
		top: 54px;
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 10px;
		background: rgba(20, 24, 34, 0.85);
		border: 1px solid #2a3040;
		border-radius: 4px;
		font-size: 0.78rem;
		color: #cfd8e3;
		z-index: 10;
		pointer-events: none;
	}

	.side-panel {
		position: absolute;
		top: 60px;
		right: 12px;
		bottom: 12px;
		width: 360px;
		max-width: calc(100vw - 24px);
		background: #14182a;
		border: 1px solid #2a3040;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		z-index: 10;
		overflow: hidden;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px 8px;
		border-bottom: 1px solid #2a3040;
	}

	.panel-header h2 {
		margin: 0;
		font-size: 1rem;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.close {
		background: transparent;
		border: none;
		color: #8a94a6;
		font-size: 1.4rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
	}

	.close:hover {
		color: #e6edf3;
	}

	.panel-meta {
		padding: 6px 14px;
		font-size: 0.78rem;
		color: #8a94a6;
		border-bottom: 1px solid #2a3040;
	}

	.panel-body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 14px;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.panel-body pre {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: inherit;
		color: #cfd8e3;
	}

	.panel-body .muted {
		color: #7a8494;
	}

	.backlinks {
		padding: 10px 14px;
		border-top: 1px solid #2a3040;
		max-height: 30%;
		overflow-y: auto;
	}

	.backlinks-title {
		font-size: 0.78rem;
		color: #8a94a6;
		margin-bottom: 6px;
	}

	.backlinks ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.backlinks li button {
		width: 100%;
		text-align: left;
		padding: 4px 6px;
		border: none;
		background: transparent;
		color: #cfd8e3;
		cursor: pointer;
		font-size: 0.82rem;
		border-radius: 3px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.backlinks li button:hover {
		background: #1f2638;
	}

	.panel-actions {
		padding: 10px 14px;
		border-top: 1px solid #2a3040;
	}

	.panel-actions button {
		width: 100%;
		padding: 8px;
		border: 1px solid #3a7a50;
		background: #1f3a2a;
		color: #cfe8d8;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.panel-actions button:hover {
		background: #2d5a3d;
	}
</style>
