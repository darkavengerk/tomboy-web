<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { EditorView } from '@tiptap/pm/view';
  import type { Node as PMNode } from '@tiptap/pm/model';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import type { HueLight, HueRoom, HueZone, HueScene } from '$lib/hue/hueTypes.js';
  import { lightsInRoom, lightsInZone, groupedLightIdOf, buildSceneActions, isSceneActive } from '$lib/hue/roomOps.js';
  import { buildLightList, buildSceneList, findBoxList, listItemAt, lightContextOf, sceneContextOf, type LightItem, type SceneItem } from '$lib/hue/roomDoc.js';
  import { listNotesShared } from '$lib/core/noteManager.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';
  import { pushToast } from '$lib/stores/toast.js';

  let { groupKind, groupId, view }: { groupKind: 'room' | 'zone'; groupId: string; view: EditorView } = $props();

  let status = $state('');
  let glId = $state<string | null>(null);
  let groupedOn = $state(false);
  let brightness = $state(100);
  let newSceneName = $state('');

  let titleToId = new Map<string, string>();
  let sceneNameToId = new Map<string, string>();

  // 프로그램적 본문 재작성(목록 동기화·씬 배타 해제)은 undo 히스토리에 넣지 않는다.
  const errMsg = (e: unknown, base: string) =>
    e instanceof HueError ? (e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : e.kind === 'unreachable' ? '조명 브릿지에 연결 안 됨' : `${base} (HTTP ${e.status})`) : base;

  async function uuidToTitleMap(): Promise<Map<string, string>> {
    const notes = await listNotesShared();
    const m = new Map<string, string>();
    for (const n of notes) { const mt = /^light:([0-9a-fA-F-]{36})$/.exec(firstBodyLineOf(n.xmlContent).trim()); if (mt) m.set(mt[1], n.title); }
    return m;
  }

  function replaceList(kind: 'checkbox' | 'radio', node: PMNode) {
    const cur = findBoxList(view.state.doc, kind);
    if (cur) {
      const existing = view.state.doc.slice(cur.from, cur.to).content.firstChild;
      if (existing && existing.eq(node)) return;
      view.dispatch(view.state.tr.replaceWith(cur.from, cur.to, node).setMeta('addToHistory', false));
    } else {
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.insert(end, node).setMeta('addToHistory', false));
    }
  }

  async function load() {
    status = '불러오는 중…';
    try {
      const rd = (await hueCall('GET', `${groupKind}/${groupId}`)) as { data?: Array<HueRoom | HueZone> };
      const group = rd.data?.[0]; if (!group) { status = groupKind === 'room' ? '룸을 찾을 수 없음' : '존을 찾을 수 없음'; return; }
      glId = groupedLightIdOf(group);
      if (glId) {
        const g = ((await hueCall('GET', `grouped_light/${glId}`)) as { data?: Array<{ on: { on: boolean }; dimming?: { brightness: number } }> }).data?.[0];
        groupedOn = g?.on.on ?? false; brightness = g?.dimming?.brightness ?? 100;
      }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const groupLights = groupKind === 'room'
        ? lightsInRoom(group as HueRoom, allLights)
        : lightsInZone(group as HueZone, allLights);
      const u2t = await uuidToTitleMap();
      titleToId = new Map();
      const lightItems: LightItem[] = []; let missing = 0;
      for (const l of groupLights) {
        const title = u2t.get(l.id);
        if (!title) { missing++; continue; }
        titleToId.set(title, l.id);
        lightItems.push({ title, checked: l.on.on });
      }
      if (missing) pushToast(`노트 없는 전구 ${missing}개 — 마스터에서 가져오기`);

      const scenes = (((await hueCall('GET', 'scene')) as { data?: HueScene[] }).data ?? []).filter((s) => s.group?.rid === groupId);
      sceneNameToId = new Map(scenes.map((s) => [s.metadata.name.trim(), s.id]));
      const sceneItems: SceneItem[] = scenes.map((s) => ({ name: s.metadata.name.trim(), active: isSceneActive(s) }));

      replaceList('checkbox', buildLightList(view.state.schema, lightItems));
      replaceList('radio', buildSceneList(view.state.schema, sceneItems));
      status = '';
    } catch (e) { status = errMsg(e, '불러오기 실패'); }
  }

  // 항목 단위 listBox 위젯(.tomboy-checkbox-box / .tomboy-radio-box) 클릭.
  // 전역 TomboyListBox 플러그인의 클릭 핸들러가 먼저(타겟 단계) attr 을
  // 동기 토글하고, 우리는 캡처 단계에서 li DOM 만 잡아둔 뒤 마이크로태스크로
  // 그 뒤의 *새* attr 상태를 읽는다 — 타겟 핸들러는 stopPropagation 하지만
  // 캡처는 이미 통과했으므로 안전. 마운트 race 없이 토글 방향이 안정적.
  function onListBoxClick(ev: MouseEvent) {
    const t = ev.target as HTMLElement | null;
    const isRadio = !!t?.closest?.('.tomboy-radio-box');
    const box = isRadio ? t?.closest?.('.tomboy-radio-box') : t?.closest?.('.tomboy-checkbox-box');
    if (!box) return;
    const liDom = box.closest('li');
    if (!liDom) return;
    queueMicrotask(() => {
      try {
        const found = listItemAt(view.state.doc, view.posAtDOM(liDom, 0));
        if (!found) return;
        isRadio ? onRadio(found.node) : onCheckbox(found.node);
      } catch (e) { console.warn('[hue] listBox 클릭 처리 실패', e); }
    });
  }

  async function onCheckbox(li: PMNode) {
    const ctx = lightContextOf(li); if (!ctx) return;
    const id = titleToId.get(ctx.title); if (!id) { pushToast('전구 노트 매핑 없음 — ⟳'); return; }
    try { await hueCall('PUT', `light/${id}`, { on: { on: ctx.checked } }); }
    catch (e) { pushToast(errMsg(e, '조명 토글 실패')); }
  }

  async function onRadio(li: PMNode) {
    // 상호 배타·재클릭 해제는 전역 toggleRadioAt 가 doc 에서 처리한다.
    // 새로 선택된 항목만 recall; 해제(선택 false)면 아무 것도 안 함.
    const ctx = sceneContextOf(li); if (!ctx || !ctx.selected) return;
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
      const rd = (await hueCall('GET', `${groupKind}/${groupId}`)) as { data?: Array<HueRoom | HueZone> };
      const group = rd.data?.[0]; if (!group) { pushToast('그룹 없음'); return; }
      const allLights = ((await hueCall('GET', 'light')) as { data?: HueLight[] }).data ?? [];
      const members = groupKind === 'room' ? lightsInRoom(group as HueRoom, allLights) : lightsInZone(group as HueZone, allLights);
      const acts = buildSceneActions(members);
      await hueCall('POST', 'scene', { type: 'scene', metadata: { name }, group: { rid: groupId, rtype: groupKind }, actions: acts });
      newSceneName = ''; pushToast('씬 저장됨'); await load();
    } catch (e) { pushToast(errMsg(e, '씬 저장 실패')); }
  }

  onMount(() => { view.dom.addEventListener('click', onListBoxClick, true); load(); });
  onDestroy(() => view.dom.removeEventListener('click', onListBoxClick, true));
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
