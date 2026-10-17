import type { AccountDto, CategoryDto, SessionDto, TxnDto } from "../shared/api.js";

/**
 * The last data the server sent, kept in IndexedDB: the app draws from it at once on the next
 * launch, with or without a network, and refreshes it in the background.
 *
 * Bump VERSION whenever a DTO here changes shape: a copy kept by an older build is then
 * ignored rather than misread.
 */
const VERSION = 1;
const DB = "finreports";
const STORE = "snapshot";
const KEY = "data";

export interface Snapshot {
  /** No CSRF token: it is only good for the session it came with. */
  session: Omit<SessionDto, "csrfToken">;
  categories: CategoryDto[];
  categoryOrder: string[];
  accounts: AccountDto[];
  txns: TxnDto[];
  /** When the server sent it, ms since the epoch. */
  fetchedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  const saved = (await run("readonly", (s) => s.get(KEY))) as { version: number; snapshot: Snapshot } | undefined;
  return saved?.version === VERSION ? saved.snapshot : null;
}

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  await run("readwrite", (s) => s.put({ version: VERSION, snapshot }, KEY));
}

/** On logout: nothing of the user's stays on this device. */
export async function clearSnapshot(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY));
}
