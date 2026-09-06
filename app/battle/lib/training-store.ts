// Persistent library of finished Auto Battle games, stored in the browser (IndexedDB).
//
// Auto Battle's in-memory replay window (auto-engine.ts) only survives while the page is open, so a
// long training run's evidence disappears on refresh. This module keeps every finished game — the
// result, which teams played, exactly what Blue brought and led with, and the full protocol log — so
// past games can be watched back later and mined for what actually wins (see playbook.ts).
//
// Layout: two object stores sharing one auto-increment id. `games` holds the small summary rows the
// library list and the playbook read (so ranking thousands of games never touches a log), and `logs`
// holds the bulky protocol lines, fetched only when a game is actually opened in the viewer.
//
// Everything here is browser-only and best-effort: IndexedDB may be unavailable (SSR, private mode,
// storage disabled). Callers get a thrown error they can surface, never a broken page.

export type GameResult = "blue" | "red" | "tie";
export type RunMode = "gauntlet" | "training";

// The small row every listing/ranking reads. Kept free of protocol lines on purpose.
export interface GameSummary {
  id: number;
  ts: number; // when the game finished (epoch ms)
  mode: RunMode;
  blueKey: string; // teamKey() of Blue's team — stable across sessions
  blueName: string;
  opponentId: string; // teamKey() of the opponent's team (NOT the roster row's id, which is per-run)
  opponentName: string;
  result: GameResult;
  turns: number;
  blueCombo: string | null; // "A + B + C + D" — the four Blue brought
  blueLead: string | null; // "A + B" — the two Blue led with
  redCombo: string | null;
  redLead: string | null;
}

export interface StoredGame extends GameSummary {
  lines: string[]; // raw Showdown protocol log, for the replay viewer
}

export type NewGame = Omit<StoredGame, "id">;

export interface LibraryFilter {
  blueKey?: string; // only games Blue played with this team
  opponentId?: string; // only games against this roster opponent
  limit?: number; // newest-first cap (default: everything)
}

const DB_NAME = "aether-auto-training";
const DB_VERSION = 1;
const GAMES = "games";
const LOGS = "logs";

// How many games the library keeps. A VGC log is a few KB, so this is a handful of MB — plenty of
// evidence for a playbook while staying far inside a browser's storage budget. Oldest go first.
export const LIBRARY_CAP = 3000;

let dbPromise: Promise<IDBDatabase> | null = null;

/** True when this browser can store games at all (false during SSR or with storage disabled). */
export function libraryAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * A stable, short identity for a team, derived from the packed string itself (FNV-1a, base36).
 *
 * Deriving it from the team — rather than from a preset id or the roster row's per-run id — is what
 * lets the library accumulate across sessions: the same paste uploaded next week groups with the
 * games it played today, and an edited team correctly counts as a different opponent.
 */
export function teamKey(packed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < packed.length; i++) {
    h ^= packed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "t" + (h >>> 0).toString(36);
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (!libraryAvailable()) return Promise.reject(new Error("This browser can't store games."));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(GAMES)) {
          const games = db.createObjectStore(GAMES, { keyPath: "id", autoIncrement: true });
          games.createIndex("blue", "blueKey", { unique: false });
          games.createIndex("blueOpp", ["blueKey", "opponentId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(LOGS)) db.createObjectStore(LOGS, { keyPath: "id" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("Couldn't open the game library."));
      open.onblocked = () => reject(new Error("The game library is open in another tab."));
    }).catch((e) => {
      dbPromise = null; // let a later call retry a transient failure
      throw e;
    });
  }
  return dbPromise;
}

/**
 * Append finished games to the library, returning their new ids in the order given. Summary and log
 * go in one transaction so a row never exists without its replay.
 */
export async function saveGames(games: NewGame[]): Promise<number[]> {
  if (!games.length) return [];
  const db = await openDb();
  const t = db.transaction([GAMES, LOGS], "readwrite");
  const summaries = t.objectStore(GAMES);
  const logs = t.objectStore(LOGS);
  const ids: number[] = [];
  for (const g of games) {
    const { lines, ...summary } = g;
    const id = (await req(summaries.add(summary))) as number;
    logs.put({ id, lines });
    ids.push(id);
  }
  await finished(t);
  await prune();
  return ids;
}

