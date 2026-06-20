<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { EditorView } from '@tiptap/pm/view';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import type { HueLight, HueRoom, HueScene } from '$lib/hue/hueTypes.js';
  import { lightsInRoom, groupedLightIdOf, buildSceneActions, isSceneActive } from '$lib/hue/roomOps.js';
  import { buildLightList, buildSceneList, findListByAtom, lightContextAt, sceneContextAt, type LightItem, type SceneItem } from '$lib/hue/roomDoc.js';
  import { listNotesShared } from '$lib/core/noteManager.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';
  import { pushToast } from '$lib/stores/toast.js';

  let { roomId, view }: { roomId: string; view: EditorView } = $props();

  let status = $state('');
  let glId = $state<string | null>(null);
  let groupedOn = $state(false);
  let brightness = $state(100);
  let newSceneName = $state('');

  let titleToId = new Map<string, string>();
  let sceneNameToId = new Map<string, string>();

  const REFRESH_META = 'hueRefresh';
  const errMsg = (e: unknown, base: string) =>
    e instanceof HueError ? (e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : e.kind === 'unreachable' ? '조명 브릿지에 연결 안 됨' : `${base} (HTTP ${e.status})`) : base;

  async function uuidToTitleMap(): Promise<Map<string, string>> {
    const notes = await listNotesShared();
    const m = new Map<string, string>();
    for (const n of notes) { const mt = /^light:([0-9a-fA-F-]{36})$/.exec(firstBodyLineOf(n.xmlContent).trim()); if (mt) m.set(mt[1], n.title); }
    return m;
  }

  function replaceList(atomName: 'inlineCheckbox' | 'inlineRadio', node: import('@tiptap/pm/model').Node) {
    const cur = findListByAtom(view.state.doc, atomName);
    if (cur) {
      const existing = view.state.doc.slice(cur.from, cur.to).content.firstChild;
      if (existing && existing.eq(node)) return;
      view.dispatch(view.state.tr.replaceWith(cur.from, cur.to, node).setMeta(REFRESH_META, true));
    } else {
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.insert(end, node).setMeta(REFRESH_META, true));
    }
  }

  async function load() {
    status = '불러오는 중…';
    try {
      const rd = (await hueCall('GET', `room/${roomId}`)) as { data?: HueRoom[] };
      const room = rd.data?.[0]; if (!room) { status = '룸을 찾을 수 없음'; return; }
      glId = groupedLightIdOf(room);
      if (glId) {
        const g = ((await hueCall('GET', `grouped_light/${glId}`)) as { data?: Array<{ on: { on: boolean }; dimming?: { brightness: number } }> }).data?.[0];
        groupedOn = g?.on.on ?? false; brightness = g?.dimming?.brightness ?? 100;
      }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const roomLights = lightsInRoom(room, allLights);
      const u2t = await uuidToTitleMap();
      titleToId = new Map();
      const lightItems: LightItem[] = []; let missing = 0;
      for (const l of roomLights) {
        const title = u2t.get(l.id);
        if (!title) { missing++; continue; }
        titleToId.set(title, l.id);
        lightItems.push({ title, checked: l.on.on });
      }
      if (missing) pushToast(`노트 없는 전구 ${missing}개 — 마스터에서 가져오기`);

      const scenes = (((await hueCall('GET', 'scene')) as { data?: HueScene[] }).data ?? []).filter((s) => s.group?.rid === roomId);
      // 씬 이름은 trim 일관성 유지 — sceneContextAt 가 listItem 텍스트를 trim 해 매핑하므로
      // 맵 키와 표시 이름도 동일하게 trim 하지 않으면 앞뒤 공백 있는 씬은 recall 매핑이 조용히 실패한다.
      sceneNameToId = new Map(scenes.map((s) => [s.metadata.name.trim(), s.id]));
      const sceneItems: SceneItem[] = scenes.map((s) => ({ name: s.metadata.name.trim(), active: isSceneActive(s) }));

      replaceList('inlineCheckbox', buildLightList(view.state.schema, lightItems));
      replaceList('inlineRadio', buildSceneList(view.state.schema, sceneItems));
      status = '';
    } catch (e) { status = errMsg(e, '불러오기 실패'); }
  }

  function onMousedown(ev: MouseEvent) {
    const el = (ev.target as HTMLElement)?.closest?.('.tomboy-inline-checkbox, .tomboy-inline-radio') as HTMLElement | null;
    if (!el) return;
    const isRadio = el.classList.contains('tomboy-inline-radio');
    // 타이밍 계약(load-bearing): atom NodeView 가 mousedown 에서 동기 dispatch 로 checked/selected 를 토글한다.
    // queueMicrotask 로 그 뒤에 읽어야 토글된 새 상태를 본다. 제거하거나 동기 호출로 바꾸면 토글 방향이 뒤집힌다.
    queueMicrotask(() => {
      try { const pos = view.posAtDOM(el, 0); isRadio ? onRadio(pos) : onCheckbox(pos); }
      catch (e) { console.warn('[hue] posAtDOM 실패', e); }
    });
  }

  async function onCheckbox(pos: number) {
    const ctx = lightContextAt(view.state.doc, pos); if (!ctx) return;
    const id = titleToId.get(ctx.title); if (!id) { pushToast('전구 노트 매핑 없음 — ⟳'); return; }
    try { await hueCall('PUT', `light/${id}`, { on: { on: ctx.checked } }); }
    catch (e) { pushToast(errMsg(e, '조명 토글 실패')); }
  }

  async function onRadio(pos: number) {
    const ctx = sceneContextAt(view.state.doc, pos); if (!ctx || !ctx.selected) return;
    if (ctx.siblings.length) {
      let tr = view.state.tr;
      for (const sp of ctx.siblings) tr = tr.setNodeAttribute(sp, 'selected', false);
      view.dispatch(tr.setMeta(REFRESH_META, true));
    }
    const id = sceneNameToId.get(ctx.name); if (!id) { pushToast('씬 매핑 없음 — ⟳'); return; }
    try { await hueCall('PUT', `scene/${id}`, { recall: { action: 'active' } }); }
    catch (e) { pushToast(errMsg(e, '씬 적용 실패')); }
  }

  async function setGroupOn(on: boolean) {
    if (!glId) return; const prev = groupedOn; groupedOn = on;
    try { await hueCall('PUT', `grouped_light/${glId}`, { on: { on } }); } catch (e) { groupedOn = prev; pushToast(errMsg(e, '그룹 제어 실패')); }
  }
  async function setGroupBrightness(v: number) {
    if (!glId) return; const prev = brightness; brightness = v;
    try { await hueCall('PUT', `grouped_light/${glId}`, { dimming: { brightness: v } }); } catch (e) { brightness = prev; pushToast(errMsg(e, '그룹 밝기 실패')); }
  }

  async function saveScene() {
    const name = newSceneName.trim(); if (!name) { pushToast('씬 이름을 입력하세요'); return; }
    try {
      const rd = (await hueCall('GET', `room/${roomId}`)) as { data?: HueRoom[] };
      const room = rd.data?.[0]; if (!room) { pushToast('룸 없음'); return; }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const acts = buildSceneActions(lightsInRoom(room, allLights));
      await hueCall('POST', 'scene', { type: 'scene', metadata: { name }, group: { rid: roomId, rtype: 'room' }, actions: acts });
      newSceneName = ''; pushToast('씬 저장됨'); await load();
    } catch (e) { pushToast(errMsg(e, '씬 저장 실패')); }
  }

  onMount(() => { view.dom.addEventListener('mousedown', onMousedown, true); load(); });
  onDestroy(() => view.dom.removeEventListener('mousedown', onMousedown, true));
