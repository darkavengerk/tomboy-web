import { getSetting, setSetting } from './appSettings.js';

const IP_KEY = 'hueBridgeIp';
const APPKEY_KEY = 'hueAppKey';
const CLIENTKEY_KEY = 'hueClientKey';

export async function getHueBridgeIp(): Promise<string> { return (await getSetting<string>(IP_KEY)) ?? ''; }
export async function getHueAppKey(): Promise<string> { return (await getSetting<string>(APPKEY_KEY)) ?? ''; }
export async function getHueClientKey(): Promise<string> { return (await getSetting<string>(CLIENTKEY_KEY)) ?? ''; }

export async function setHueCredentials(ip: string, appkey: string, clientkey: string): Promise<void> {
  await setSetting(IP_KEY, ip);
  await setSetting(APPKEY_KEY, appkey);
  await setSetting(CLIENTKEY_KEY, clientkey);
}
export async function clearHueCredentials(): Promise<void> {
  await setSetting(IP_KEY, ''); await setSetting(APPKEY_KEY, ''); await setSetting(CLIENTKEY_KEY, '');
}
