// Database SQLite (sql.js) con lo stesso schema dell'app Python, più kv per le impostazioni.
// Gli obiettivi settimanali (gruppi.g_settimana) non sono nel codice: arrivano dall'import
// dell'app del Mac o dalla pagina Piano.

// [id, nome, tipo, pasto, durata_gg, porzione_g, porzione_nome]
// tipo: piano | extra | fuori_piano | non_alimentare; pasto: principale | colazione (serve per i pasti fuori)
export const GRUPPI = [
  ['verdure', 'Verdure', 'piano', 'principale', 5, 200, 'porzioni'],
  ['frutta', 'Frutta fresca', 'piano', 'colazione', 7, 150, 'frutti'],
  ['pane', 'Pane e sostituti', 'piano', 'principale', 5, 100, 'porzioni'],
  ['cho_secchi', 'Pasta, riso, cereali', 'piano', 'principale', 365, 120, 'porzioni'],
  ['olio', 'Olio EVO', 'piano', 'principale', 365, 10, 'cucchiai'],
  ['carne_bianca', 'Carne bianca', 'piano', 'principale', 3, 200, 'porzioni'],
  ['carne_rossa', 'Carne rossa', 'piano', 'principale', 3, 150, 'porzioni'],
  ['pesce_magro', 'Pesce magro', 'piano', 'principale', 3, 200, 'porzioni'],
  ['pesce_scatola', 'Tonno/pesce in scatola', 'piano', 'principale', 365, 60, 'porzioni'],
  ['legumi', 'Legumi', 'piano', 'principale', 365, 150, 'porzioni'],
  ['uova', 'Uova', 'piano', 'principale', 21, 60, 'uova'],
  ['formaggio_magro', 'Formaggio magro', 'piano', 'principale', 5, 100, 'porzioni'],
  ['formaggio_stagionato', 'Formaggio stagionato', 'piano', 'principale', 21, 50, 'porzioni'],
  ['formaggio_fresco', 'Formaggio fresco', 'extra', 'principale', 7, 50, 'porzioni'],
  ['yogurt', 'Yogurt greco 0%', 'piano', 'colazione', 14, 125, 'vasetti'],
  ['latte', 'Latte', 'piano', 'colazione', 10, 250, 'tazze'],
  ['frutta_secca', 'Frutta secca', 'piano', 'colazione', 60, 20, 'porzioni'],
  ['brioche', 'Brioche', 'piano', 'colazione', 7, 70, 'pezzi'],
  ['dolci', 'Dolci', 'piano', 'colazione', 14, 80, 'porzioni'],
  ['pesce_grasso', 'Pesce grasso', 'extra', 'principale', 3, 150, 'porzioni'],
  ['affettati', 'Affettati', 'extra', 'principale', 7, 70, 'porzioni'],
  ['condimenti', 'Condimenti e spezie', 'extra', null, null, null, null],
  ['bevande', 'Bevande', 'extra', null, null, null, null],
  ['fuori_piano', 'Fuori piano', 'fuori_piano', null, 7, null, null],
  ['non_alimentare', 'Non alimentare', 'non_alimentare', null, null, null, null],
];

// Tabelle di conversione. Carboidrati: 120 g CHO secchi = 160 g pane.
// Formaggi: 100 g magro = 50 g fresco = 35 g stagionato.
export const FAMIGLIE = {
  carboidrati: { nome: 'Carboidrati', riferimento: 'cho_secchi', membri: { cho_secchi: 1.0, pane: 120 / 160 } },
  formaggi: {
    nome: 'Formaggi', riferimento: 'formaggio_magro',
    membri: { formaggio_magro: 1.0, formaggio_fresco: 100 / 50, formaggio_stagionato: 100 / 35 },
  },
};

