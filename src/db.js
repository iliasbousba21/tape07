// Tiny IndexedDB wrapper. Two stores:
//  tracks: metadata (id, title, artist, duration, size, type, order, cues, loop, peaks)
//  blobs:  the actual audio data (id -> Blob), so files survive reloads on Android.
const DB_NAME = 'reel7';
const DB_VER = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('database blocked'));
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        let out;
        Promise.resolve(fn(t)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      })
  );
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  async allTracks() {
    const list = await tx('tracks', 'readonly', (t) => req2p(t.objectStore('tracks').getAll()));
    return (list || []).sort((a, b) => a.order - b.order);
  },
  putTrack(track) {
    return tx('tracks', 'readwrite', (t) => { t.objectStore('tracks').put(track); });
  },
  putTracks(tracks) {
    return tx('tracks', 'readwrite', (t) => { const s = t.objectStore('tracks'); tracks.forEach((x) => s.put(x)); });
  },
  addTrack(track, blob) {
    return tx(['tracks', 'blobs'], 'readwrite', (t) => {
      t.objectStore('blobs').put(blob, track.id);
      t.objectStore('tracks').put(track);
    });
  },
  getBlob(id) {
    return tx('blobs', 'readonly', (t) => req2p(t.objectStore('blobs').get(id)));
  },
  deleteTrack(id) {
    return tx(['tracks', 'blobs'], 'readwrite', (t) => {
      t.objectStore('tracks').delete(id);
      t.objectStore('blobs').delete(id);
    });
  },
  clear() {
    return tx(['tracks', 'blobs'], 'readwrite', (t) => {
      t.objectStore('tracks').clear();
      t.objectStore('blobs').clear();
    });
  },
};

export async function storageInfo() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch {}
  return null;
}
