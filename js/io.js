// Import/export: CSV, zip dell'app del Mac, export per l'analisi, backup SQLite.
import { TABELLE_DATI, PREZZO_INIZIALE, init } from './db.js';

const fflate = () => globalThis.fflate;

// ---------------------------------------------------------------- CSV (RFC 4180, come il modulo csv di Python)
export function parseCsv(testo) {
  const righe = [];
  let riga = [], campo = '', virgolette = false;
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    if (virgolette) {
      if (c === '"') { if (testo[i + 1] === '"') { campo += '"'; i++; } else virgolette = false; }
      else campo += c;
    } else if (c === '"') virgolette = true;
    else if (c === ',') { riga.push(campo); campo = ''; }
    else if (c === '\n') { riga.push(campo); righe.push(riga); riga = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
  if (!righe.length) return [];
  const [intest, ...dati] = righe;
  return dati.filter(r => r.length > 1 || r[0] !== '').map(r => Object.fromEntries(intest.map((k, i) => [k, r[i] ?? ''])));
}

const csvCampo = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(righe, colonne) {
  const cols = colonne || (righe[0] ? Object.keys(righe[0]) : []);
  return [cols.map(csvCampo).join(','), ...righe.map(r => cols.map(c => csvCampo(r[c])).join(','))].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- import dallo zip dell'app del Mac
const ORDINE_IMPORT = ['prodotti', 'scontrini', 'righe', 'alias', 'pesate', 'prezzi_kg', 'stato_gruppi'];

export function leggiZipMac(bytes) {
  const file = fflate().unzipSync(bytes);
  const tabelle = {};
  for (const [nome, contenuto] of Object.entries(file)) {
    const base = nome.split('/').pop();
    if (base.endsWith('.csv')) tabelle[base.slice(0, -4)] = parseCsv(fflate().strFromU8(contenuto));
  }
  for (const t of ['scontrini', 'righe', 'prodotti', 'alias'])
    if (!tabelle[t]) throw new Error(`nello zip manca ${t}.csv: non sembra un export dell'app`);
  return tabelle;
}

/** Sostituisce tutti i dati con quelli dello zip. Ritorna i conteggi importati. */
export function importaZipMac(db, tabelle) {
  const colonne = t => new Set(db.all(`PRAGMA table_info(${t})`).map(c => c.name));
  const nulli = v => (v === '' ? null : v);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    return db.tx(() => {
      for (const t of TABELLE_DATI) db.run(`DELETE FROM ${t}`);
      const conteggi = {};
      for (const t of ORDINE_IMPORT) {
        const righe = tabelle[t] || [];
        const ok = colonne(t);
        for (const r of righe) {
          const cols = Object.keys(r).filter(c => ok.has(c));
          db.run(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => nulli(r[c])));
        }
        conteggi[t] = righe.length;
      }
      // versione Python senza storico prezzi: il €/kg del prodotto diventa il primo prezzo noto
      for (const p of tabelle.prodotti) {
        const v = parseFloat(p.prezzo_kg);
        if (v > 0) db.run('INSERT OR IGNORE INTO prezzi_kg (prodotto_id, dal, prezzo_kg) VALUES (?,?,?)', [p.id, PREZZO_INIZIALE, v]);
      }
      // obiettivi del piano
      for (const g of tabelle.gruppi || []) {
        if (!('g_settimana' in g)) continue;
        db.run('UPDATE gruppi SET g_settimana=? WHERE id=?', [nulli(g.g_settimana), g.id]);
      }
      const rotti = db.all('PRAGMA foreign_key_check');
      if (rotti.length) throw new Error(`dati incoerenti nello zip (${rotti.length} riferimenti rotti, es. ${rotti[0].table})`);
      return conteggi;
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// ---------------------------------------------------------------- export per l'analisi (stesso formato dell'app Python)
export function zipExport(db) {
  const file = {};
  for (const t of ['gruppi', 'scontrini', 'righe', 'prodotti', 'alias', 'pesate', 'prezzi_kg', 'stato_gruppi', 'v_righe']) {
    const cols = db.all(`PRAGMA table_info(${t})`).map(c => c.name);
    file[`${t}.csv`] = fflate().strToU8(toCsv(db.all(`SELECT * FROM ${t}`), cols));
  }
  return fflate().zipSync(file, { level: 6 });
}

// ---------------------------------------------------------------- backup
export function apriBackup(SQL, bytes) {
  const intestazione = new TextDecoder().decode(bytes.slice(0, 15));
  if (intestazione !== 'SQLite format 3') throw new Error('non è un file di backup di questa app');
  const prova = new SQL.Database(bytes);
  try {
    const t = prova.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat() || [];
    for (const n of ['scontrini', 'righe', 'prodotti', 'alias']) if (!t.includes(n)) throw new Error(`il backup non contiene la tabella ${n}`);
  } finally { prova.close(); }
  return bytes;
}

export { init };
