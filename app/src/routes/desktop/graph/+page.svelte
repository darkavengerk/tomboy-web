<script lang="ts">
	import { onMount } from 'svelte';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import { getHomeNoteGuid } from '$lib/core/home.js';
	import { buildGraph, type GraphData, type GraphNode } from '$lib/graph/buildGraph.js';
	import { SLEEP_NOTE_GUID } from '$lib/graph/constants.js';
	import { FpsControls } from '$lib/graph/FpsControls.js';
	import NoteWindow from '$lib/desktop/NoteWindow.svelte';
	import type { ForceGraph3DInstance } from '3d-force-graph';

	// How long a new nearest-node candidate must stay on top before we actually
	// switch the displayed note. Short enough to feel responsive, long enough
	// to avoid thrashing the TipTap editor while flying through a crowd.
	const SWITCH_DEBOUNCE_MS = 350;

	// "Aim point" offset: distance calculations use a point this far ahead of
	// the camera instead of the camera itself, so notes you're *looking at*
	// win over notes immediately beside/behind you. Gives the spacefarer
	// feeling of approaching whatever is in your sights.
	const AIM_OFFSET = 40;

	let container: HTMLDivElement;
	let loading = $state(true);
	let progress = $state({ done: 0, total: 0 });
	let stats = $state({ nodes: 0, links: 0 });
	let graphData: GraphData | null = null;
	let fpsLocked = $state(false);

	// Auto-selection state. Auto-select is on by default; closing the panel
	// turns it off until the user explicitly clicks a node again.
	let selectedGuid = $state<string | null>(null);
	let autoSelect = $state(true);

	// Selection strategy for the debounced auto-select:
	//   - 'aim'    : nearest-in-frustum to the aim point (camera + forward*40)
	//   - 'center' : whichever node actually overlaps the reticle
	// Default is 'aim' so something is always selected as you fly through
	// the cloud (good exploration feel). A click switches to 'center', which
	// locks selection to "whatever the crosshair points at" — that's the
	// only way a deliberate click doesn't get immediately overwritten by
	// the distance-based auto-select ~350ms later.
	// Closing the panel / re-enabling auto-select resets to 'aim'.
	let selectionMode: 'aim' | 'center' = 'aim';

	let nodesById = new Map<string, GraphNode>();
	let titleToGuid = new Map<string, string>();
	let backlinksByGuid = new Map<string, string[]>();

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

		// 2) Indices for click/link/backlink lookups.
		nodesById = new Map(graphData.nodes.map((n) => [n.id, n]));
		titleToGuid = new Map(
			graphData.nodes.map((n) => [n.title.trim().toLowerCase(), n.id])
		);
		backlinksByGuid = new Map<string, string[]>();
		for (const l of graphData.links) {
			const arr = backlinksByGuid.get(l.target) ?? [];
			arr.push(l.source);
			backlinksByGuid.set(l.target, arr);
		}

		// 3) Instantiate the graph. We disable the built-in navigation
		//    controls entirely — the only supported interaction is our
		//    pointer-lock FPS mode. Clicking the background requests the
		//    lock; clicking a node selects + flies (only when unlocked).
		const graph = new ForceGraph3D(container, { controlType: 'orbit' })
			.enableNavigationControls(false)
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
				const color = node.isHome
					? '#f5c542'
					: node.isSleep
						? '#9b6cff'
						: degreeColor(node.size);
				const radius = 3 * node.size;
				const sphere = new THREE.Mesh(
					new THREE.SphereGeometry(radius, 10, 8),
					new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.9 })
				);
				group.add(sphere);
				const label = new SpriteText(node.title);
				label.color = '#ffffff';
				label.textHeight = 4 * node.size;
				label.backgroundColor = false;
				label.padding = 0;
				label.position.set(0, radius + 2 + label.textHeight / 2, 0);
				group.add(label);
				return group;
			})
			.nodeThreeObjectExtend(false)
			.graphData(graphData);

		fg = graph;

		// 4) Center camera on starting nodes (home + sleep) only on the first
		//    engine stop, so dragging a node doesn't teleport the camera back.
		let centeredOnce = false;
		graph.onEngineStop(() => {
			if (centeredOnce) return;
			centeredOnce = true;
			const starters = graphData!.nodes.filter((n) => n.isHome || n.isSleep);
			if (starters.length === 0) return;
			const placed = starters
				.map((n) => graph.graphData().nodes.find((x) => (x as GraphNode).id === n.id))
				.filter((x): x is NonNullable<typeof x> => !!x) as Array<
				GraphNode & { x?: number; y?: number; z?: number }
			>;
			if (placed.length === 0) return;
			const avg = placed.reduce(
				(acc, n) => ({
					x: acc.x + (n.x ?? 0),
					y: acc.y + (n.y ?? 0),
					z: acc.z + (n.z ?? 0)
				}),
				{ x: 0, y: 0, z: 0 }
			);
			avg.x /= placed.length;
			avg.y /= placed.length;
			avg.z /= placed.length;
			graph.cameraPosition({ x: avg.x, y: avg.y, z: avg.z + 220 }, avg, 800);
		});

		loading = false;

		// 5) FPS controls + animation loop (also drives nearest-node tracking).
		const camera = graph.camera();
		const renderer = graph.renderer();
		const fps = new FpsControls(camera, renderer.domElement);
		fps.onLockChange = (locked) => {
			fpsLocked = locked;
		};

		// Unified click handler: one click = enter lock, any click while
		// locked = commit the reticle-aimed node. 3d-force-graph's own
		// onNodeClick / onBackgroundClick are intentionally unused — their
		// raycast relies on mouse coords that freeze during pointer lock.
		const canvasEl = renderer.domElement;
		const handleCanvasClick = () => {
			if (!fps.locked) {
				fps.lock();
				return;
			}
			// Click = whatever's precisely at the reticle, distance-agnostic.
			// If nothing is under the crosshair, the click is a no-op (we
			// stay locked; auto-select still shows whatever it picked).
			const id = findCenterNode();
			if (id) {
				autoSelect = true;
				// Flip to center-follow mode so the next updateNearest tick
				// doesn't immediately overwrite our pick with the distance-
				// based aim candidate. Prime the debounce state with the
				// clicked node so the mode switch is smooth.
				selectionMode = 'center';
				candidateGuid = id;
				candidateSince = performance.now();
				selectedGuid = id;
				triggerClickPulse();
			}
		};
		canvasEl.addEventListener('click', handleCanvasClick);

		// Auto-lock when the user presses a movement key — no need to click
		// first. Keys pressed before lock are already tracked by
		// FpsControls, so the moment lock engages movement starts.
		// Movement keys do two jobs: (1) auto-lock on first press when the
		// pointer isn't yet captured, and (2) flip the selection mode back
		// to 'aim' any time the user is actually moving. Rule of thumb:
		// clicking = 'center' mode (pinned to the crosshair), moving =
		// 'aim' mode (tracks the on-screen node closest to your heading).
		const MOVEMENT_KEYS_FOR_MODE = new Set([
			'keyw', 'keya', 'keys', 'keyd', 'space', 'keyc'
		]);
		const onMovementKey = (e: KeyboardEvent) => {
			const code = e.code.toLowerCase();
			if (!MOVEMENT_KEYS_FOR_MODE.has(code)) return;
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.isContentEditable)
			) {
				return;
			}
			// Any movement key press — including while already locked —
			// drops us out of click/center mode.
			selectionMode = 'aim';
			if (!fps.locked) fps.lock();
		};
		window.addEventListener('keydown', onMovementKey);

		// Selection halo: a slim cyan ring around the currently-selected node,
		// billboarded toward the camera. On click it scales up briefly as
		// feedback. A second, dimmer "hover" halo marks whatever node is
		// currently under the reticle — a preview of what a click would pick.
		const PULSE_DURATION_MS = 420;
		const halo = new THREE.Mesh(
			new THREE.RingGeometry(1, 1.08, 64),
			new THREE.MeshBasicMaterial({
				color: 0x5ad6ff,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.55,
				depthWrite: false
			})
		);
		halo.visible = false;
		halo.renderOrder = 999;
		graph.scene().add(halo);

		const hoverHalo = new THREE.Mesh(
			new THREE.RingGeometry(1, 1.08, 48),
			new THREE.MeshBasicMaterial({
				color: 0xffffff,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.22,
				depthWrite: false
			})
		);
		hoverHalo.visible = false;
		hoverHalo.renderOrder = 998;
		graph.scene().add(hoverHalo);

		const liveNodesById = new Map<
			string,
			GraphNode & { x?: number; y?: number; z?: number }
		>();
		for (const n of graph.graphData().nodes as Array<
			GraphNode & { x?: number; y?: number; z?: number }
		>) {
			liveNodesById.set(n.id, n);
		}

		let pulseUntil = 0;
		function triggerClickPulse() {
			pulseUntil = performance.now() + PULSE_DURATION_MS;
		}

		// Scratch vectors reused across frames for projection math.
		const ndcCenter = new THREE.Vector3();
		const ndcEdge = new THREE.Vector3();

		/**
		 * Precise "what's at the reticle" lookup: projects every live node to
		 * screen space (NDC) and picks whichever one's projected sphere
		 * actually covers the center of the screen. Distance-agnostic — the
		 * node you can see directly at the crosshair wins, regardless of
		 * whether something else is closer in 3D. Returns null if the reticle
		 * isn't over any node.
		 */
		function findCenterNode(): string | null {
			camera.updateMatrixWorld();
			let bestId: string | null = null;
			let bestZ = Infinity;
			for (const n of liveNodes) {
				if (n.x === undefined) continue;
				ndcCenter.set(n.x, n.y ?? 0, n.z ?? 0);
				ndcCenter.project(camera);
				// z outside [-1, 1] = behind camera or past far plane.
				if (ndcCenter.z < -1 || ndcCenter.z > 1) continue;
				// Cheap rejection: well outside the screen.
				if (Math.abs(ndcCenter.x) > 1.2 || Math.abs(ndcCenter.y) > 1.2) continue;
				// Project a point on the node's surface to measure its
				// apparent screen radius.
				const worldR = 3 * n.size;
				ndcEdge.set(n.x + worldR, n.y ?? 0, n.z ?? 0);
				ndcEdge.project(camera);
				const screenR = Math.hypot(
					ndcEdge.x - ndcCenter.x,
					ndcEdge.y - ndcCenter.y
				);
				const dFromCenter = Math.hypot(ndcCenter.x, ndcCenter.y);
				if (dFromCenter <= screenR && ndcCenter.z < bestZ) {
					// Overlaps the reticle; break depth ties toward the
					// closest (smallest z in NDC = nearest camera).
					bestZ = ndcCenter.z;
					bestId = n.id;
				}
			}
			return bestId;
		}

		/**
		 * Size the two halos consistently. Inner ring radius equals the
		 * node sphere radius (`3 * size`) so the halo sits exactly at the
		 * sphere's silhouette — the thin `RingGeometry(1, 1.08)` ring then
		 * extends just 8% beyond.
		 */
		function haloRadiusFor(size: number): number {
			return 3 * size;
		}

		function updateHalo(t: number) {
			if (!selectedGuid) {
				halo.visible = false;
				return;
			}
			const n = liveNodesById.get(selectedGuid);
			if (!n || n.x === undefined) {
				halo.visible = false;
				return;
			}
			halo.visible = true;
			halo.position.set(n.x, n.y ?? 0, n.z ?? 0);
			halo.lookAt(camera.position);
			const baseRadius = haloRadiusFor(n.size);
			let pulse = 1;
			if (t < pulseUntil) {
				const remaining = (pulseUntil - t) / PULSE_DURATION_MS; // 1 → 0
				pulse = 1 + remaining * 0.45;
			}
			halo.scale.setScalar(baseRadius * pulse);
			halo.rotateZ(0.008);
		}

		function updateHoverHalo() {
			const id = findCenterNode();
			// Don't double-ring the selected node — the brighter selected
			// halo already marks it.
			if (!id || id === selectedGuid) {
				hoverHalo.visible = false;
				return;
			}
			const n = liveNodesById.get(id);
			if (!n || n.x === undefined) {
				hoverHalo.visible = false;
				return;
			}
			hoverHalo.visible = true;
			hoverHalo.position.set(n.x, n.y ?? 0, n.z ?? 0);
			hoverHalo.lookAt(camera.position);
			hoverHalo.scale.setScalar(haloRadiusFor(n.size));
		}

		// When selection changes by any means (click, auto-select, backlink),
		// trigger the pulse so the user gets consistent visual feedback.
		let lastHaloedId: string | null = null;
		function maybePulseOnSelectionChange() {
			if (selectedGuid !== lastHaloedId) {
				lastHaloedId = selectedGuid;
				if (selectedGuid) triggerClickPulse();
			}
		}

		const liveNodes = graph.graphData().nodes as Array<
			GraphNode & { x?: number; y?: number; z?: number }
		>;
		let candidateGuid: string | null = null;
		let candidateSince = 0;
		const forwardVec = new THREE.Vector3();
		const frustum = new THREE.Frustum();
		const projMatrix = new THREE.Matrix4();
		const tmpPoint = new THREE.Vector3();

		/**
		 * Find the on-screen node closest to the aim point (40 units along
		 * the camera's forward direction). Returns null when the frustum
		 * is empty, which is how we skip selection while the user is
		 * staring into empty space.
		 */
		function findAimedNode(): string | null {
			camera.updateMatrixWorld();
			projMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
			frustum.setFromProjectionMatrix(projMatrix);

			camera.getWorldDirection(forwardVec);
			const ax = camera.position.x + forwardVec.x * AIM_OFFSET;
			const ay = camera.position.y + forwardVec.y * AIM_OFFSET;
			const az = camera.position.z + forwardVec.z * AIM_OFFSET;

			let bestId: string | null = null;
			let bestD2 = Infinity;
			for (const n of liveNodes) {
				if (n.x === undefined) continue;
				tmpPoint.set(n.x, n.y ?? 0, n.z ?? 0);
				if (!frustum.containsPoint(tmpPoint)) continue;
				const dx = ax - tmpPoint.x;
				const dy = ay - tmpPoint.y;
				const dz = az - tmpPoint.z;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 < bestD2) {
					bestD2 = d2;
					bestId = n.id;
				}
			}
			return bestId;
		}

		function updateNearest(now: number) {
			if (!autoSelect) return;
			const bestId =
				selectionMode === 'center' ? findCenterNode() : findAimedNode();
			// In center mode a reticle over empty space returns null — keep
			// the current selection so the last-clicked note stays on screen
			// instead of blanking out as you sweep past gaps.
			if (bestId === null) return;
			if (bestId !== candidateGuid) {
				candidateGuid = bestId;
				candidateSince = now;
			} else if (
				bestId !== selectedGuid &&
				now - candidateSince >= SWITCH_DEBOUNCE_MS
			) {
				selectedGuid = bestId;
			}
		}

		let lastTime = performance.now();
		let rafId = 0;
		const loop = (t: number) => {
			const dt = Math.min(0.1, (t - lastTime) / 1000);
			lastTime = t;
			fps.update(dt);
			updateNearest(t);
			maybePulseOnSelectionChange();
			updateHalo(t);
			updateHoverHalo();
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);

		// 6) Forward wheel events to the embedded note's scroll container so
		// the user can scroll through the note content without having to
		// precisely hover the panel. Capture-phase listener preempts the
		// graph's built-in zoom, which is fine since the graph page itself
		// has nothing else to scroll.
		const wheelForwarder = (e: WheelEvent) => {
			if (!selectedGuid) return;
			const panel = document.querySelector('.side-panel');
			if (!panel) return;
			// If the cursor is already inside the panel, let native bubbling
			// handle scrolling normally.
			if (panel.contains(e.target as Node)) return;
			const scrollTarget = panel.querySelector('.tomboy-editor') as HTMLElement | null;
			if (!scrollTarget) return;
			e.preventDefault();
			e.stopPropagation();
			// Treat non-pixel delta modes (line=1, page=2) as line heights.
			const factor = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? scrollTarget.clientHeight : 1;
			scrollTarget.scrollBy({ top: e.deltaY * factor });
		};
		window.addEventListener('wheel', wheelForwarder, { capture: true, passive: false });

		return () => {
			cancelAnimationFrame(rafId);
			window.removeEventListener('wheel', wheelForwarder, { capture: true });
			window.removeEventListener('keydown', onMovementKey);
			canvasEl.removeEventListener('click', handleCanvasClick);
			halo.geometry.dispose();
			(halo.material as { dispose: () => void }).dispose();
			hoverHalo.geometry.dispose();
			(hoverHalo.material as { dispose: () => void }).dispose();
			fps.dispose();
			graph._destructor();
		};
	}

	/** Yellow → red HSL gradient driven by node.size (log of degree). */
	function degreeColor(size: number): string {
		const t = Math.max(0, Math.min(1, size - 1));
		const hue = 48 - 48 * t;
		const sat = 85 + 10 * t;
		const light = 62 - 10 * t;
		return `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
	}

	function focusNode(guid: string) {
		if (!fg) return;
		const target = fg.graphData().nodes.find(
			(n) => (n as GraphNode).id === guid
		) as (GraphNode & { x?: number; y?: number; z?: number }) | undefined;
		if (!target || target.x === undefined) return;
		const distance = 80;
		const distRatio = 1 + distance / Math.hypot(target.x, target.y ?? 0, target.z ?? 1);
		fg.cameraPosition(
			{ x: target.x * distRatio, y: (target.y ?? 0) * distRatio, z: (target.z ?? 0) * distRatio },
			{ x: target.x, y: target.y ?? 0, z: target.z ?? 0 },
			1000
		);
	}

	function handleOpenLink(title: string) {
		const key = title.trim().toLowerCase();
		const guid = titleToGuid.get(key);
		if (!guid) return;
		autoSelect = true;
		// Backlink / internal-link navigation flies the camera; revert to
		// aim-mode so auto-select can pick up the target as the fly lands
		// (the reticle won't be on it yet).
		selectionMode = 'aim';
		selectedGuid = guid;
		focusNode(guid);
	}

	function closePanel() {
		selectedGuid = null;
		autoSelect = false;
		selectionMode = 'aim';
	}

	function reenableAutoSelect() {
		autoSelect = true;
		selectionMode = 'aim';
	}

	// Keep the WebGL canvas sized to its container.
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

	const selectedNode = $derived(
		selectedGuid ? (nodesById.get(selectedGuid) ?? null) : null
	);
	const selectedBacklinks = $derived(
		selectedGuid
			? (backlinksByGuid.get(selectedGuid) ?? [])
					.map((id) => nodesById.get(id))
					.filter((n): n is GraphNode => !!n)
			: []
	);
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
		<div class="stats">노드 {stats.nodes} · 링크 {stats.links}</div>
		{#if !autoSelect}
			<button
				type="button"
				class="auto-btn"
				onclick={reenableAutoSelect}
				title="시선 방향에서 가장 가까운 노트를 자동으로 열어주는 기능"
			>자동 선택 다시 켜기</button>
		{/if}
	</div>

	<div class="legend">
		<div><span class="dot home"></span> 홈 노트</div>
		<div><span class="dot sleep"></span> 슬립노트</div>
		<div class="gradient-row">
			<span>링크 적음</span>
			<span class="gradient-bar" aria-hidden="true"></span>
			<span>많음</span>
		</div>
		<div class="hint">크기·색상 = 링크 수 (로그 스케일)</div>
	</div>

	<!-- Spacefarer HUD: central reticle marks the aim point used for the
	     nearest-note calculation; bottom silhouette suggests a ship's bow
	     for an exploration vibe. Always visible; purely decorative. -->
	<div class="hud" aria-hidden="true">
		<svg class="reticle" viewBox="-20 -20 40 40">
			<circle cx="0" cy="0" r="7" />
			<circle cx="0" cy="0" r="1.2" />
			<line x1="-16" y1="0" x2="-10" y2="0" />
			<line x1="10" y1="0" x2="16" y2="0" />
			<line x1="0" y1="-16" x2="0" y2="-10" />
			<line x1="0" y1="10" x2="0" y2="16" />
		</svg>
		<svg class="ship" viewBox="-80 -40 160 56">
			<!-- Top-down ship silhouette, nose pointing up toward screen center.
			     Translucent so the graph stays readable underneath. -->
			<path
				class="ship-body"
				d="M 0 -35 L 14 -12 L 32 -2 L 60 6 L 40 12 L 14 12 L 6 4 L -6 4 L -14 12 L -40 12 L -60 6 L -32 -2 L -14 -12 Z"
			/>
			<path class="ship-cockpit" d="M -6 -14 L 6 -14 L 4 -4 L -4 -4 Z" />
			<line class="ship-vent" x1="-22" y1="12" x2="-22" y2="16" />
			<line class="ship-vent" x1="0" y1="12" x2="0" y2="16" />
			<line class="ship-vent" x1="22" y1="12" x2="22" y2="16" />
		</svg>
	</div>

	<div class="fps-hint" class:paused={!fpsLocked && !loading}>
		{#if fpsLocked}
			WASD: 이동 · Space/C: 상/하 · Shift: 빠르게 · ESC: 정지
		{:else if !loading}
			클릭 또는 WASD 로 이동 시작
		{/if}
	</div>

	{#if selectedNode}
		<aside class="side-panel" aria-label="노트 보기">
			<div class="note-host">
				{#key selectedNode.id}
					<NoteWindow
						guid={selectedNode.id}
						x={0}
						y={0}
						width={0}
						height={0}
						z={1}
						onfocus={() => {}}
						onclose={closePanel}
						onmove={() => {}}
						onresize={() => {}}
						onopenlink={handleOpenLink}
					/>
				{/key}
			</div>

			{#if selectedBacklinks.length > 0}
				<div class="backlinks">
					<div class="backlinks-title">
						이 노트를 가리키는 {selectedBacklinks.length}개
					</div>
					<ul>
						{#each selectedBacklinks as bl (bl.id)}
							<li>
								<button
									type="button"
									onclick={() => {
										autoSelect = true;
										selectionMode = 'aim';
										selectedGuid = bl.id;
										focusNode(bl.id);
									}}
								>{bl.title}</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
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

	/* Spacer separates left-aligned items (back/stats) from right-aligned
	   action buttons. Using a spacer makes the ordering independent of
	   whether auto-btn is rendered. */
	.top-bar::before {
		content: '';
		flex: 1;
		pointer-events: none;
	}

	.auto-btn {
		padding: 6px 12px;
		border-radius: 4px;
		border: 1px solid #3a5a7a;
		background: #1f2a3a;
		color: #cfd8e8;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.auto-btn:hover {
		background: #2d3d50;
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

	.gradient-row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.72rem;
		color: #cfd8e3;
		margin-top: 2px;
	}

	.gradient-bar {
		flex: 1;
		height: 8px;
		border-radius: 2px;
		background: linear-gradient(
			to right,
			hsl(48, 85%, 62%),
			hsl(24, 90%, 57%),
			hsl(0, 95%, 52%)
		);
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

	/* Heads-up display overlay — pointer-events: none so it never eats
	   canvas clicks. Two fixed children: a centered reticle marking the
	   aim point, and a bottom-center ship silhouette. */
	.hud {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 15;
	}

	.reticle {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 40px;
		height: 40px;
		transform: translate(-50%, -50%);
		stroke: rgba(230, 237, 243, 0.55);
		stroke-width: 1.2;
		fill: none;
		mix-blend-mode: screen;
	}

	.reticle circle:nth-child(2) {
		fill: rgba(230, 237, 243, 0.75);
		stroke: none;
	}

	.ship {
		position: absolute;
		bottom: 8px;
		left: 50%;
		width: 320px;
		height: 112px;
		transform: translateX(-50%);
		stroke: rgba(90, 179, 120, 0.65);
		stroke-width: 1.2;
		stroke-linejoin: round;
		stroke-linecap: round;
		fill: rgba(90, 179, 120, 0.08);
		filter: drop-shadow(0 0 6px rgba(90, 179, 120, 0.25));
	}

	.ship .ship-cockpit {
		fill: rgba(120, 200, 255, 0.25);
		stroke: rgba(120, 200, 255, 0.7);
	}

	.ship .ship-vent {
		stroke: rgba(255, 180, 100, 0.8);
		stroke-width: 2;
	}

	.fps-hint {
		position: absolute;
		top: 54px;
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 12px;
		background: rgba(20, 24, 34, 0.85);
		border: 1px solid #2a3040;
		border-radius: 4px;
		font-size: 0.78rem;
		color: #cfd8e3;
		z-index: 10;
		pointer-events: none;
	}

	.fps-hint:empty {
		display: none;
	}

	/* When the pointer isn't locked, the hint doubles as an "enter WASD
	   mode" call-to-action with a subtle pulse so it's easy to notice. */
	.fps-hint.paused {
		border-color: #5ab378;
		color: #cfe8d8;
		background: rgba(20, 46, 30, 0.85);
		animation: hint-pulse 1.8s ease-in-out infinite;
	}

	@keyframes hint-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(90, 179, 120, 0.0); }
		50% { box-shadow: 0 0 18px 2px rgba(90, 179, 120, 0.35); }
	}

	/* Side panel — holds the embedded NoteWindow and an optional backlinks
	   footer. Height is capped to roughly half the viewport so the graph
	   stays visible; the editor itself scrolls internally. NoteWindow's own
	   title-bar close button drives our closePanel handler. */
	.side-panel {
		position: absolute;
		top: 60px;
		right: 12px;
		width: 420px;
		max-width: calc(100vw - 24px);
		max-height: calc(100vh - 72px);
		height: 50vh;
		display: flex;
		flex-direction: column;
		gap: 6px;
		z-index: 10;
	}

	/* Host for the embedded NoteWindow. NoteWindow uses position: absolute
	   with left/top/width/height, so we override those to stretch it across
	   the host rather than require live size prop updates. */
	.note-host {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border-radius: 6px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
	}

	.note-host :global(.note-window) {
		position: absolute !important;
		left: 0 !important;
		top: 0 !important;
		width: 100% !important;
		height: 100% !important;
	}

	.backlinks {
		flex-shrink: 0;
		max-height: 25%;
		overflow-y: auto;
		padding: 8px 12px;
		background: rgba(20, 24, 34, 0.85);
		border: 1px solid #2a3040;
		border-radius: 4px;
	}

	.backlinks-title {
		font-size: 0.76rem;
		color: #8a94a6;
		margin-bottom: 4px;
	}

	.backlinks ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.backlinks li button {
		width: 100%;
		text-align: left;
		padding: 3px 6px;
		border: none;
		background: transparent;
		color: #cfd8e3;
		cursor: pointer;
		font-size: 0.8rem;
		border-radius: 3px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.backlinks li button:hover {
		background: #1f2638;
	}
</style>
