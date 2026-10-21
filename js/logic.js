// Cose da fare, statistiche e lista "cosa comprare" (porting dell'app Python).
import { DURATA_PREP, FAMIGLIE } from './db.js';
import { piuGiorni, diffGiorni } from './date.js';

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

// ---------------------------------------------------------------- cosa comprare
/** Simula giorno per giorno: arrivano gli acquisti, scadono i vecchi, si consuma al ritmo del piano
 *  partendo da quello che scade prima. Ritorna [grammi in casa, acquisti senza peso ancora validi]. */
export function scorta(acquisti, durataGruppo, consumoG, oggi) {
  if (!acquisti.length) return [0, 0];
  let magazzino = [], senzaPeso = 0, i = 0;
  const fine = diffGiorni(oggi, acquisti[0].data);
  for (let t = 0; t <= fine; t++) {
    while (i < acquisti.length && diffGiorni(acquisti[i].data, acquisti[0].data) === t) {
      const a = acquisti[i];
      const durata = DURATA_PREP[a.preparazione] || durataGruppo || 7;
      const scade = t + durata;
      if (a.peso_stimato === null || a.peso_stimato === undefined) { if (scade >= fine) senzaPeso++; }
      else magazzino.push([scade, a.peso_stimato]);
      i++;
    }
    magazzino = magazzino.filter(m => m[0] >= t).sort((a, b) => a[0] - b[0]);
    let daMangiare = consumoG;
    for (const m of magazzino) {
      const preso = Math.min(m[1], daMangiare);
      m[1] -= preso; daMangiare -= preso;
      if (daMangiare <= 0) break;
    }
    magazzino = magazzino.filter(m => m[1] > 0.5);
  }
  return [magazzino.reduce((s, m) => s + m[1], 0), senzaPeso];
}

/** Stati "finito"/"presente" ancora validi: decadono quando arriva (importato dopo) un acquisto del gruppo. */
export function statiAttivi(db) {
  return Object.fromEntries(db.all(`
    SELECT st.gruppo_id, st.stato FROM stato_gruppi st
    WHERE NOT EXISTS (SELECT 1 FROM v_righe v JOIN scontrini s ON s.id = v.scontrino_id
                      WHERE v.gruppo_id = st.gruppo_id AND s.importato_il > st.il
                        AND s.data >= date(st.il))`).map(r => [r.gruppo_id, r.stato]));
}

/** giorni = fino alla prossima spesa; pastiFuori = pranzi/cene fuori in quei giorni. */
export function cosaComprare(db, oggi, giorni = 4, pastiFuori = 0) {
  const quotaCasa = giorni ? Math.max(0, 1 - pastiFuori / (2 * giorni)) : 1;
  const stati = statiAttivi(db);
  const righe = new Map();
  for (const g of db.all("SELECT * FROM gruppi WHERE tipo='piano' OR famiglia IS NOT NULL ORDER BY ordine")) {
    const alGiorno = (g.g_settimana || 0) / 7;
    const fabbisogno = alGiorno * giorni * (g.pasto === 'principale' ? quotaCasa : 1);
    const acquisti = db.all(`SELECT data, peso_stimato, preparazione FROM v_righe
                             WHERE gruppo_id=? AND data >= ? AND data <= ? ORDER BY data`,
      [g.id, piuGiorni(oggi, -365), oggi]);
    let [sc, senzaPeso] = scorta(acquisti, g.durata_gg, alGiorno, oggi);
    const stato = stati[g.id] || null;
    const note = [];
    if (stato === 'finito') { sc = 0; note.push('segnato finito'); }
    else if (stato === 'presente') note.push("segnato: ce n'è");
    else {
      if (!acquisti.length) note.push('mai comprato da quando registri');
      if (senzaPeso) note.push(`${senzaPeso} acquisti recenti senza peso: la scorta può essere più alta`);
      if ((g.durata_gg || 0) >= 60) note.push("da dispensa: segna finito o ce n'è");
    }
    const manca = stato === 'presente' ? 0 : Math.max(0, fabbisogno - sc);
    const porzioni = g.porzione_g ? manca / g.porzione_g : 0;
    righe.set(g.id, {
      id: g.id, gruppo: g.nome, fabbisogno, scorta: sc, manca, stato, famiglia: g.famiglia, fattore: g.fattore,
      porzioniEsatte: porzioni, porzioni: porzioni ? Math.ceil(porzioni * 2) / 2 : 0,
      porzione_nome: g.porzione_nome, porzione_g: g.porzione_g, note, piano: !!g.g_settimana,
    });
  }

  const compra = [], ok = [], fatte = new Set();
  for (const r of righe.values()) {
    if (r.famiglia) {
      if (fatte.has(r.famiglia)) continue;
      fatte.add(r.famiglia);
      const f = FAMIGLIE[r.famiglia];
      const membri = Object.keys(f.membri).filter(m => righe.has(m)).map(m => righe.get(m));
      // in grammi equivalenti del riferimento: un "ce n'è" copre il fabbisogno del suo gruppo,
      // le eccedenze di un gruppo compensano le mancanze dell'altro
      const need = membri.reduce((s, m) => s + m.fabbisogno * m.fattore, 0);
      const cover = membri.reduce((s, m) => s + (m.stato === 'presente' ? m.fabbisogno : m.scorta) * m.fattore, 0);
      const mancaRef = Math.max(0, need - cover);
      const fam = {
        famiglia: true, id: `fam:${r.famiglia}`, gruppo: f.nome, membri,
        opzioni: membri.map(m => ({ gruppo: m.gruppo, g: mancaRef / m.fattore, piano: m.fabbisogno > 0 })),
        fabbisogno: need, scorta: cover, manca: mancaRef,
        note: membri.filter(m => m.note.length).map(m => `${m.gruppo}: ${m.note.join(', ')}`),
      };
      (mancaRef >= 30 ? compra : ok).push(fam);
      continue;
    }
    // soglia sulle porzioni esatte: evita mezze porzioni per pochi grammi
    (r.porzioniEsatte >= 0.25 ? compra : ok).push(r);
  }

  const non_comprare = db.all(`
    SELECT prodotto, COUNT(*) n, MAX(data) ultimo FROM v_righe
    WHERE tipo='fuori_piano' AND data >= ?
    GROUP BY prodotto HAVING n >= 2 ORDER BY n DESC`, [piuGiorni(oggi, -14)]);
  return { giorni, pastiFuori, compra, ok, non_comprare };
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
