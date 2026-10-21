// Il database vive in IndexedDB (un unico blob SQLite). Le scritture sono serializzate.
const NOME = 'spesa-pwa', STORE = 'dati';
let apertura = null, coda = Promise.resolve();

function idb() {
  if (!apertura) apertura = new Promise((ok, ko) => {
    const r = indexedDB.open(NOME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
  return apertura;
}

async function op(modo, fn) {
  const d = await idb();
  return new Promise((ok, ko) => {
    const t = d.transaction(STORE, modo);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(req?.result);
    t.onerror = () => ko(t.error);
    t.onabort = () => ko(t.error || new Error('scrittura annullata'));
  });
}

export const carica = () => op('readonly', s => s.get('db'));

export function salva(bytes) {
  coda = coda.then(() => op('readwrite', s => { s.put(bytes, 'db'); s.put(new Date().toISOString(), 'salvato_il'); }));
  return coda;
}

export async function cancella() { await op('readwrite', s => s.clear()); }

export async function chiediPersistenza() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist(); return true; }
  catch { return false; }
}
