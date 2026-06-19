<script lang="ts">
  import { onMount } from 'svelte';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import { supportsColor, supportsColorTemp, supportsDimming, lightGamut, type HueLight } from '$lib/hue/hueTypes.js';
  import { rgbToXy, xyToRgb, clampToGamut, mirekToKelvin, kelvinToMirek } from '$lib/hue/color.js';
  import { pushToast } from '$lib/stores/toast.js';

  let { lightId }: { lightId: string } = $props();

  let light = $state<HueLight | null>(null);
  let loading = $state(true);
  let errorMsg = $state('');

  async function load() {
    loading = true; errorMsg = '';
    try {
      const data = (await hueCall('GET', `light/${lightId}`)) as { data?: HueLight[] };
      light = data.data?.[0] ?? null;
      if (!light) errorMsg = '오프라인/제거됨';
    } catch (e) {
      errorMsg = e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨';
    } finally { loading = false; }
  }
  onMount(load);

  async function put(body: Record<string, unknown>, optimistic: () => void, rollback: () => void) {
    optimistic();
    try { await hueCall('PUT', `light/${lightId}`, body); }
    catch { rollback(); pushToast('전구 설정 실패'); }
  }

  function toggle() {
    if (!light) return;
    const prev = light.on.on; const next = !prev;
    put({ on: { on: next } }, () => { light!.on.on = next; }, () => { light!.on.on = prev; });
  }
  function setBrightness(v: number) {
    if (!light?.dimming) return;
    const prev = light.dimming.brightness;
    put({ dimming: { brightness: v } }, () => { light!.dimming!.brightness = v; }, () => { light!.dimming!.brightness = prev; });
  }
  function setKelvin(k: number) {
    if (!light?.color_temperature) return;
    const mirek = kelvinToMirek(k); const prev = light.color_temperature.mirek;
    put({ color_temperature: { mirek } }, () => { light!.color_temperature!.mirek = mirek; }, () => { light!.color_temperature!.mirek = prev; });
  }
  function setColorHex(hex: string) {
    if (!light?.color) return;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const xy = clampToGamut(rgbToXy(r, g, b), lightGamut(light));
    const prev = light.color.xy;
    put({ color: { xy } }, () => { light!.color!.xy = xy; }, () => { light!.color!.xy = prev; });
  }

  const swatch = $derived(light?.color ? `rgb(${xyToRgb(light.color.xy, light.dimming?.brightness ?? 100).join(',')})` : '');
  const kelvin = $derived(light?.color_temperature?.mirek ? mirekToKelvin(light.color_temperature.mirek) : 4000);
</script>

<div class="bulb-control">
  {#if loading}
    <span class="hue-status">불러오는 중…</span>
  {:else if errorMsg}
    <span class="hue-status hue-error">{errorMsg}</span>
    <button type="button" onclick={load}>⟳</button>
  {:else if light}
    <div class="bulb-row">
      <button type="button" class="bulb-toggle" class:on={light.on.on} onclick={toggle}>{light.on.on ? '켜짐' : '꺼짐'}</button>
      <span class="bulb-name">{light.metadata?.name ?? ''}</span>
      {#if swatch}<span class="bulb-swatch" style:background={swatch}></span>{/if}
      <button type="button" class="hue-refresh" onclick={load} aria-label="새로고침">⟳</button>
    </div>
    {#if supportsDimming(light)}
      <label class="bulb-slider">밝기
        <input type="range" min="1" max="100" value={light.dimming?.brightness ?? 100} oninput={(e) => setBrightness(Number((e.target as HTMLInputElement).value))} />
      </label>
    {/if}
    {#if supportsColorTemp(light)}
      <label class="bulb-slider">색온도
        <input type="range" min="2000" max="6500" step="100" value={kelvin} oninput={(e) => setKelvin(Number((e.target as HTMLInputElement).value))} />
      </label>
    {/if}
    {#if supportsColor(light)}
      <label class="bulb-slider">색
        <input type="color" value={swatch ? rgbToHex(xyToRgb(light.color!.xy, light.dimming?.brightness ?? 100)) : '#ffffff'} oninput={(e) => setColorHex((e.target as HTMLInputElement).value)} />
      </label>
    {/if}
  {/if}
</div>

<script lang="ts" module>
  function rgbToHex(rgb: [number, number, number]): string {
    return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
  }
</script>

<style>
  .bulb-control { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .bulb-row { display: flex; align-items: center; gap: 0.5rem; }
  .bulb-toggle { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--border, #ccc); cursor: pointer; }
  .bulb-toggle.on { background: #ffd766; }
  .bulb-swatch { width: 1.1rem; height: 1.1rem; border-radius: 50%; border: 1px solid #0002; }
  .bulb-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .bulb-slider input[type='range'] { flex: 1; }
  .hue-refresh { margin-left: auto; }
  .hue-error { color: #c0392b; }
  .hue-status { font-size: 0.85rem; opacity: 0.8; }
</style>
