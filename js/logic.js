// Cose da fare, statistiche e lista "cosa comprare" (porting dell'app Python).
import { DURATA_PREP, FAMIGLIE, RUOLI, TRACCIATI, PASTI_PIANO } from './db.js';
import { piuGiorni, diffGiorni, giorno, daGiorno } from './date.js';

const TIPI_DA_PESARE = "('piano','fuori_piano')";

// Si chiede il peso di un acquisto se: il prodotto non ha peso fisso né €/kg, l'acquisto non ha peso,
// non è stato saltato, e il prodotto non ha ancora pesate (poi vale la media) oppure
// l'acquisto è degli ultimi 7 giorni (l'etichetta probabilmente c'è ancora).
const DA_PESARE = `v.prodotto_id IS NOT NULL AND v.tipo IN ${TIPI_DA_PESARE}
    AND v.peso_conf_g IS NULL AND v.prezzo_kg IS NULL AND v.peso_g IS NULL AND v.peso_saltato = 0
    AND (NOT EXISTS (SELECT 1 FROM pesate pe WHERE pe.prodotto_id = v.prodotto_id) OR v.data >= :d7)`;

// ---------------------------------------------------------------- cose da fare
const SELECT_VOCE = `SELECT r.descrizione, COUNT(*) n, MIN(s.data) prima, MAX(s.data) ultima,
       GROUP_CONCAT(printf('%.2f', r.netto), ' · ') prezzi
  FROM righe r JOIN scontrini s ON s.id = r.scontrino_id
  LEFT JOIN alias a ON a.descrizione = r.descrizione`;

/** Descrizione senza prodotto, la più frequente per prima. Le saltate solo su richiesta. */
export function prossimoAlias(db, saltati = false) {
  const filtro = saltati
    ? 'a.prodotto_id IS NULL AND a.saltato_il IS NOT NULL'
    : 'a.descrizione IS NULL OR (a.prodotto_id IS NULL AND a.saltato_il IS NULL)';
  return db.one(`${SELECT_VOCE} WHERE (${filtro}) AND r.prodotto_id IS NULL
                 GROUP BY r.descrizione ORDER BY n DESC, ultima DESC LIMIT 1`);
}

export function voce(db, descrizione) {
  return db.one(`${SELECT_VOCE} WHERE r.descrizione = ? GROUP BY r.descrizione`, [descrizione]);
}

/** Acquisto più recente di un prodotto senza peso fisso né €/kg, ancora senza peso e non saltato. */
export function prossimaPesata(db, oggi) {
  return db.one(`SELECT v.*, (SELECT COUNT(*) FROM pesate WHERE prodotto_id = v.prodotto_id) n_pesate,
                        (SELECT AVG(grammi) FROM pesate WHERE prodotto_id = v.prodotto_id) media
                 FROM v_righe v WHERE ${DA_PESARE}
                 ORDER BY v.data DESC, v.scontrino_id, v.n LIMIT 1`, { ':d7': piuGiorni(oggi, -7) });
}

export function daFare(db, oggi) {
  const q = (sql, p) => db.val(sql, p);
  return {
    scontrini: q('SELECT COUNT(*) FROM scontrini'),
    dal: q('SELECT MIN(data) FROM scontrini'),
    al: q('SELECT MAX(data) FROM scontrini'),
    da_classificare: q(`SELECT COUNT(DISTINCT r.descrizione) FROM righe r
                        LEFT JOIN alias a ON a.descrizione = r.descrizione
                        WHERE (a.descrizione IS NULL OR (a.prodotto_id IS NULL AND a.saltato_il IS NULL))
                          AND r.prodotto_id IS NULL`),
    saltati: q(`SELECT COUNT(*) FROM alias a WHERE prodotto_id IS NULL AND saltato_il IS NOT NULL
                AND EXISTS (SELECT 1 FROM righe r WHERE r.descrizione = a.descrizione AND r.prodotto_id IS NULL)`),
    da_pesare: q(`SELECT COUNT(*) FROM v_righe v WHERE ${DA_PESARE}`, { ':d7': piuGiorni(oggi, -7) }),
    non_quadrano: q('SELECT COUNT(*) FROM scontrini WHERE quadra = 0'),
    senza_kcal: q(`SELECT COUNT(DISTINCT prodotto_id) FROM v_righe
                   WHERE tipo IN ${TIPI_DA_PESARE} AND kcal_100g IS NULL`),
  };
}

