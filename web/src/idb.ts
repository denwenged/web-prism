const DB_NAME = "web-prism";
const STORE_NAME = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = fn(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const handleStore = {
  async set(key: string, handle: FileSystemHandle): Promise<void> {
    await withStore("readwrite", (store) => store.put(handle, key));
  },

  async get<T extends FileSystemHandle = FileSystemHandle>(key: string): Promise<T | null> {
    const value = await withStore<T | undefined>("readonly", (store) => store.get(key) as IDBRequest<T | undefined>);
    return value ?? null;
  },

  async delete(key: string): Promise<void> {
    await withStore("readwrite", (store) => store.delete(key));
  },
};
