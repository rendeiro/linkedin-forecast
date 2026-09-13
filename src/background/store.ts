/** §6.1 IndexedDB wrapper. Database `lif`, version 1. */
import type { Daily, DailyReading, FollowerPoint, ForecastRecord, NudgeRecord, Post, Snapshot } from '../shared/types';

const DB_NAME = 'lif';
const DB_VERSION = 1;
type StoreName = 'posts' | 'snapshots' | 'daily' | 'dailyReadings' | 'followers' | 'forecasts' | 'nudges';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('posts')) db.createObjectStore('posts', { keyPath: 'urn' });
      if (!db.objectStoreNames.contains('snapshots')) {
        const s = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
        s.createIndex('urn', 'urn'); s.createIndex('observedAt', 'observedAt');
      }
      if (!db.objectStoreNames.contains('daily')) db.createObjectStore('daily', { keyPath: 'utcDate' });
      if (!db.objectStoreNames.contains('dailyReadings')) {
        const s = db.createObjectStore('dailyReadings', { keyPath: 'id', autoIncrement: true });
        s.createIndex('utcDate', 'utcDate');
      }
      if (!db.objectStoreNames.contains('followers')) db.createObjectStore('followers', { keyPath: 'utcDate' });
      if (!db.objectStoreNames.contains('forecasts')) {
        const s = db.createObjectStore('forecasts', { keyPath: 'id', autoIncrement: true });
        s.createIndex('key', 'key');
      }
      if (!db.objectStoreNames.contains('nudges')) db.createObjectStore('nudges', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));
}

export const db = {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> { return tx<T | undefined>(store, 'readonly', s => s.get(key)); },
  getAll<T>(store: StoreName): Promise<T[]> { return tx<T[]>(store, 'readonly', s => s.getAll()); },
  byIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> { return tx<T[]>(store, 'readonly', s => s.index(index).getAll(key)); },
  put<T>(store: StoreName, value: T): Promise<IDBValidKey> { return tx<IDBValidKey>(store, 'readwrite', s => s.put(value)); },
  add<T>(store: StoreName, value: T): Promise<IDBValidKey> { return tx<IDBValidKey>(store, 'readwrite', s => s.add(value)); },
  delete(store: StoreName, key: IDBValidKey): Promise<void> { return tx<undefined>(store, 'readwrite', s => s.delete(key)).then(() => undefined); },
  clear(store: StoreName): Promise<void> { return tx<undefined>(store, 'readwrite', s => s.clear()).then(() => undefined); },
};

// Typed helpers
export const getPost = (urn: string) => db.get<Post>('posts', urn);
export const putPost = (p: Post) => db.put('posts', p);
export const allPosts = () => db.getAll<Post>('posts');
export const addSnapshot = (s: Snapshot) => db.add('snapshots', s);
export const snapshotsFor = (urn: string) => db.byIndex<Snapshot>('snapshots', 'urn', urn).then(xs => xs.sort((a, b) => a.observedAt < b.observedAt ? -1 : 1));
export const allSnapshots = () => db.getAll<Snapshot>('snapshots');
export const getDaily = (d: string) => db.get<Daily>('daily', d);
export const putDaily = (d: Daily) => db.put('daily', d);
export const allDaily = () => db.getAll<Daily>('daily').then(xs => xs.sort((a, b) => a.utcDate < b.utcDate ? -1 : 1));
export const addDailyReading = (r: DailyReading) => db.add('dailyReadings', r);
export const readingsFor = (d: string) => db.byIndex<DailyReading>('dailyReadings', 'utcDate', d);
export const putFollower = (f: FollowerPoint) => db.put('followers', f);
export const allFollowers = () => db.getAll<FollowerPoint>('followers');
export const addForecast = (f: ForecastRecord) => db.add('forecasts', f);
export const putForecast = (f: ForecastRecord) => db.put('forecasts', f);
export const forecastsFor = (key: string) => db.byIndex<ForecastRecord>('forecasts', 'key', key);
export const allForecasts = () => db.getAll<ForecastRecord>('forecasts');
export const addNudge = (n: NudgeRecord) => db.add('nudges', n);
export const putNudge = (n: NudgeRecord) => db.put('nudges', n);
export const allNudges = () => db.getAll<NudgeRecord>('nudges');

export async function clearAll() {
  for (const s of ['posts', 'snapshots', 'daily', 'dailyReadings', 'followers', 'forecasts', 'nudges'] as StoreName[]) await db.clear(s);
}

export interface Dump {
  version: 1; exportedAt: string;
  posts: Post[]; snapshots: Snapshot[]; daily: Daily[]; dailyReadings: DailyReading[];
  followers: FollowerPoint[]; forecasts: ForecastRecord[]; nudges: NudgeRecord[];
  local: Record<string, unknown>;
}

export async function dumpAll(local: Record<string, unknown>): Promise<Dump> {
  return {
    version: 1, exportedAt: new Date().toISOString(),
    posts: await allPosts(), snapshots: await allSnapshots(), daily: await allDaily(),
    dailyReadings: await db.getAll('dailyReadings'), followers: await allFollowers(),
    forecasts: await allForecasts(), nudges: await allNudges(), local,
  };
}

export async function restoreAll(d: Dump) {
  await clearAll();
  const strip = <T extends { id?: number }>(x: T) => { const { id, ...rest } = x; void id; return rest; };
  for (const p of d.posts ?? []) await db.put('posts', p);
  for (const s of d.snapshots ?? []) await db.add('snapshots', strip(s));
  for (const x of d.daily ?? []) await db.put('daily', x);
  for (const r of d.dailyReadings ?? []) await db.add('dailyReadings', strip(r));
  for (const f of d.followers ?? []) await db.put('followers', f);
  for (const f of d.forecasts ?? []) await db.add('forecasts', strip(f));
  for (const n of d.nudges ?? []) await db.add('nudges', strip(n));
}