// ---------------------------------------------------------------- statistiche
export function statistiche(db, oggi, giorni = 28) {
  const da = piuGiorni(oggi, -(giorni - 1));
  const prima = db.val('SELECT MIN(data) FROM scontrini');
  if (!prima) return null;
  const giorni_eff = Math.min(giorni, diffGiorni(oggi, prima) + 1);
  const sett_eff = Math.max(giorni_eff / 7, 1 / 7);

  const per_settimana = db.all(`
    SELECT strftime('%Y-%W', data) sett, MIN(data) dal, MAX(data) al, COUNT(DISTINCT scontrino_id) n,
           SUM(netto) tot,
           SUM(peso_stimato * kcal_100g / 100) kcal,
           SUM(CASE WHEN tipo IN ('piano','fuori_piano') AND (peso_stimato IS NULL OR kcal_100g IS NULL)
                    THEN 1 ELSE 0 END) senza_kcal,
           SUM(CASE WHEN tipo IN ('piano','extra') THEN netto ELSE 0 END) cibo,
           SUM(CASE WHEN tipo = 'fuori_piano' THEN netto ELSE 0 END) fuori,
           SUM(CASE WHEN tipo = 'non_alimentare' THEN netto ELSE 0 END) casa,
           SUM(CASE WHEN tipo IS NULL THEN netto ELSE 0 END) ignoto
    FROM v_righe GROUP BY sett ORDER BY sett DESC`);

  const gruppi = db.all(`
    SELECT g.id, g.nome, g.tipo, g.g_settimana,
           COUNT(v.id) n, COALESCE(SUM(v.netto),0) euro,
           COALESCE(SUM(v.peso_stimato),0) grammi,
           COALESCE(SUM(v.peso_stimato * v.kcal_100g / 100),0) kcal,
           SUM(CASE WHEN v.id IS NOT NULL AND v.peso_stimato IS NULL THEN 1 ELSE 0 END) senza_peso,
           MAX(v.data) ultimo
    FROM gruppi g LEFT JOIN v_righe v ON v.gruppo_id = g.id AND v.data >= ?
    WHERE g.tipo IN ('piano','extra','fuori_piano')
    GROUP BY g.id ORDER BY g.ordine`, [da]).map(g => {
    g.parziale = g.senza_peso > 0;
    g.g_sett = g.n && g.senza_peso < g.n ? g.grammi / sett_eff : null;
    // copertura solo se tutti gli acquisti hanno un peso, altrimenti sarebbe sottostimata
    g.copertura = g.g_sett && g.g_settimana && !g.parziale ? g.g_sett / g.g_settimana * 100 : null;
    return g;
  });

  const fuori_piano = db.all(`
    SELECT prodotto, COUNT(*) n, SUM(netto) euro, SUM(peso_stimato) grammi,
           SUM(peso_stimato * kcal_100g / 100) kcal, MAX(data) ultimo
    FROM v_righe WHERE tipo = 'fuori_piano' AND data >= ?
    GROUP BY prodotto ORDER BY n DESC`, [da]);

  const preparazione = db.all(`
    SELECT COALESCE(preparazione,'?') prep, COUNT(*) n, SUM(netto) euro
    FROM v_righe WHERE tipo IN ('piano','extra','fuori_piano') AND data >= ?
    GROUP BY prep ORDER BY euro DESC`, [da]);

  const varieta = db.all(`
    SELECT gruppo, COUNT(DISTINCT prodotto) distinti, GROUP_CONCAT(DISTINCT prodotto) quali
    FROM v_righe WHERE gruppo_id IN ('verdure','frutta','carne_bianca','carne_rossa','pesce_magro','legumi')
      AND data >= ? GROUP BY gruppo ORDER BY distinti DESC`, [da]);

  const perId = Object.fromEntries(gruppi.map(g => [g.id, g]));
  const famiglie = Object.entries(FAMIGLIE).map(([, f]) => {
    const membri = Object.entries(f.membri).map(([gid, fattore]) => {
      const g = perId[gid] || { ...db.one('SELECT id, nome, g_settimana FROM gruppi WHERE id=?', [gid]), g_sett: null, senza_peso: 0 };
      return { nome: g.nome, fattore, g_sett: g.g_sett || 0, piano: g.g_settimana || 0, parziale: !!g.senza_peso };
    });
    const piano = membri.reduce((s, m) => s + m.piano * m.fattore, 0);
    const comprato = membri.reduce((s, m) => s + m.g_sett * m.fattore, 0);
    return {
      nome: f.nome, rif: perId[f.riferimento]?.nome || f.riferimento, membri, piano, comprato,
      pct: piano ? comprato / piano * 100 : null, parziale: membri.some(m => m.parziale),
    };
  });

  const q = sql => db.val(sql);
  const completezza = {
    righe: q('SELECT COUNT(*) FROM righe'),
    classificate: q('SELECT COUNT(*) FROM v_righe WHERE prodotto_id IS NOT NULL'),
    cibo: q(`SELECT COUNT(*) FROM v_righe WHERE tipo IN ${TIPI_DA_PESARE}`),
    cibo_con_peso: q(`SELECT COUNT(*) FROM v_righe WHERE tipo IN ${TIPI_DA_PESARE} AND peso_stimato IS NOT NULL`),
    cibo_con_kcal: q(`SELECT COUNT(*) FROM v_righe WHERE tipo IN ${TIPI_DA_PESARE}
                      AND peso_stimato IS NOT NULL AND kcal_100g IS NOT NULL`),
  };
  const kcal_tot = gruppi.reduce((s, g) => s + (g.tipo === 'piano' || g.tipo === 'fuori_piano' || g.tipo === 'extra' ? g.kcal : 0), 0);
  return { giorni, giorni_eff, da, per_settimana, gruppi, famiglie, fuori_piano, preparazione, varieta,
    completezza, kcal_tot, kcal_giorno: kcal_tot / giorni_eff };
}