export const PREPARAZIONI = ['fresco', 'pronto', 'preparato', 'surgelato', 'conserva'];
export const DURATA_PREP = { surgelato: 90, conserva: 365 };   // sostituisce la durata del gruppo
export const PREZZO_INIZIALE = '2000-01-01';                     // "primo prezzo noto"

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS gruppi (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT NOT NULL, pasto TEXT,
  g_settimana REAL, durata_gg INTEGER, porzione_g REAL, porzione_nome TEXT, ordine INTEGER,
  famiglia TEXT, fattore REAL
);
CREATE TABLE IF NOT EXISTS stato_gruppi (
  gruppo_id TEXT PRIMARY KEY REFERENCES gruppi(id), stato TEXT NOT NULL, il TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scontrini (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, ora TEXT, documento TEXT, negozio TEXT,
  totale REAL, quadra INTEGER DEFAULT 1, file TEXT, importato_il TEXT
);
CREATE TABLE IF NOT EXISTS prodotti (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE, gruppo_id TEXT NOT NULL REFERENCES gruppi(id),
  preparazione TEXT, peso_conf_g REAL, ean TEXT UNIQUE, kcal_100g REAL
);
CREATE TABLE IF NOT EXISTS righe (
  id INTEGER PRIMARY KEY,
  scontrino_id TEXT NOT NULL REFERENCES scontrini(id) ON DELETE CASCADE,
  n INTEGER NOT NULL, descrizione TEXT NOT NULL, iva INTEGER,
  prezzo REAL NOT NULL, sconto REAL NOT NULL DEFAULT 0, netto REAL NOT NULL,
  peso_g REAL, peso_saltato INTEGER NOT NULL DEFAULT 0,
  prodotto_id INTEGER REFERENCES prodotti(id),
  UNIQUE (scontrino_id, n)
);
CREATE TABLE IF NOT EXISTS alias (
  descrizione TEXT PRIMARY KEY, prodotto_id INTEGER REFERENCES prodotti(id), saltato_il TEXT
);
CREATE TABLE IF NOT EXISTS pesate (
  id INTEGER PRIMARY KEY, prodotto_id INTEGER NOT NULL REFERENCES prodotti(id),
  riga_id INTEGER REFERENCES righe(id) ON DELETE SET NULL, grammi REAL NOT NULL, data TEXT
);
CREATE TABLE IF NOT EXISTS prezzi_kg (
  prodotto_id INTEGER NOT NULL REFERENCES prodotti(id) ON DELETE CASCADE,
  dal TEXT NOT NULL, prezzo_kg REAL NOT NULL, PRIMARY KEY (prodotto_id, dal)
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

// Le righe trovano il prodotto via alias (descrizione stampata), salvo le voci generiche
// assegnate al singolo acquisto (righe.prodotto_id). Ogni acquisto usa il €/kg in vigore
// alla sua data; se è precedente al primo prezzo noto, il primo.
const VISTE = `
DROP VIEW IF EXISTS v_righe;
DROP VIEW IF EXISTS v_righe_base;
CREATE VIEW v_righe_base AS
SELECT r.id, r.scontrino_id, r.n, r.descrizione, r.iva, r.prezzo, r.sconto, r.netto,
       r.peso_g, r.peso_saltato, s.data, s.negozio,
       p.id AS prodotto_id, (r.prodotto_id IS NOT NULL) AS per_riga, p.nome AS prodotto, p.gruppo_id,
       p.preparazione, p.peso_conf_g, p.ean, p.kcal_100g, g.nome AS gruppo, g.tipo,
       COALESCE((SELECT pk.prezzo_kg FROM prezzi_kg pk
                 WHERE pk.prodotto_id = p.id AND pk.dal <= s.data ORDER BY pk.dal DESC LIMIT 1),
                (SELECT pk.prezzo_kg FROM prezzi_kg pk
                 WHERE pk.prodotto_id = p.id ORDER BY pk.dal ASC LIMIT 1)) AS prezzo_kg
FROM righe r
JOIN scontrini s      ON s.id = r.scontrino_id
LEFT JOIN alias a     ON a.descrizione = r.descrizione
LEFT JOIN prodotti p  ON p.id = COALESCE(r.prodotto_id, a.prodotto_id)
LEFT JOIN gruppi g    ON g.id = p.gruppo_id;

CREATE VIEW v_righe AS
SELECT b.*,
       CASE WHEN b.peso_g IS NOT NULL THEN 'inserito'
            WHEN b.prezzo_kg > 0 THEN 'da €/kg'
            WHEN EXISTS (SELECT 1 FROM pesate pe WHERE pe.prodotto_id = b.prodotto_id) THEN 'media pesate'
            WHEN b.peso_conf_g IS NOT NULL THEN 'confezione' END AS fonte_peso,
       COALESCE(b.peso_g,
                CASE WHEN b.prezzo_kg > 0 THEN ROUND(b.prezzo / b.prezzo_kg * 1000) END,
                (SELECT AVG(grammi) FROM pesate pe WHERE pe.prodotto_id = b.prodotto_id),
                b.peso_conf_g) AS peso_stimato
FROM v_righe_base b;
`;

export const TABELLE_DATI = ['stato_gruppi', 'pesate', 'prezzi_kg', 'alias', 'righe', 'scontrini', 'prodotti'];

export class Db {
  constructor(SQL, bytes) {
    this.SQL = SQL;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.exec('PRAGMA foreign_keys = ON');
  }
  all(sql, params = []) {
    const st = this.db.prepare(sql);
    try {
      st.bind(params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally { st.free(); }
  }
  one(sql, params) { return this.all(sql, params)[0] || null; }
  val(sql, params) { const r = this.one(sql, params); return r ? Object.values(r)[0] : null; }
  run(sql, params = []) {
    this.db.run(sql, params);
    return { changes: this.db.getRowsModified(), id: this.val('SELECT last_insert_rowid() AS id') };
  }
  exec(sql) { this.db.exec(sql); }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  export() {
    const b = this.db.export();               // sql.js riapre il db: i PRAGMA tornano ai default
    this.db.exec('PRAGMA foreign_keys = ON');
    return b;
  }
  close() { this.db.close(); }
  kvGet(k, def = null) { const v = this.val('SELECT v FROM kv WHERE k=?', [k]); return v === null ? def : v; }
  kvSet(k, v) {
    if (v === null || v === undefined) this.run('DELETE FROM kv WHERE k=?', [k]);
    else this.run('INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, String(v)]);
  }
}

export function init(db) {
  const versione = db.val('PRAGMA user_version') || 0;
  if (versione < 1) {
    db.exec(SCHEMA_V1);
    db.exec('PRAGMA user_version = 1');
  }
  db.exec(VISTE);
  GRUPPI.forEach((g, i) => {
    db.run(`INSERT INTO gruppi (id, nome, tipo, pasto, durata_gg, porzione_g, porzione_nome, ordine)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, tipo=excluded.tipo, pasto=excluded.pasto,
              durata_gg=excluded.durata_gg, porzione_g=excluded.porzione_g,
              porzione_nome=excluded.porzione_nome, ordine=excluded.ordine`, [...g, i]);
  });
  db.run('UPDATE gruppi SET famiglia=NULL, fattore=NULL');
  for (const [fid, f] of Object.entries(FAMIGLIE))
    for (const [gid, fatt] of Object.entries(f.membri))
      db.run('UPDATE gruppi SET famiglia=?, fattore=? WHERE id=?', [fid, fatt, gid]);
}

/** Crea o aggiorna il prodotto `nome`; con `descrizione` lo collega alla voce dello scontrino.
 *  kcal ed EAN vuoti non cancellano valori già presenti; prezzo_kg aggiunge un prezzo allo storico. */
export function salvaProdotto(db, { descrizione = null, nome, gruppo_id, preparazione = null, peso_conf_g = null,
  kcal_100g = null, ean = null, prezzo_kg = null, prezzo_dal = null, oggi }) {
  if (ean) db.run('UPDATE prodotti SET ean=NULL WHERE ean=? AND nome<>?', [ean, nome]);
  const p = db.one('SELECT id FROM prodotti WHERE nome = ?', [nome]);
  let pid;
  if (p) {
    pid = p.id;
    db.run(`UPDATE prodotti SET gruppo_id=?, preparazione=?, peso_conf_g=?,
              kcal_100g=COALESCE(?, kcal_100g), ean=COALESCE(?, ean) WHERE id=?`,
      [gruppo_id, preparazione, peso_conf_g, kcal_100g, ean, pid]);
  } else {
    pid = db.run(`INSERT INTO prodotti (nome, gruppo_id, preparazione, peso_conf_g, kcal_100g, ean)
                  VALUES (?,?,?,?,?,?)`, [nome, gruppo_id, preparazione, peso_conf_g, kcal_100g, ean]).id;
  }
  if (prezzo_kg) aggiungiPrezzo(db, pid, prezzo_kg, prezzo_dal || oggi);
  if (descrizione) {
    db.run(`INSERT INTO alias (descrizione, prodotto_id, saltato_il) VALUES (?,?,NULL)
            ON CONFLICT(descrizione) DO UPDATE SET prodotto_id=excluded.prodotto_id, saltato_il=NULL`,
      [descrizione, pid]);
  }
  return pid;
}

export function aggiungiPrezzo(db, prodotto_id, prezzo_kg, dal) {
  db.run(`INSERT INTO prezzi_kg (prodotto_id, dal, prezzo_kg) VALUES (?,?,?)
          ON CONFLICT(prodotto_id, dal) DO UPDATE SET prezzo_kg=excluded.prezzo_kg`, [prodotto_id, dal, prezzo_kg]);
}

/** Aggiornamento completo dalla scheda prodotto: un campo vuoto cancella il valore. */
export function aggiornaProdotto(db, id, { nome, gruppo_id, preparazione, peso_conf_g, kcal_100g, ean }) {
  if (ean) db.run('UPDATE prodotti SET ean=NULL WHERE ean=? AND id<>?', [ean, id]);
  db.run(`UPDATE prodotti SET nome=?, gruppo_id=?, preparazione=?, peso_conf_g=?, kcal_100g=?, ean=? WHERE id=?`,
    [nome, gruppo_id, preparazione, peso_conf_g, kcal_100g, ean, id]);
}

export function prodottoInUso(db, id) {
  return db.val(`SELECT (SELECT COUNT(*) FROM alias WHERE prodotto_id=?) + (SELECT COUNT(*) FROM righe WHERE prodotto_id=?)
                        + (SELECT COUNT(*) FROM pesate WHERE prodotto_id=?)`, [id, id, id]) > 0;
}
