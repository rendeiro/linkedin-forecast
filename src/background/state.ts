/** §6.2 chrome.storage.local state. Every handler loads from storage; no module globals hold state. */
import { DEFAULT_SETTINGS, type CaptureHealth, type ModelState, type Onboarding, type Settings } from '../shared/types';
import { initialModel, MODEL_VERSION } from '../model/simple';

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as T) ?? fallback;
}
export async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  const s = await getLocal<Partial<Settings>>('settings', {});
  return { ...DEFAULT_SETTINGS, ...s, goal: { ...DEFAULT_SETTINGS.goal, ...(s.goal ?? {}) }, quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(s.quietHours ?? {}) }, autoVisit: { ...DEFAULT_SETTINGS.autoVisit, ...(s.autoVisit ?? {}) } };
}
export const setSettings = (s: Settings) => setLocal('settings', s);

export async function getModel(): Promise<ModelState> {
  const m = await getLocal<ModelState | null>('model', null);
  if (!m || m.version !== MODEL_VERSION) return initialModel();
  return { ...initialModel(), ...m };
}
export const setModel = (m: ModelState) => setLocal('model', m);

export const getOnboarding = () => getLocal<Onboarding>('onboarding', { step: 0, done: false });
export const setOnboarding = (o: Onboarding) => setLocal('onboarding', o);

export const getHealth = () => getLocal<CaptureHealth>('captureHealth', {});
export const setHealth = (h: CaptureHealth) => setLocal('captureHealth', h);

export async function timezone(): Promise<string | undefined> {
  const s = await getSettings();
  if (s.tzOverride) return s.tzOverride;
  const o = await getOnboarding();
  return o.timezone;
}

/** Ring buffer of the last 200 events, readable from the Options page. Never leaves the browser. */
export async function logEvent(kind: string, message: string) {
  const entries = await getLocal<{ at: string; kind: string; message: string }[]>('log', []);
  entries.push({ at: new Date().toISOString(), kind, message });
  await setLocal('log', entries.slice(-200));
}