// Drop the oldest games once the library is over its cap. Ids are monotonic, so ascending key order
// is oldest-first; each dropped summary takes its log with it.
async function prune(): Promise<void> {
  try {
    const db = await openDb();
    const count = await req(db.transaction(GAMES, "readonly").objectStore(GAMES).count());
    const excess = count - LIBRARY_CAP;
    if (excess <= 0) return;
    const t = db.transaction([GAMES, LOGS], "readwrite");
    const logs = t.objectStore(LOGS);
    await new Promise<void>((resolve, reject) => {
      let removed = 0;
      const cursor = t.objectStore(GAMES).openCursor();
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (!cur || removed >= excess) return resolve();
        logs.delete(cur.primaryKey as number);
        cur.delete();
        removed++;
        cur.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error("Couldn't prune the game library."));
    });
    await finished(t);
  } catch {
    /* pruning is housekeeping — never fail a save over it */
  }
}

/** Stored games, newest first. Filtered by Blue's team and/or one opponent when asked. */
export async function listGames(filter: LibraryFilter = {}): Promise<GameSummary[]> {
  const db = await openDb();
  const t = db.transaction(GAMES, "readonly");
  const store = t.objectStore(GAMES);
  const { blueKey, opponentId, limit } = filter;
  let source: IDBObjectStore | IDBIndex = store;
  let range: IDBKeyRange | undefined;
  if (blueKey && opponentId) {
    source = store.index("blueOpp");
    range = IDBKeyRange.only([blueKey, opponentId]);
  } else if (blueKey) {
    source = store.index("blue");
    range = IDBKeyRange.only(blueKey);
  }

  const out: GameSummary[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursor = source.openCursor(range, "prev"); // newest (highest id) first
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (!cur || (limit != null && out.length >= limit)) return resolve();
      const row = cur.value as GameSummary;
      if (opponentId && !blueKey && row.opponentId !== opponentId) {
        cur.continue();
        return;
      }
      out.push(row);
      cur.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("Couldn't read the game library."));
  });
  return out;
}

/** One stored game with its protocol log, or null if it has been pruned away. */
export async function getGame(id: number): Promise<StoredGame | null> {
  const db = await openDb();
  const t = db.transaction([GAMES, LOGS], "readonly");
  const summary = (await req(t.objectStore(GAMES).get(id))) as GameSummary | undefined;
  if (!summary) return null;
  const log = (await req(t.objectStore(LOGS).get(id))) as { id: number; lines: string[] } | undefined;
  return { ...summary, lines: log?.lines ?? [] };
}

/** How many games the library holds in total. */
export async function countGames(): Promise<number> {
  const db = await openDb();
  return req(db.transaction(GAMES, "readonly").objectStore(GAMES).count());
}

/** Delete stored games — everything, or just the ones Blue played with one team. */
export async function clearLibrary(blueKey?: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction([GAMES, LOGS], "readwrite");
  const games = t.objectStore(GAMES);
  const logs = t.objectStore(LOGS);
  if (!blueKey) {
    games.clear();
    logs.clear();
  } else {
    await new Promise<void>((resolve, reject) => {
      const cursor = games.index("blue").openCursor(IDBKeyRange.only(blueKey));
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (!cur) return resolve();
        logs.delete(cur.primaryKey as number);
        cur.delete();
        cur.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error("Couldn't clear the game library."));
    });
  }
  await finished(t);
}

/** The library as JSON text (summaries + logs), for keeping a run's evidence outside the browser. */
export async function exportLibrary(filter: LibraryFilter = {}): Promise<string> {
  const summaries = await listGames(filter);
  const games: StoredGame[] = [];
  for (const s of summaries) {
    const full = await getGame(s.id);
    if (full) games.push(full);
  }
  return JSON.stringify(
    { format: "aether-auto-training", version: 1, exported: new Date().toISOString(), games },
    null,
    2
  );
}