</script>

<div class="room-control">
  <div class="room-row">
    <button type="button" class="bulb-toggle" class:on={groupedOn} onclick={() => setGroupOn(!groupedOn)}>{groupedOn ? '전체 켜짐' : '전체 꺼짐'}</button>
    <button type="button" class="hue-refresh" onclick={load} aria-label="새로고침">⟳</button>
  </div>
  {#if glId}
    <label class="bulb-slider">전체 밝기
      <input type="range" min="1" max="100" value={brightness} oninput={(e) => setGroupBrightness(Number((e.target as HTMLInputElement).value))} />
    </label>
  {/if}
  <div class="room-scene-save">
    <input type="text" placeholder="새 씬 이름" bind:value={newSceneName} />
    <button type="button" onclick={saveScene}>현재 상태 저장</button>
  </div>
  {#if status}<span class="hue-status">{status}</span>{/if}
</div>

<style>
  .room-control { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .room-row { display: flex; align-items: center; gap: 0.5rem; }
  .room-scene-save { display: flex; gap: 0.3rem; }
  .bulb-toggle { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--border, #ccc); }
  .bulb-toggle.on { background: #ffd766; }
  .bulb-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .bulb-slider input[type='range'] { flex: 1; }
  .hue-refresh { margin-left: auto; }
  .hue-status { font-size: 0.85rem; opacity: 0.8; }
</style>