// ---------------------------------------------------------------- dispensa e lista
const STORIA = 120;          // giorni di acquisti e conte usati per ricostruire la dispensa
const FINESTRA = 28;         // giorni su cui si misura il ritardo rispetto al piano
const BONUS_IN_CASA = 0.25;  // a ritardo quasi uguale, prima il gruppo che hai già in casa
const SOGLIA_DISPENSA = 60;  // lotti che durano almeno tanto non calano da soli (pasta, legumi, surgelati)

const arrotonda05 = v => Math.round(v * 2) / 2;

/** Ricostruisce la dispensa di un gruppo giorno per giorno:
 *  acquisti → lotti; i lotti freschi calano al ritmo del piano e a scadenza si considerano mangiati;
 *  una conta fissa le porzioni in casa (la differenza diventa consumo, o un lotto in più se ne trovi di più). */
function simula(g, acquisti, conte, oggi) {
  const porz = g.porzione_g || 100;
  const durataGruppo = g.durata_gg || 7;
  const ritmo = g.g_settimana ? g.g_settimana / 7 : 0;
  const eventi = [
    ...acquisti.map(a => ({ ts: `${a.data} ${a.ora || '12:00'}:00`, t: giorno(a.data), tipo: 'acq',
      g: a.peso_stimato ?? porz, durata: DURATA_PREP[a.preparazione] || durataGruppo })),
    ...conte.map(c => ({ ts: c.il, t: giorno(c.il), tipo: 'conta', porzioni: c.porzioni })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const fine = giorno(oggi);
  const consumi = [];
  let lotti = [], k = 0;
  const consuma = (grammi, t, soloFreschi) => {
    let resto = grammi;
    for (const l of [...lotti].sort((a, b) => a.scade - b.scade)) {
      if (resto <= 0) break;
      if (soloFreschi && !l.fresco) continue;
      const preso = Math.min(l.g, resto);
      l.g -= preso; resto -= preso;
      if (preso > 0) consumi.push({ t, g: preso });
    }
    lotti = lotti.filter(l => l.g > 0.5);
  };
  const inizio = eventi.length ? Math.min(eventi[0].t, fine) : fine;
  for (let t = inizio; t <= fine; t++) {
    for (const l of lotti.filter(x => x.scade < t)) consumi.push({ t: l.scade, g: l.g });
    lotti = lotti.filter(x => x.scade >= t);
    for (; k < eventi.length && eventi[k].t === t; k++) {
      const e = eventi[k];
      if (e.tipo === 'acq') lotti.push({ g: e.g, scade: t + e.durata, fresco: e.durata < SOGLIA_DISPENSA });
      else {
        const totale = lotti.reduce((s, l) => s + l.g, 0), voluto = e.porzioni * porz;
        if (voluto < totale) consuma(totale - voluto, t, false);
        else if (voluto > totale) lotti.push({ g: voluto - totale, scade: t + durataGruppo, fresco: durataGruppo < SOGLIA_DISPENSA });
      }
    }
    if (t < fine && ritmo) consuma(ritmo, t, true);   // i giorni già passati
  }
  const ultimo = consumi.length ? Math.max(...consumi.map(c => c.t)) : null;
  return {
    stock_g: lotti.reduce((s, l) => s + l.g, 0),
    consumi,
    ultimoConsumo: ultimo === null ? null : daGiorno(ultimo),
    ultimaConta: conte.length ? conte[conte.length - 1].il : null,
  };
}

/** Dispensa dei gruppi tracciati, con consumo stimato e ritardo dei secondi rispetto al piano. */
export function dispensa(db, oggi) {
  const da = piuGiorni(oggi, -STORIA);
  const finestra = giorno(oggi) - FINESTRA + 1;
  const gruppi = db.all(`SELECT * FROM gruppi WHERE id IN (${TRACCIATI.map(() => '?').join(',')})`, TRACCIATI);
  const out = {};
  for (const g of gruppi) {
    const acquisti = db.all(`SELECT v.data, s.ora, v.peso_stimato, v.preparazione FROM v_righe v
        JOIN scontrini s ON s.id = v.scontrino_id WHERE v.gruppo_id = ? AND v.data >= ? AND v.data <= ?`, [g.id, da, oggi]);
    const conte = db.all('SELECT il, porzioni FROM conte WHERE gruppo_id = ? AND il >= ? ORDER BY il', [g.id, da]);
    const sim = simula(g, acquisti, conte, oggi);
    const porz = g.porzione_g || 100;
    const consumatiG = sim.consumi.filter(c => c.t >= finestra).reduce((s, c) => s + c.g, 0);
    out[g.id] = {
      id: g.id, gruppo: g.nome, porzione_g: porz, porzione_nome: g.porzione_nome,
      ruolo: RUOLI.secondo.includes(g.id) ? 'secondo' : 'per_pasto',
      g_settimana: g.g_settimana, ordine: g.ordine,
      stock_g: sim.stock_g, stock_porz: sim.stock_g / porz, mostra: arrotonda05(sim.stock_g / porz),
      consumati: consumatiG / porz, ultimoConsumo: sim.ultimoConsumo, ultimaConta: sim.ultimaConta,
    };
  }
  // quote del piano: porzioni a settimana di ciascun secondo sul totale dei secondi
  const sec = RUOLI.secondo.map(id => out[id]).filter(Boolean);
  sec.forEach(s => { s.porzSett = s.g_settimana && s.porzione_g ? s.g_settimana / s.porzione_g : 0; });
  const totSett = sec.reduce((t, s) => t + s.porzSett, 0);
  const totConsumati = sec.filter(s => s.porzSett > 0).reduce((t, s) => t + s.consumati, 0);
  sec.forEach(s => {
    s.quota = totSett ? s.porzSett / totSett : 0;
    s.attesi = s.quota * totConsumati;
    s.ritardo = s.quota ? s.attesi - s.consumati : 0;
  });
  return { gruppi: out, secondi: sec, totConsumati, finestra: FINESTRA };
}

/** Lista per i prossimi `pasti` pasti principali a casa (pranzi o cene). */
export function lista(db, oggi, pasti = 4) {
  const d = dispensa(db, oggi);
  const P = Math.max(0, Math.round(pasti));
  // secondi: ogni pasto va al gruppo più indietro rispetto al piano, contando anche i pasti in arrivo
  const sec = d.secondi.filter(s => s.quota > 0).map(s => ({
    ...s, domanda: s.ritardo + s.quota * P, disponibili: Math.floor(s.stock_porz + 0.25), assegnati: 0,
  }));
  const sequenza = [];
  for (let n = 0; n < P && sec.length; n++) {
    let best = null, punteggio = -Infinity;
    for (const s of sec) {
      const p = s.domanda + (s.assegnati < s.disponibili ? BONUS_IN_CASA : 0);
      if (p > punteggio + 1e-9 || (Math.abs(p - punteggio) < 1e-9 && s.quota > best.quota)) { best = s; punteggio = p; }
    }
    sequenza.push({ id: best.id, gruppo: best.gruppo, inCasa: best.assegnati < best.disponibili });
    best.assegnati++; best.domanda -= 1;
  }
  sec.forEach(s => { s.daComprare = Math.max(0, s.assegnati - s.disponibili); });
  // con quello che c'è: il gruppo in casa più indietro rispetto al piano
  const inCasa = sec.filter(s => s.disponibili >= 1).sort((a, b) => (b.ritardo + b.quota) - (a.ritardo + a.quota));
  const prossimo = inCasa[0] || null;

  // per pasto: piano settimanale / pasti del piano, in porzioni intere
  const G = d.gruppi;
  const perPasto = id => (G[id]?.g_settimana || 0) / PASTI_PIANO;
  const intere = (manca, porz) => (manca > porz * 0.25 ? Math.ceil(manca / porz) : 0);
  const compraPasto = [];
  for (const id of ['verdure', 'frutta']) {
    if (!G[id]) continue;
    const serve = perPasto(id) * P, manca = Math.max(0, serve - G[id].stock_g), n = intere(manca, G[id].porzione_g);
    if (n) compraPasto.push({ id, gruppo: G[id].gruppo, porzioni: n, porzione_nome: G[id].porzione_nome, g: n * G[id].porzione_g, serve, stock_g: G[id].stock_g });
  }
  if (G.cho_secchi && G.pane) {
    const f = FAMIGLIE.carboidrati.membri;
    const serve = (perPasto('cho_secchi') * f.cho_secchi + perPasto('pane') * f.pane) * P;
    const stock = G.cho_secchi.stock_g * f.cho_secchi + G.pane.stock_g * f.pane;
    const manca = Math.max(0, serve - stock);
    const opzioni = ['cho_secchi', 'pane'].map(id => {
      const n = intere(manca / f[id], G[id].porzione_g);
      return { id, gruppo: G[id].gruppo, porzioni: n, g: n * G[id].porzione_g };
    });
    if (opzioni.some(o => o.porzioni)) compraPasto.push({ id: 'carboidrati', gruppo: 'Pasta, riso o pane', opzioni, serve, stock_g: stock });
  }

  const non_comprare = db.all(`
    SELECT prodotto, COUNT(*) n, MAX(data) ultimo FROM v_righe
    WHERE tipo='fuori_piano' AND data >= ?
    GROUP BY prodotto HAVING n >= 2 ORDER BY n DESC`, [piuGiorni(oggi, -14)]);
  const tracciati = TRACCIATI.map(id => G[id]).filter(Boolean);
  return { pasti: P, sequenza, prossimo, secondi: sec, compraSecondi: sec.filter(s => s.daComprare > 0),
    compraPasto, dispensa: tracciati, non_comprare, totConsumati: d.totConsumati, finestra: d.finestra };
}

// ---------------------------------------------------------------- prodotti
/** Una riga per coppia (voce dello scontrino, prodotto), più i prodotti senza acquisti.
 *  In cima chi ha più dati mancanti, a parità i più comprati. */
export function elencoProdotti(db) {
  const righe = db.all(`
    SELECT v.descrizione, MAX(v.per_riga) per_riga, a.saltato_il, p.id prodotto_id, p.nome, p.preparazione,
           p.peso_conf_g, p.ean, p.kcal_100g, g.nome gruppo, g.tipo, g.ordine,
           (SELECT prezzo_kg FROM prezzi_kg pk WHERE pk.prodotto_id = p.id ORDER BY dal DESC LIMIT 1) prezzo_kg,
           (SELECT COUNT(*) FROM prezzi_kg pk WHERE pk.prodotto_id = p.id) n_prezzi,
           COUNT(*) n, SUM(v.peso_stimato IS NULL) senza_peso, MAX(v.data) ultimo,
           (SELECT COUNT(*) FROM pesate pe WHERE pe.prodotto_id = p.id) n_pesate,
           (SELECT AVG(grammi) FROM pesate pe WHERE pe.prodotto_id = p.id) media
    FROM v_righe v LEFT JOIN alias a ON a.descrizione = v.descrizione
    LEFT JOIN prodotti p ON p.id = v.prodotto_id LEFT JOIN gruppi g ON g.id = p.gruppo_id
    GROUP BY v.descrizione, v.prodotto_id`);
  const senzaAcquisti = db.all(`
    SELECT NULL descrizione, 0 per_riga, NULL saltato_il, p.id prodotto_id, p.nome, p.preparazione, p.peso_conf_g,
           p.ean, p.kcal_100g, g.nome gruppo, g.tipo, g.ordine,
           (SELECT prezzo_kg FROM prezzi_kg pk WHERE pk.prodotto_id = p.id ORDER BY dal DESC LIMIT 1) prezzo_kg,
           (SELECT COUNT(*) FROM prezzi_kg pk WHERE pk.prodotto_id = p.id) n_prezzi,
           0 n, 0 senza_peso, NULL ultimo, 0 n_pesate, NULL media
    FROM prodotti p JOIN gruppi g ON g.id = p.gruppo_id
    WHERE NOT EXISTS (SELECT 1 FROM v_righe v WHERE v.prodotto_id = p.id)`);
  const voci = [...righe, ...senzaAcquisti].map(v => {
    const cibo = ['piano', 'extra', 'fuori_piano'].includes(v.tipo) && v.gruppo !== 'Bevande';
    const manca = [];
    if (!v.nome) manca.push('classificazione');
    else if (cibo) {
      if (v.senza_peso) manca.push(`peso (${v.senza_peso} acq.)`);
      else if (!v.n && !v.peso_conf_g && !v.prezzo_kg) manca.push('peso');
      if (v.kcal_100g === null) manca.push('kcal');
      if (!v.preparazione) manca.push('preparazione');
    }
    return { ...v, manca };
  });
  // i prodotti senza acquisti (creati da EAN/etichetta o rimasti da classificazioni cambiate) in fondo
  voci.forEach(v => { v.orfano = !v.descrizione; });
  voci.sort((a, b) => (a.orfano - b.orfano) || (b.manca.length - a.manca.length) || (b.n - a.n)
    || ((a.ordine ?? 99) - (b.ordine ?? 99)) || (a.nome || '').localeCompare(b.nome || ''));
  return voci;
}
