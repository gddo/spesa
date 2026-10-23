// Spesa & piano — PWA. Tutti i dati restano sul telefono (SQLite in IndexedDB).
import { esc, euro, g as fg, n1, intero, num, attr, opzioni } from './fmt.js';
import { Db, init, PREPARAZIONI, RUOLI, TRACCIATI, unita, salvaProdotto, aggiungiPrezzo, aggiornaProdotto, prodottoInUso, PREZZO_INIZIALE } from './db.js';
import * as L from './logic.js';
import * as IO from './io.js';
import * as store from './store.js';
import * as OFF from './off.js';
import { parsePdf } from './parser.js';
import * as scanner from './scanner.js';
import { oggi, adesso, dataBreve, diffGiorni } from './date.js';

const VERSIONE = '1.2.0';
const S = { SQL: null, db: null, esitiImport: null, ultimaRotta: '' };
const app = document.getElementById('app');
const enc = encodeURIComponent;

// ---------------------------------------------------------------- infrastruttura
async function scrivi(fn) {
  const r = S.db.tx(fn);
  await store.salva(S.db.export());
  return r;
}
const salvaDb = () => store.salva(S.db.export());

const caricati = {};
function caricaScript(src) {
  caricati[src] ||= new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok;
    s.onerror = () => { delete caricati[src]; ko(new Error(`impossibile caricare ${src}`)); };
    document.head.appendChild(s);
  });
  return caricati[src];
}
async function pdfjs() {
  await caricaScript('vendor/pdf.min.js');
  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return globalThis.pdfjsLib;
}

let timerToast;
function toast(msg, tipo = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast on ${tipo}`;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function rotta() {
  const h = location.hash.replace(/^#\/?/, '');
  const [vista, q] = h.split('?');
  return { vista: vista || '', p: new URLSearchParams(q || '') };
}
function vai(hash) { if (location.hash === hash) render(); else location.hash = hash; }

const TAB = { lista: 'lista', scansiona: 'scansiona', ean: 'scansiona', dafare: 'dafare', classifica: 'dafare',
  pesi: 'dafare', manuale: 'dafare', statistiche: 'statistiche', altro: 'altro', prodotti: 'altro',
  prodotto: 'altro', scontrini: 'altro', scontrino: 'altro', piano: 'altro', dati: 'altro' };

let token = 0;
async function render() {
  scanner.ferma();
  let { vista, p } = rotta();
  if (!VISTE[vista]) vista = S.db.val('SELECT COUNT(*) FROM scontrini') ? 'lista' : 'dafare';
  const chiave = location.hash;
  const stessa = chiave === S.ultimaRotta;
  const y = window.scrollY;
  S.ultimaRotta = chiave;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === TAB[vista]));
  const mio = ++token;
  try {
    const html = await VISTE[vista](p);
    if (mio !== token) return;
    app.innerHTML = html;
    DOPO[vista]?.(p);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card warn">Errore: ${esc(e.message)}</div>`;
  }
  window.scrollTo(0, stessa ? y : 0);
}

const gruppiOpzioni = () => S.db.all('SELECT id, nome FROM gruppi ORDER BY ordine').map(x => [x.id, x.nome]);
const prepOpzioni = () => PREPARAZIONI.map(x => [x, x]);

// ---------------------------------------------------------------- componenti
const porzTesto = (n, nome) => `${n1(n)} ${n === 1 ? (nome === 'frutti' ? 'frutto' : nome === 'porzioni' ? 'porzione' : nome) : nome}`;

/** Contatore della dispensa: − / numero modificabile / + (una porzione alla volta). */
function contatore(d) {
  return `<div class="conta" data-gid="${esc(d.id)}">
    <button type="button" data-act="conta" data-delta="-1" aria-label="una porzione in meno">−</button>
    <input value="${n1(d.mostra)}" inputmode="numeric" data-change="conta-set" aria-label="porzioni in casa">
    <button type="button" data-act="conta" data-delta="1" aria-label="una porzione in più">+</button>
  </div>`;
}

const giorniFa = iso => {
  if (!iso) return 'mai';
  const n = diffGiorni(oggi(), iso);
  return n <= 0 ? 'oggi' : n === 1 ? 'ieri' : `${n} giorni fa`;
};

function motivoBreve(s) {
  const r = Math.round(s.ritardo);
  return `${r > 0 ? `indietro di ${r}` : r < 0 ? `avanti di ${-r}` : 'in pari'} · mangiato: ${giorniFa(s.ultimoConsumo)}`;
}

function motivo(s) {
  const r = Math.round(s.ritardo);
  const stato = r > 0 ? `in ritardo di ${porzTesto(r, 'porzioni')}` : r < 0 ? `in anticipo di ${porzTesto(-r, 'porzioni')}` : 'in pari';
  return `${stato} sul piano (ultime 4 settimane) · ultimo consumo ${giorniFa(s.ultimoConsumo)}`;
}

function campiPrezzo(prezzi, conElimina = true) {
  return `<fieldset class="box">
    <legend>Peso variabile: €/kg</legend>
    <div class="row2">
      <label>Peso netto<input id="calc_peso" inputmode="decimal" placeholder="0,236 kg o 236 g" data-input="calc"></label>
      <label>Importo €<input id="calc_euro" inputmode="decimal" placeholder="es. 0,59" data-input="calc"></label>
      <label>€/kg<input name="prezzo_kg" id="prezzo_kg" inputmode="decimal" placeholder="dall'etichetta"></label>
      <label>Valido dal<input type="date" name="prezzo_dal" value="${oggi()}"></label>
    </div>
    <div class="mut" id="calc_out">Copia "PREZZO/kg" dall'etichetta, oppure scrivi peso netto e importo. Data: quella di "confezionato il".</div>
    ${prezzi.length ? `<div class="storico">${prezzi.map(x => `<div class="riga">
        <span>${x.dal === PREZZO_INIZIALE ? 'primo prezzo noto' : dataBreve(x.dal)}</span><b>${n1(x.prezzo_kg)} €/kg</b>
        ${conElimina ? `<button type="button" class="mini sec" data-act="prezzo-elimina" data-pid="${x.prodotto_id}" data-dal="${esc(x.dal)}">elimina</button>` : ''}
      </div>`).join('')}</div>
      <div class="mut">Ogni acquisto usa il prezzo in vigore alla sua data; un prezzo nuovo non cambia i pesi passati.</div>` : ''}
  </fieldset>`;
}

function campiProdotto(x, { nomeId = 'nome' } = {}) {
  const v = k => (x && x[k] !== null && x[k] !== undefined ? x[k] : '');
  return `
    <label>Nome del prodotto<input name="nome" id="${nomeId}" list="lista-prodotti" value="${esc(v('nome'))}" autocomplete="off" data-input="nome-prodotto" placeholder="scrivi o scegli un prodotto esistente"></label>
    <datalist id="lista-prodotti">${S.db.all('SELECT nome FROM prodotti ORDER BY nome').map(r => `<option value="${esc(r.nome)}">`).join('')}</datalist>
    <div class="row2">
      <label>Gruppo<select name="gruppo_id">${opzioni(gruppiOpzioni(), v('gruppo_id'))}</select></label>
      <label>Preparazione<select name="preparazione">${opzioni(prepOpzioni(), v('preparazione'))}</select></label>
      <label>Peso confezione g<input name="peso_conf_g" inputmode="decimal" value="${esc(v('peso_conf_g') === '' ? '' : n1(v('peso_conf_g')))}" placeholder="solo se fisso"></label>
      <label>kcal per 100 g<input name="kcal_100g" inputmode="decimal" value="${esc(v('kcal_100g') === '' ? '' : n1(v('kcal_100g')))}" placeholder="dall'etichetta"></label>
    </div>`;
}

const leggi = form => Object.fromEntries(new FormData(form).entries());

// ---------------------------------------------------------------- viste
const VISTE = {};
const DOPO = {};

VISTE.lista = () => {
  const db = S.db;
  const pasti = Math.max(0, parseInt(db.kvGet('lista_pasti', '4'), 10) || 0);
  const l = L.lista(db, oggi(), pasti);
  let sp = JSON.parse(db.kvGet('spunte', '{}'));
  if (sp.data !== oggi()) sp = { data: oggi(), ids: [] };
  const fatto = id => sp.ids.includes(id);
  const maiContati = db.kvGet('dispensa_ok') ? [] : l.dispensa.filter(d => !d.ultimaConta).map(d => d.gruppo);

  const voceCompra = (id, titolo, quanto, nota) => `<div class="item${fatto(id) ? ' fatto' : ''}">
      <button type="button" class="tick" data-act="spunta" data-id="${esc(id)}" aria-label="preso">${fatto(id) ? '✓' : ''}</button>
      <div class="corpo"><div class="titolo">${esc(titolo)}</div><div class="qta">${quanto}</div>${nota ? `<div class="mut">${nota}</div>` : ''}</div></div>`;
  const compra = [
    ...l.compraSecondi.map(x => voceCompra(`sec:${x.id}`, x.gruppo,
      `<b>${porzTesto(x.daComprare, x.porzione_nome)}</b> <span class="mut">(${fg(x.daComprare * x.unita_g)})</span>`, esc(motivo(x)))),
    ...l.compraPasto.map(x => voceCompra(x.id, x.gruppo, x.opzioni
      ? x.opzioni.filter(o => o.porzioni).map(o => `<b>${porzTesto(o.porzioni, 'porzioni')}</b> ${esc(o.gruppo.toLowerCase())} <span class="mut">(${fg(o.g)})</span>`).join('<span class="mut"> oppure </span>')
      : `<b>${porzTesto(x.porzioni, x.porzione_nome)}</b> <span class="mut">(${fg(x.g)})</span>`,
      `per ${l.pasti} pasti servono ${fg(x.serve)}, in casa ${fg(x.stock_g)}`)),
  ];
  const presi = [...l.compraSecondi.map(x => `sec:${x.id}`), ...l.compraPasto.map(x => x.id)].filter(fatto).length;
  const nCompra = l.compraSecondi.length + l.compraPasto.length;

  // prossimi pasti: sequenza raggruppata per gruppo, nell'ordine della prima volta
  const perGruppo = new Map();
  l.sequenza.forEach((x, i) => {
    if (!perGruppo.has(x.id)) perGruppo.set(x.id, { ...x, pasti: [] });
    perGruppo.get(x.id).pasti.push({ n: i + 1, inCasa: x.inCasa });
  });
  const secondo = Object.fromEntries(l.secondi.map(x => [x.id, x]));
  const dispRiga = d => `<div class="disp">
      <div class="corpo"><div class="titolo">${esc(d.gruppo)}</div>
        <div class="mut">da ${fg(d.unita_g)}${d.unita_g !== d.porzione_g ? ` (piano ${fg(d.porzione_g)})` : ''}${secondo[d.id] ? ` · ${esc(motivoBreve(secondo[d.id]))}` : ''}</div></div>
      ${contatore(d)}</div>`;

  return `<h1>Cosa mangio e cosa compro</h1>
    <div class="card">
      <div class="riga-input"><span>Pasti principali da coprire<br><span class="mut">pranzi o cene a casa fino alla prossima spesa</span></span>
        <div class="conta"><button type="button" data-act="pasti" data-delta="-1">−</button><input value="${pasti}" inputmode="numeric" data-change="pasti-set"><button type="button" data-act="pasti" data-delta="1">+</button></div></div>
    </div>
    ${maiContati.length ? `<div class="card warn"><b>Prima volta: conta la dispensa</b>
      <div class="mut">Le porzioni in casa sono stimate dagli scontrini. Correggile una volta nella sezione Dispensa in fondo: poi bastano gli scontrini e qualche correzione. Mai contati: ${esc(maiContati.join(', '))}.</div>
      <a class="btn sec" href="#dispensa">Vai alla dispensa</a>
      <button type="button" class="btn sec" data-act="dispensa-ok">Fatto, non mostrarlo più</button></div>` : ''}
    ${l.scelte.length ? `<div class="card ok"><div class="mut">Prossimo pasto: scegli tra</div>
      ${l.scelte.map(s => `<div class="disp"><div class="corpo"><div class="big">${esc(s.gruppo)}</div>
        <div class="${s.disponibili >= 1 ? 'ok' : 'warn'}">${s.disponibili >= 1 ? 'in casa' : 'da comprare'}</div>
        <div class="mut">${esc(motivo(s))}</div></div>
        ${contatore(l.dispensa.find(d => d.id === s.id))}</div>`).join('')}
      <div class="mut">Dopo averlo mangiato, togli le porzioni con −.</div></div>` : ''}
    <h2>Secondi per i prossimi ${l.pasti} pasti</h2>
    <div class="card">${l.sequenza.length ? [...perGruppo.values()].map(x => `<div class="riga"><span><b>${esc(x.gruppo)}</b> <span class="mut">× ${x.pasti.length}</span></span>
      <span class="${x.pasti.every(q => q.inCasa) ? 'ok' : 'warn'}">${x.pasti.every(q => q.inCasa) ? 'in casa' : x.pasti.some(q => q.inCasa) ? 'in parte da comprare' : 'da comprare'}</span></div>`).join('')
      : 'Nessun pasto da coprire.'}
      <div class="mut">Ripartizione del piano senza uova (sono a colazione): a ogni pasto il gruppo più indietro, a parità prima quello che hai in casa; fino a 5 pasti ogni gruppo compare una volta sola.</div></div>
    <h2>Da comprare <span class="mut">${presi}/${nCompra} presi</span></h2>
    <div class="lista">${compra.length ? compra.join('') : '<div class="card">Niente: quello che hai in casa copre i pasti.</div>'}</div>
    ${presi ? '<button type="button" class="btn sec" data-act="spunte-azzera">Azzera le spunte</button>' : ''}
    ${l.non_comprare.length ? `<h2>Non comprare</h2><div class="card">${l.non_comprare.map(r =>
      `<div class="riga"><span>${esc(r.prodotto)}</span><span class="mut">${r.n} volte in 14 giorni</span></div>`).join('')}</div>` : ''}
    <h2 id="dispensa">Dispensa <span class="mut">porzioni in casa</span></h2>
    <div class="card"><b>Secondi</b>${l.dispensa.filter(d => d.ruolo === 'secondo').map(dispRiga).join('')}</div>
    <div class="card"><b>Per ogni pasto</b>${l.dispensa.filter(d => d.ruolo !== 'secondo').map(dispRiga).join('')}</div>
    <p class="mut">Gli scontrini aggiungono le porzioni da soli. I freschi calano al ritmo del piano e a scadenza si considerano mangiati; pasta, legumi, tonno e surgelati restano finché non li correggi. Colazioni, olio e condimenti non sono in lista.</p>`;
};

VISTE.scansiona = () => {
  const prodotti = S.db.all(`SELECT p.id, p.nome, g.nome gruppo,
      (SELECT MAX(v.data) FROM v_righe v WHERE v.prodotto_id = p.id) ultimo
    FROM prodotti p JOIN gruppi g ON g.id = p.gruppo_id WHERE g.tipo <> 'non_alimentare'
    ORDER BY ultimo IS NULL, ultimo DESC, p.nome`);
  return `<h1>Scansiona</h1>
    <div class="card">
      <button type="button" class="btn big" data-act="scan-live">Inquadra il codice a barre</button>
      <div id="scanner" hidden>
        <video playsinline muted autoplay></video>
        <div class="mirino"></div>
        <button type="button" class="btn sec" data-act="scan-stop">Chiudi fotocamera</button>
      </div>
      <label class="btn sec">Da una foto<input type="file" accept="image/*" data-change="scan-foto" class="file-nascosto"></label>
      <form data-submit="ean-cerca" class="inline">
        <input name="ean" inputmode="numeric" placeholder="oppure scrivi le cifre" autocomplete="off">
        <button type="button" class="btn" data-act="ean-cerca">Cerca</button>
      </form>
    </div>
    <h2>Prodotto al banco o senza codice</h2>
    <div class="card">
      <input type="search" placeholder="Cerca tra i tuoi prodotti" data-input="cerca-prodotto" autocomplete="off">
      <div class="lista-link" id="risultati">${prodotti.map(x => `<a href="#/prodotto?id=${x.id}&da=scansiona" data-nome="${esc(x.nome.toLowerCase())}">
        <span>${esc(x.nome)}</span><span class="mut">${esc(x.gruppo)}</span></a>`).join('')}</div>
      <a class="btn sec" href="#/prodotto?nuovo=1&da=scansiona" id="nuovo-prodotto">Nuovo prodotto</a>
      <div class="mut">Dalla scheda del prodotto inserisci €/kg e kcal leggendo l'etichetta.</div>
    </div>`;
};

VISTE.ean = async p => {
  const codice = OFF.pulisci(p.get('code'));
  const db = S.db;
  const testa = `<h1>Codice ${esc(codice)}</h1><a class="btn sec" href="#/scansiona">Altro codice</a>`;
  if (!OFF.valido(codice)) return `${testa}<div class="card warn">Codice non valido: cifra di controllo sbagliata o lunghezza errata. Ricontrolla le cifre.</div>`;
  if (OFF.pesoVariabile(codice)) return `${testa}<div class="card warn">È un codice interno del negozio (prodotto pesato al banco): non identifica il prodotto. Cerca il prodotto per nome in Scansiona e inserisci il €/kg dell'etichetta.</div>`;
  const esistente = db.one(`SELECT p.*, g.nome gruppo FROM prodotti p JOIN gruppi g ON g.id=p.gruppo_id WHERE p.ean=?`, [codice]);
  const off = esistente ? {} : await OFF.cerca(codice);
  const val = esistente ? esistente : {
    nome: [off.nome, off.marca].filter(Boolean).join(' '), peso_conf_g: off.peso_g, kcal_100g: off.kcal_100g,
  };
  const descr = db.all(`SELECT r.descrizione, MAX(s.data) ultima, p.nome prodotto FROM righe r
      JOIN scontrini s ON s.id = r.scontrino_id LEFT JOIN alias a ON a.descrizione = r.descrizione
      LEFT JOIN prodotti p ON p.id = a.prodotto_id GROUP BY r.descrizione ORDER BY ultima DESC, r.descrizione`);
  const daCl = descr.filter(d => !d.prodotto), cl = descr.filter(d => d.prodotto);
  let info;
  if (esistente) {
    const pk = db.val('SELECT prezzo_kg FROM prezzi_kg WHERE prodotto_id=? ORDER BY dal DESC LIMIT 1', [esistente.id]);
    info = `<div class="card ok"><div class="mut">Già nei tuoi prodotti</div><div class="big">${esc(esistente.nome)}</div>
      <div class="mut">${esc(esistente.gruppo)}${esistente.kcal_100g !== null ? ` · ${n1(esistente.kcal_100g)} kcal/100 g` : ''}${esistente.peso_conf_g ? ` · ${fg(esistente.peso_conf_g)}` : ''}${pk ? ` · ${n1(pk)} €/kg` : ''}</div>
      <a class="btn sec" href="#/prodotto?id=${esistente.id}&da=scansiona">Apri la scheda</a></div>`;
  } else if (off.trovato) {
    info = `<div class="card"><div class="mut">Open Food Facts</div><div class="big">${esc(off.nome || '(senza nome)')}</div>
      <div class="mut">${esc([off.marca, off.quantita, off.kcal_100g !== null ? `${off.kcal_100g} kcal/100 g` : null].filter(Boolean).join(' · '))}</div></div>`;
  } else {
    info = `<div class="card warn">${esc(off.errore || 'Non presente su Open Food Facts: inserisci i dati a mano.')}</div>`;
  }
  return `${testa}${info}
    <form class="card" data-submit="ean-salva">
      <input type="hidden" name="ean" value="${esc(codice)}">
      <label>Voce dello scontrino corrispondente
        <select name="descrizione" data-change="ean-voce">
          <option value="">— nessuna (non è ancora su uno scontrino)</option>
          ${daCl.length ? `<optgroup label="Da classificare">${daCl.map(d => `<option value="${esc(d.descrizione)}">${esc(d.descrizione)} · ${dataBreve(d.ultima)}</option>`).join('')}</optgroup>` : ''}
          ${cl.length ? `<optgroup label="Già classificate">${cl.map(d => `<option value="${esc(d.descrizione)}" data-prodotto="${esc(d.prodotto)}"${attr(esistente && d.prodotto === esistente.nome, 'selected')}>${esc(d.descrizione)} → ${esc(d.prodotto)}</option>`).join('')}</optgroup>` : ''}
        </select></label>
      ${campiProdotto(val)}
      <div class="mut">Per le conserve il peso netto comprende il liquido.</div>
      <button type="button" class="btn" data-act="ean-salva">Salva</button>
    </form>`;
};

VISTE.dafare = () => {
  const db = S.db, t = L.daFare(db, oggi());
  const ultimo = db.kvGet('ultimo_backup');
  const giorniBackup = ultimo ? diffGiorni(oggi(), ultimo) : null;
  const esiti = S.esitiImport;
  S.esitiImport = null;
  return `<h1>Da fare</h1>
    ${t.scontrini ? `<div class="card"><div class="mut">${t.scontrini} scontrini, dal ${dataBreve(t.dal)} al ${dataBreve(t.al)}</div>
      ${t.non_quadrano ? `<div class="warn">${t.non_quadrano} scontrini con somma righe diversa dal totale: controllali in Altro → Scontrini.</div>` : ''}</div>`
    : `<div class="card"><b>Nessun dato sul telefono.</b><div class="mut">Se hai i dati sull'app del Mac: lì premi Export, poi qui Altro → Dati → Importa dall'app del Mac.</div></div>`}
    <div class="card">
      <label class="btn big">Importa scontrini PDF<input type="file" accept="application/pdf,.pdf" multiple data-change="importa-pdf" class="file-nascosto"></label>
      <div class="mut">Dall'app Esselunga: scontrino → Condividi → Salva su File; poi qui scegli i PDF (anche più insieme). I doppioni vengono saltati.</div>
      <a class="btn sec" href="#/manuale">Acquisto senza PDF</a>
    </div>
    ${esiti ? `<div class="card"><b>Import</b>${esiti.map(e => `<div class="riga"><span>${esc(e.file)}</span><span class="${e.stato === 'errore' ? 'warn' : e.stato === 'importato' ? 'ok' : 'mut'}">${esc(e.stato)}</span></div><div class="mut">${esc(e.msg)}</div>`).join('')}</div>` : ''}
    <a class="card passo" href="#/classifica"><b>1. Classifica le voci</b><span class="badge${t.da_classificare ? '' : ' zero'}">${t.da_classificare}</span>
      <div class="mut">Cos'è ogni voce dello scontrino. Vale anche per gli scontrini passati e futuri con la stessa voce.${t.saltati ? ` ${t.saltati} saltate.` : ''}</div></a>
    <a class="card passo" href="#/pesi"><b>2. Inserisci i pesi</b><span class="badge${t.da_pesare ? '' : ' zero'}">${t.da_pesare}</span>
      <div class="mut">Grammi dall'etichetta per i prodotti senza peso fisso né €/kg.</div></a>
    <a class="card passo" href="#/prodotti"><b>3. Completa i prodotti</b><span class="badge${t.senza_kcal ? '' : ' zero'}">${t.senza_kcal}</span>
      <div class="mut">Prodotti senza kcal: in cima alla lista Prodotti.</div></a>
    ${t.scontrini ? `<div class="card${giorniBackup === null || giorniBackup > 14 ? ' warn' : ''}">
      <b>Backup</b> <span class="mut">${ultimo ? `ultimo ${dataBreve(ultimo)} (${giorniBackup} giorni fa)` : 'mai fatto'}</span>
      <div class="mut">I dati esistono solo su questo telefono.</div>
      <button type="button" class="btn sec" data-act="backup">Fai il backup</button></div>` : ''}`;
};

VISTE.manuale = () => `<h1>Acquisto senza PDF</h1>
  <form class="card" data-submit="manuale">
    <div class="mut">Per spese fatte altrove (panetteria, altro supermercato). Un articolo per volta.</div>
    <div class="row2">
      <label>Data<input type="date" name="data" value="${oggi()}"></label>
      <label>Negozio<input name="negozio" autocomplete="off"></label>
    </div>
    <label>Cosa<input name="descrizione" placeholder="es. pane in cassetta" autocomplete="off"></label>
    <div class="row2">
      <label>Prezzo €<input name="prezzo" inputmode="decimal"></label>
      <label>Peso g (se lo sai)<input name="peso_g" inputmode="decimal"></label>
    </div>
    <button type="button" class="btn" data-act="manuale">Salva e classifica</button>
  </form>`;

VISTE.classifica = p => {
  const db = S.db;
  const d = p.get('d'), saltati = p.get('saltati') === '1', da = p.get('da') || '';
  const v = d ? L.voce(db, d) : L.prossimoAlias(db, saltati);
  const t = L.daFare(db, oggi());
  if (!v) {
    return `<h1>Classifica${saltati ? ' — saltate' : ''}</h1><div class="card">${saltati ? 'Nessuna voce saltata.' : 'Tutto classificato.'}
      ${t.saltati && !saltati ? `<a class="btn sec" href="#/classifica?saltati=1">Riprendi le ${t.saltati} saltate</a>` : ''}
      ${t.da_pesare ? `<a class="btn" href="#/pesi">Continua: pesi (${t.da_pesare})</a>` : ''}</div>`;
  }
  let attuale = db.one('SELECT p.* FROM alias a JOIN prodotti p ON p.id = a.prodotto_id WHERE a.descrizione=?', [v.descrizione]);
  if (!attuale) attuale = db.one(`SELECT p.* FROM righe r JOIN prodotti p ON p.id = r.prodotto_id
      JOIN scontrini s ON s.id = r.scontrino_id WHERE r.descrizione=? ORDER BY s.data DESC LIMIT 1`, [v.descrizione]);
  const prezzi = attuale ? db.all('SELECT * FROM prezzi_kg WHERE prodotto_id=? ORDER BY dal DESC', [attuale.id]) : [];
  const acquisti = db.all(`SELECT id, data, prezzo, sconto, netto, peso_g, peso_stimato, fonte_peso, prezzo_kg, prodotto, per_riga
      FROM v_righe WHERE descrizione=? ORDER BY data, scontrino_id, n`, [v.descrizione]);
  const generica = acquisti.some(a => a.per_riga);
  const libere = acquisti.filter(a => !a.per_riga);
  const sel = generica ? (libere[0] || acquisti[acquisti.length - 1]).id : null;
  return `<h1>Classifica${saltati ? ' — saltate' : ''}</h1>
    <form class="card" data-submit="classifica-salva" id="f-classifica">
      <input type="hidden" name="descrizione" value="${esc(v.descrizione)}">
      <div class="big">${esc(v.descrizione)}</div>
      <div class="mut">${v.n} volte, dal ${dataBreve(v.prima)} al ${dataBreve(v.ultima)} · prezzi: ${esc(v.prezzi)}</div>
      ${campiProdotto(attuale)}
      <div class="mut" id="nota-nome"></div>
      ${campiPrezzo(prezzi)}
      <label>Applica a<select name="applica">
        <option value="tutti">Tutti gli acquisti con questa voce, anche futuri</option>
        ${acquisti.map(a => `<option value="${a.id}"${attr(a.id === sel, 'selected')}>Solo l'acquisto del ${dataBreve(a.data)} · ${euro(a.prezzo)}${a.per_riga ? ` (ora: ${esc(a.prodotto)})` : ''}</option>`).join('')}
      </select></label>
      <div class="mut">"Solo l'acquisto" per le voci generiche (FRUTTA E VERDURA…): ogni acquisto può essere un prodotto diverso.</div>
      <div class="azioni">
        <button type="button" class="btn" data-act="classifica-salva">Salva</button>
        <button type="button" class="btn sec" data-act="classifica-salta">Non lo so, salta</button>
        <a class="btn sec" href="#/scansiona">Ho il codice a barre</a>
      </div>
    </form>
    <form class="card" id="f-pesi-righe" data-submit="righe-pesi">
      <input type="hidden" name="descrizione" value="${esc(v.descrizione)}">
      <b>Pesi dei singoli acquisti</b>
      <div class="mut">Vuoto = stima automatica (€/kg, poi media delle pesate, poi peso confezione). Un valore scritto qui vale solo per quell'acquisto.</div>
      ${acquisti.map(a => `<div class="acquisto">
        <div><b>${dataBreve(a.data)}</b> · ${euro(a.prezzo)}${a.sconto ? ` <span class="mut">(pagato ${euro(a.netto)})</span>` : ''}
          <div class="mut">${esc(a.prodotto || '–')}${a.per_riga ? ' · solo questo acquisto' : ''} · stima ${fg(a.peso_stimato)}${a.fonte_peso ? ` (${esc(a.fonte_peso)}${a.fonte_peso === 'da €/kg' ? ` ${n1(a.prezzo_kg)}` : ''})` : ''}</div>
          ${a.per_riga ? `<button type="button" class="mini sec" data-act="riga-scollega" data-rid="${a.id}">togli il prodotto da questo acquisto</button>` : ''}</div>
        <input name="peso_${a.id}" inputmode="decimal" value="${a.peso_g ? Math.round(a.peso_g) : ''}" placeholder="g">
      </div>`).join('')}
      <button type="button" class="btn sec" data-act="righe-pesi">Salva pesi</button>
    </form>`;
};

VISTE.pesi = () => {
  const r = L.prossimaPesata(S.db, oggi());
  if (!r) return `<h1>Pesi</h1><div class="card">Nessun acquisto da pesare.
    <button type="button" class="btn sec" data-act="pesi-riprendi">Riprendi i saltati</button></div>`;
  return `<h1>Pesi</h1>
    <form class="card" data-submit="pesi-salva">
      <input type="hidden" name="riga_id" value="${r.id}">
      <div class="big">${esc(r.prodotto)}</div>
      <div class="mut">${esc(r.descrizione)} · ${dataBreve(r.data)} · ${euro(r.netto)}</div>
      <div class="mut">${r.n_pesate ? `Media attuale: ${fg(r.media)} su ${r.n_pesate} pesate.` : 'Nessuna pesata finora: senza peso questo acquisto non entra nei calcoli in grammi.'}</div>
      <label>Grammi<input name="grammi" inputmode="decimal" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="fisso" value="1"> Confezione a peso fisso: vale per tutti gli acquisti di questo prodotto</label>
      <div class="azioni">
        <button type="button" class="btn" data-act="pesi-salva">Salva</button>
        <button type="button" class="btn sec" data-act="pesi-salta">Non lo so, salta</button>
        <button type="button" class="btn sec" data-act="pesi-salta-prodotto">Salta tutti gli acquisti di questo prodotto</button>
        <a class="btn sec" href="#/prodotto?id=${r.prodotto_id}">È a peso variabile: metti il €/kg</a>
      </div>
    </form>`;
};

VISTE.prodotto = p => {
  const db = S.db;
  const id = parseInt(p.get('id'), 10);
  const x = id ? db.one('SELECT * FROM prodotti WHERE id=?', [id]) : { nome: p.get('nome') || '' };
  if (id && !x) return '<div class="card warn">Prodotto non trovato.</div>';
  const prezzi = id ? db.all('SELECT * FROM prezzi_kg WHERE prodotto_id=? ORDER BY dal DESC', [id]) : [];
  const voci = id ? db.all(`SELECT descrizione, COUNT(*) n, MAX(data) ultima, MAX(per_riga) per_riga FROM v_righe
      WHERE prodotto_id=? GROUP BY descrizione ORDER BY ultima DESC`, [id]) : [];
  const usato = id ? prodottoInUso(db, id) : false;
  return `<h1>${id ? esc(x.nome) : 'Nuovo prodotto'}</h1>
    <form class="card" data-submit="prodotto-salva">
      <input type="hidden" name="id" value="${id || ''}">
      ${campiProdotto(x, { nomeId: 'nome-scheda' })}
      <label>Codice EAN<input name="ean" inputmode="numeric" value="${esc(x.ean || '')}" autocomplete="off"></label>
      ${campiPrezzo(prezzi)}
      <div class="azioni">
        <button type="button" class="btn" data-act="prodotto-salva">Salva</button>
        ${id && !usato ? '<button type="button" class="btn sec warn" data-act="prodotto-elimina">Elimina prodotto</button>' : ''}
      </div>
      ${id ? '<div class="mut">Qui un campo vuoto cancella il valore.</div>' : ''}
    </form>
    ${voci.length ? `<div class="card"><b>Sugli scontrini come</b>${voci.map(vv => `<a class="riga" href="#/classifica?d=${enc(vv.descrizione)}&da=prodotti">
      <span>${esc(vv.descrizione)}${vv.per_riga ? ' <span class="mut">(singolo acquisto)</span>' : ''}</span><span class="mut">${vv.n}× · ${dataBreve(vv.ultima)}</span></a>`).join('')}</div>` : ''}`;
};

VISTE.prodotti = () => {
  const voci = L.elencoProdotti(S.db);
  const blocco = (titolo, lista) => lista.length ? `<h2>${titolo} <span class="mut">${lista.length}</span></h2><div class="lista-link">${lista.map(v => {
    const href = v.descrizione ? `#/classifica?d=${enc(v.descrizione)}&da=prodotti` : `#/prodotto?id=${v.prodotto_id}`;
    const peso = v.prezzo_kg ? `${n1(v.prezzo_kg)} €/kg${v.n_prezzi > 1 ? ` (${v.n_prezzi} prezzi)` : ''}`
      : v.peso_conf_g ? `${fg(v.peso_conf_g)} conf.` : v.n_pesate ? `${fg(v.media)} (${v.n_pesate} pesate)` : '';
    return `<a href="${href}" data-nome="${esc(((v.nome || '') + ' ' + (v.descrizione || '')).toLowerCase())}">
      <span><b>${esc(v.nome || (v.saltato_il ? 'saltata' : 'nuova'))}</b>${v.per_riga ? ' <span class="mut">(singolo acquisto)</span>' : ''}
        <br><span class="mut">${esc(v.descrizione || 'nessun acquisto')}${v.n ? ` · ${v.n}×` : ''}</span>
        ${v.manca.length ? `<br><span class="warn">manca: ${esc(v.manca.join(', '))}</span>` : ''}</span>
      <span class="mut destra">${esc(v.gruppo || '')}<br>${esc(peso)}${v.kcal_100g !== null && v.kcal_100g !== undefined ? `<br>${n1(v.kcal_100g)} kcal` : ''}</span></a>`;
  }).join('')}</div>` : '';
  return `<h1>Prodotti</h1>
    <input type="search" placeholder="Cerca" data-input="cerca-prodotti" autocomplete="off">
    ${blocco('Da completare', voci.filter(v => !v.orfano && v.manca.length))}
    ${blocco('Completi', voci.filter(v => !v.orfano && !v.manca.length))}
    ${blocco('Senza acquisti', voci.filter(v => v.orfano))}
    <p class="mut">"Senza acquisti": creati da codice a barre o rimasti da classificazioni cambiate. Dalla scheda puoi eliminarli.</p>
    <a class="btn sec" href="#/prodotto?nuovo=1">Nuovo prodotto</a>`;
};

VISTE.scontrini = () => {
  const lista = S.db.all(`SELECT s.*, COUNT(r.id) n FROM scontrini s LEFT JOIN righe r ON r.scontrino_id = s.id
      GROUP BY s.id ORDER BY s.data DESC, s.ora DESC`);
  return `<h1>Scontrini</h1><div class="lista-link">${lista.map(s => `<a href="#/scontrino?id=${enc(s.id)}">
    <span><b>${dataBreve(s.data)}</b> ${esc(s.ora || '')}<br><span class="mut">${esc(s.negozio || '')} · ${s.n} righe</span>${s.quadra ? '' : '<br><span class="warn">non quadra</span>'}</span>
    <span>${euro(s.totale)}</span></a>`).join('') || '<div class="card">Nessuno.</div>'}</div>`;
};

VISTE.scontrino = p => {
  const id = p.get('id');
  const s = S.db.one('SELECT * FROM scontrini WHERE id=?', [id]);
  if (!s) return '<div class="card warn">Scontrino non trovato.</div>';
  const righe = S.db.all('SELECT * FROM v_righe WHERE scontrino_id=? ORDER BY n', [id]);
  return `<h1>${dataBreve(s.data)} ${esc(s.ora || '')}</h1>
    <div class="card"><div class="riga"><span>${esc(s.negozio || '')}</span><b>${euro(s.totale)}</b></div>
    ${righe.map(r => `<a class="riga" href="#/classifica?d=${enc(r.descrizione)}"><span>${esc(r.descrizione)}<br><span class="mut">${esc(r.prodotto || 'da classificare')} · ${fg(r.peso_stimato)}</span></span><span>${euro(r.netto)}</span></a>`).join('')}</div>
    <button type="button" class="btn sec warn" data-act="scontrino-elimina" data-id="${esc(id)}">Elimina scontrino</button>`;
};

/** Mangiato rispetto al piano: due cerchi concentrici con l'area proporzionale ai grammi.
 *  Pieno = mangiato (stima), contorno = piano. */
function cerchio(v) {
  const R = 46, max = Math.max(v.g, v.piano) || 1, r = x => R * Math.sqrt(x / max);
  const pct = Math.round(v.pct);
  const colore = pct > 120 ? 'var(--sopra)' : pct < 80 ? 'var(--mut)' : 'var(--acc)';
  const pieno = v.g > 0 ? `<circle cx="50" cy="50" r="${r(v.g).toFixed(2)}" fill="${colore}"/>` : '';
  const piano = `<circle cx="50" cy="50" r="${r(v.piano).toFixed(2)}" fill="none" stroke="var(--card)" stroke-width="4"/>
    <circle cx="50" cy="50" r="${r(v.piano).toFixed(2)}" fill="none" stroke="var(--fg)" stroke-width="1.5"/>`;
  return `<figure class="cerchio">
    <svg viewBox="0 0 100 100" role="img" aria-label="${esc(`${v.nome}: mangiato ${fg(v.g)}, piano ${fg(v.piano)}, ${pct}%`)}">${pieno}${piano}</svg>
    <figcaption>${esc(v.nome)}<br><b>${pct}%</b> <span class="mut">${fg(v.g)} / ${fg(v.piano)}${v.nota ? ` ${esc(v.nota)}` : ''}</span></figcaption>
  </figure>`;
}
function cerchiMangiato(m) {
  if (!m || !m.voci.length) return '';
  return `<h2>Mangiato e piano <span class="mut">ultimi ${m.giorni_eff} giorni</span></h2>
    <div class="card">
      <div class="legenda"><span><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="var(--acc)"/></svg>mangiato (stima)</span>
        <span><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--fg)" stroke-width="1.5"/></svg>piano</span></div>
      <div class="cerchi">${m.voci.map(cerchio).join('')}</div>
      <div class="mut">Area proporzionale ai grammi. Verde tra 80% e 120% del piano, arancione sopra, grigio sotto. Il mangiato è stimato da scontrini, scadenze dei freschi e conte della dispensa.</div>
    </div>`;
}

VISTE.statistiche = p => {
  const giorni = parseInt(p.get('giorni') || S.db.kvGet('stat_giorni', '28'), 10) || 28;
  const s = L.statistiche(S.db, oggi(), giorni);
  if (!s) return '<h1>Statistiche</h1><div class="card">Nessun dato.</div>';
  const chip = n => `<a class="chip${n === giorni ? ' on' : ''}" href="#/statistiche?giorni=${n}">${n} gg</a>`;
  const barra = pct => pct === null || pct === undefined ? '' :
    `<div class="bar${pct > 120 ? ' sopra' : ''}"><div style="width:${Math.min(pct, 100)}%"></div></div>`;
  const kcalTot = s.gruppi.reduce((t, x) => t + x.kcal, 0) || 1;
  const c = s.completezza;
  return `<h1>Statistiche</h1>
    <div class="chips">${[7, 14, 28, 56, 91].map(chip).join('')}</div>
    <div class="mut">Dal ${dataBreve(s.da)}; giorni con dati: ${s.giorni_eff}. Classificate ${c.classificate}/${c.righe} righe; cibo con peso ${c.cibo_con_peso}/${c.cibo}; con peso e kcal ${c.cibo_con_kcal}/${c.cibo}.</div>
    ${cerchiMangiato(L.mangiato(S.db, oggi(), giorni))}
    <h2>Piano e acquisti, media a settimana</h2>
    <div class="card">${s.gruppi.filter(x => x.n || x.g_settimana).map(x => `<div class="stat">
      <div class="riga"><span>${esc(x.nome)}</span><span>${x.g_sett !== null ? `${x.parziale ? '≥ ' : ''}${fg(x.g_sett)}` : '–'}${x.g_settimana ? ` / ${fg(x.g_settimana)}` : ''}
        ${x.copertura !== null ? `<b>${Math.round(x.copertura)}%</b>` : x.g_settimana && !x.n ? '<b class="warn">mai</b>' : x.parziale ? '<span class="mut">pesi mancanti</span>' : ''}</span></div>
      ${barra(x.copertura)}
      ${x.n ? `<div class="mut">${x.n} acquisti · ${euro(x.euro)}${x.kcal ? ` · ${Math.round(x.kcal / kcalTot * 100)}% delle kcal` : ''} · ultimo ${dataBreve(x.ultimo)}</div>` : ''}
    </div>`).join('')}</div>
    <h2>Con le equivalenze</h2>
    <div class="card">${s.famiglie.map(f => `<div class="stat">
      <div class="riga"><span>${esc(f.nome)} <span class="mut">in g di ${esc(f.rif.toLowerCase())}</span></span><span>${f.parziale ? '≥ ' : ''}${fg(f.comprato)} / ${fg(f.piano)} ${f.pct !== null ? `<b>${Math.round(f.pct)}%</b>` : ''}</span></div>
      ${barra(f.pct)}
      <div class="mut">${f.membri.map(m => `${esc(m.nome)}: ${fg(m.g_sett)}${m.fattore !== 1 ? ` × ${n1(m.fattore)}` : ''}`).join(' · ')}</div>
    </div>`).join('')}
    <div class="mut">Tabelle di conversione: 120 g pasta/riso = 160 g pane; 100 g formaggio magro = 50 g fresco = 35 g stagionato.</div></div>
    <h2>Fuori piano</h2>
    <div class="card">${s.fuori_piano.length ? s.fuori_piano.map(r => `<div class="riga"><span>${esc(r.prodotto)}</span><span class="mut">${r.n}× · ${euro(r.euro)} · ${fg(r.grammi)}${r.kcal ? ` · ${intero(r.kcal)} kcal` : ''}</span></div>`).join('') : 'Nessuno.'}</div>
    <h2>Fresco, pronto, conserva</h2>
    <div class="card">${s.preparazione.map(r => `<div class="riga"><span>${esc(r.prep)}</span><span class="mut">${r.n} righe · ${euro(r.euro)}</span></div>`).join('')}</div>
    <h2>Varietà</h2>
    <div class="card">${s.varieta.map(r => `<div class="stat"><div class="riga"><span>${esc(r.gruppo)}</span><b>${r.distinti}</b></div><div class="mut">${esc((r.quali || '').split(',').join(', '))}</div></div>`).join('')}</div>
    <h2>Spesa per settimana</h2>
    <div class="card">${s.per_settimana.map(w => `<div class="stat"><div class="riga"><span>${dataBreve(w.dal)} → ${dataBreve(w.al)}</span><b>${euro(w.tot)}</b></div>
      <div class="mut">${w.n} scontrini · cibo ${euro(w.cibo)} · fuori piano ${euro(w.fuori)} · casa ${euro(w.casa)}${w.ignoto ? ` · da classificare ${euro(w.ignoto)}` : ''}${w.kcal ? ` · ${w.senza_kcal ? '≥ ' : ''}${intero(w.kcal)} kcal comprate` : ''}</div></div>`).join('')}</div>`;
};
DOPO.statistiche = p => { if (p.get('giorni')) S.db.kvSet('stat_giorni', p.get('giorni')); };

VISTE.altro = () => `<h1>Altro</h1>
  <div class="lista-link">
    <a href="#/prodotti"><span><b>Prodotti</b><br><span class="mut">conversioni voce → prodotto, dati mancanti</span></span></a>
    <a href="#/scontrini"><span><b>Scontrini</b><br><span class="mut">elenco, dettaglio, elimina</span></span></a>
    <a href="#/piano"><span><b>Piano</b><br><span class="mut">obiettivi settimanali per gruppo</span></span></a>
    <a href="#/dati"><span><b>Dati</b><br><span class="mut">backup, export per Claude, import dal Mac</span></span></a>
  </div>
  <p class="mut">Versione ${VERSIONE}</p>`;

VISTE.piano = () => {
  const gruppi = S.db.all("SELECT * FROM gruppi WHERE tipo IN ('piano','extra') AND id NOT IN ('condimenti','bevande') ORDER BY ordine");
  return `<h1>Piano</h1>
    <form class="card" data-submit="piano-salva">
      <div class="mut">Grammi a settimana per gruppo, dalla lista della spesa del piano alimentare. Vuoto = nessun obiettivo. La rotazione dei secondi usa le porzioni a settimana di: ${RUOLI.secondo.map(id => esc(gruppi.find(g => g.id === id)?.nome || id)).join(', ')}.</div>
      ${gruppi.map(x => `<label class="riga-input"><span>${esc(x.nome)}${x.porzione_g ? ` <span class="mut">porzione ${fg(x.porzione_g)}${RUOLI.secondo.includes(x.id) && x.g_settimana ? ` · ${Math.round(x.g_settimana / x.porzione_g)} a settimana` : ''}</span>` : ''}</span>
        <input name="g_${esc(x.id)}" inputmode="decimal" value="${x.g_settimana !== null ? n1(x.g_settimana) : ''}" placeholder="g/sett."></label>`).join('')}
      <h2>La tua porzione</h2>
      <div class="mut">Grammi di quello che mangi davvero in un pasto, se diverso dal piano (es. una scatola di legumi da 230 g). Dispensa e lista contano in queste porzioni; un gruppo con porzioni più grandi torna meno spesso, così la media a settimana resta quella del piano. Vuoto = porzione del piano.</div>
      ${gruppi.filter(x => TRACCIATI.includes(x.id)).map(x => `<label class="riga-input"><span>${esc(x.nome)} <span class="mut">piano ${fg(x.porzione_g)}</span></span>
        <input name="m_${esc(x.id)}" inputmode="decimal" value="${x.mia_g ? n1(x.mia_g) : ''}" placeholder="${n1(x.porzione_g)} g"></label>`).join('')}
      <button type="button" class="btn" data-act="piano-salva">Salva</button>
    </form>`;
};

VISTE.dati = async () => {
  const db = S.db;
  const ultimo = db.kvGet('ultimo_backup');
  let spazio = '';
  try {
    const st = await navigator.storage?.estimate?.();
    const pers = await navigator.storage?.persisted?.();
    if (st) spazio = `Spazio usato dall'app: ${(st.usage / 1048576).toFixed(1).replace('.', ',')} MB${pers ? ' · archiviazione persistente' : ''}`;
  } catch { /* non disponibile */ }
  const n = t => db.val(`SELECT COUNT(*) FROM ${t}`);
  return `<h1>Dati</h1>
    <div class="card">
      <div>${n('scontrini')} scontrini · ${n('righe')} righe · ${n('prodotti')} prodotti</div>
      <div class="mut">Ultimo backup: ${ultimo ? dataBreve(ultimo) : 'mai'}. ${esc(spazio)}</div>
    </div>
    <div class="card">
      <button type="button" class="btn" data-act="backup">Backup completo</button>
      <div class="mut">File .sqlite con tutto: salvalo su iCloud Drive. Si ripristina da qui sotto.</div>
      <button type="button" class="btn sec" data-act="export">Export per Claude</button>
      <div class="mut">Zip di CSV, lo stesso formato dell'app del Mac: allegalo in chat per l'analisi.</div>
    </div>
    <div class="card">
      <label class="btn sec">Ripristina un backup<input type="file" data-change="ripristina" class="file-nascosto"></label>
      <label class="btn sec">Importa dall'app del Mac (zip)<input type="file" accept=".zip,application/zip" data-change="importa-mac" class="file-nascosto"></label>
      <div class="mut">Entrambi sostituiscono tutti i dati sul telefono.</div>
    </div>
    <div class="card"><button type="button" class="btn sec warn" data-act="cancella-tutto">Cancella tutti i dati</button></div>`;
};

// ---------------------------------------------------------------- azioni
const AZ = {};

const secondiTra = (a, b) => (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 1000;

/** Una conta: le correzioni fatte entro 10 minuti dalla precedente la aggiornano invece di aggiungerne un'altra. */
async function salvaConta(gid, porzioni) {
  const ora = adesso();
  await scrivi(() => {
    const g = porzioni * unita(S.db.one('SELECT mia_g, porzione_g FROM gruppi WHERE id=?', [gid]));
    const ultima = S.db.one('SELECT il FROM conte WHERE gruppo_id=? ORDER BY il DESC LIMIT 1', [gid]);
    if (ultima && secondiTra(ultima.il, ora) < 600) S.db.run('UPDATE conte SET porzioni=?, g=? WHERE gruppo_id=? AND il=?', [porzioni, g, gid, ultima.il]);
    else S.db.run('INSERT INTO conte (gruppo_id, il, porzioni, g) VALUES (?,?,?,?)', [gid, ora, porzioni, g]);
  });
  render();
}

AZ.conta = el => {
  const box = el.closest('.conta');
  const attuale = num(box.querySelector('input').value) || 0;
  return salvaConta(box.dataset.gid, Math.max(0, Math.round(attuale) + parseInt(el.dataset.delta, 10)));
};

AZ['dispensa-ok'] = async () => { await scrivi(() => S.db.kvSet('dispensa_ok', oggi())); render(); };

AZ.pasti = async el => {
  const v = Math.max(0, (parseInt(el.closest('.conta').querySelector('input').value, 10) || 0) + parseInt(el.dataset.delta, 10));
  await scrivi(() => S.db.kvSet('lista_pasti', v));
  render();
};

AZ.spunta = async el => {
  let sp = JSON.parse(S.db.kvGet('spunte', '{}'));
  if (sp.data !== oggi()) sp = { data: oggi(), ids: [] };
  const id = el.dataset.id;
  sp.ids = sp.ids.includes(id) ? sp.ids.filter(x => x !== id) : [...sp.ids, id];
  await scrivi(() => S.db.kvSet('spunte', JSON.stringify(sp)));
  render();
};
AZ['spunte-azzera'] = async () => { await scrivi(() => S.db.kvSet('spunte', null)); render(); };

AZ['scan-live'] = async () => {
  const box = document.getElementById('scanner');
  box.hidden = false;
  try {
    await caricaScript('vendor/zxing.min.js');
    await scanner.avviaLive(box.querySelector('video'), codice => {
      navigator.vibrate?.(60);
      vai(`#/ean?code=${enc(codice)}`);
    });
  } catch (e) {
    box.hidden = true;
    toast(e.name === 'NotAllowedError' ? 'Accesso alla fotocamera negato: abilitalo in Impostazioni → Safari → Fotocamera' : `Fotocamera non disponibile: ${e.message}`, 'warn');
  }
};
AZ['scan-stop'] = () => { scanner.ferma(); document.getElementById('scanner').hidden = true; };

AZ['ean-cerca'] = el => {
  const v = OFF.pulisci(el.closest('form').ean.value);
  if (!v) { toast('Scrivi le cifre del codice', 'warn'); return; }
  vai(`#/ean?code=${v}`);
};

AZ['ean-salva'] = async el => {
  const f = leggi(el.closest('form'));
  const nome = (f.nome || '').trim();
  if (!nome || !f.gruppo_id) { toast('Servono nome e gruppo', 'warn'); return; }
  try {
    await scrivi(() => salvaProdotto(S.db, {
      descrizione: f.descrizione || null, nome, gruppo_id: f.gruppo_id, preparazione: f.preparazione || null,
      peso_conf_g: num(f.peso_conf_g), kcal_100g: num(f.kcal_100g), ean: OFF.pulisci(f.ean), oggi: oggi(),
    }));
  } catch (e) { toast(`Non salvato: ${e.message}`, 'warn'); return; }
  toast('Salvato');
  vai('#/scansiona');
};

AZ.manuale = async el => {
  const f = leggi(el.closest('form'));
  const descr = (f.descrizione || '').trim().toUpperCase();
  const prezzo = num(f.prezzo);
  if (!descr || prezzo === null || !f.negozio.trim()) { toast('Servono negozio, cosa e prezzo', 'warn'); return; }
  const id = `MAN-${Date.now()}`;
  await scrivi(() => {
    S.db.run('INSERT INTO scontrini (id, data, negozio, totale, quadra, importato_il) VALUES (?,?,?,?,1,?)', [id, f.data, f.negozio.trim(), prezzo, adesso()]);
    S.db.run('INSERT INTO righe (scontrino_id, n, descrizione, prezzo, sconto, netto, peso_g) VALUES (?,1,?,?,0,?,?)', [id, descr, prezzo, prezzo, num(f.peso_g)]);
  });
  vai(`#/classifica?d=${enc(descr)}`);
};

function datiProdotto(f) {
  return { nome: (f.nome || '').trim(), gruppo_id: f.gruppo_id || '', preparazione: f.preparazione || null,
    peso_conf_g: num(f.peso_conf_g), kcal_100g: num(f.kcal_100g), prezzo_kg: num(f.prezzo_kg), prezzo_dal: f.prezzo_dal || oggi() };
}

AZ['classifica-salva'] = async el => {
  const form = el.closest('form'), f = leggi(form), dp = datiProdotto(f);
  const { p } = rotta(), da = p.get('da') || '', saltati = p.get('saltati') === '1';
  const esistente = S.db.one('SELECT * FROM prodotti WHERE nome=?', [dp.nome]);
  if (esistente && !dp.gruppo_id) {
    dp.gruppo_id = esistente.gruppo_id;
    dp.preparazione ||= esistente.preparazione;
    if (dp.peso_conf_g === null) dp.peso_conf_g = esistente.peso_conf_g;
  }
  if (!dp.nome || !dp.gruppo_id) { toast('Servono nome e gruppo', 'warn'); return; }
  const soloRiga = /^\d+$/.test(f.applica || '');
  await scrivi(() => {
    const pid = salvaProdotto(S.db, { ...dp, descrizione: soloRiga ? null : f.descrizione, oggi: oggi() });
    if (soloRiga) S.db.run('UPDATE righe SET prodotto_id=? WHERE id=? AND descrizione=?', [pid, parseInt(f.applica, 10), f.descrizione]);
  });
  toast('Salvato');
  if (dp.prezzo_kg || soloRiga) vai(`#/classifica?d=${enc(f.descrizione)}${da ? `&da=${da}` : ''}`);
  else if (da === 'prodotti') vai('#/prodotti');
  else vai(`#/classifica${saltati ? '?saltati=1' : ''}`);
};

AZ['classifica-salta'] = async el => {
  const d = el.closest('form').descrizione.value;
  await scrivi(() => S.db.run(`INSERT INTO alias (descrizione, saltato_il) VALUES (?, ?)
      ON CONFLICT(descrizione) DO UPDATE SET saltato_il=excluded.saltato_il`, [d, adesso()]));
  vai(`#/classifica${rotta().p.get('saltati') === '1' ? '?saltati=1' : ''}`);
};

AZ['righe-pesi'] = async el => {
  const form = el.closest('form');
  const campi = [...form.querySelectorAll('input[name^="peso_"]')];
  let cambiati = 0;
  await scrivi(() => {
    for (const c of campi) {
      const rid = parseInt(c.name.slice(5), 10), grammi = num(c.value);
      const vecchio = S.db.one('SELECT peso_g FROM righe WHERE id=?', [rid]);
      if (!vecchio || vecchio.peso_g === grammi) continue;
      cambiati++;
      S.db.run('DELETE FROM pesate WHERE riga_id=?', [rid]);
      S.db.run('UPDATE righe SET peso_g=?, peso_saltato=0 WHERE id=?', [grammi, rid]);
      const pid = S.db.val('SELECT prodotto_id FROM v_righe WHERE id=?', [rid]);
      if (grammi && pid) S.db.run('INSERT INTO pesate (prodotto_id, riga_id, grammi, data) VALUES (?,?,?,?)', [pid, rid, grammi, oggi()]);
    }
  });
  toast(cambiati ? `Pesi salvati (${cambiati})` : 'Nessun peso cambiato');
  render();
};

AZ['riga-scollega'] = async el => {
  await scrivi(() => S.db.run('UPDATE righe SET prodotto_id=NULL WHERE id=?', [parseInt(el.dataset.rid, 10)]));
  render();
};

AZ['prezzo-elimina'] = async el => {
  await scrivi(() => S.db.run('DELETE FROM prezzi_kg WHERE prodotto_id=? AND dal=?', [parseInt(el.dataset.pid, 10), el.dataset.dal]));
  render();
};

AZ['pesi-salva'] = async el => {
  const f = leggi(el.closest('form')), rid = parseInt(f.riga_id, 10), grammi = num(f.grammi);
  if (!grammi) { toast('Scrivi i grammi, oppure salta', 'warn'); return; }
  await scrivi(() => {
    const pid = S.db.val('SELECT prodotto_id FROM v_righe WHERE id=?', [rid]);
    if (f.fisso) S.db.run('UPDATE prodotti SET peso_conf_g=? WHERE id=?', [grammi, pid]);
    else {
      S.db.run('UPDATE righe SET peso_g=? WHERE id=?', [grammi, rid]);
      S.db.run('INSERT INTO pesate (prodotto_id, riga_id, grammi, data) VALUES (?,?,?,?)', [pid, rid, grammi, oggi()]);
    }
  });
  render();
};
AZ['pesi-salta'] = async el => {
  const rid = parseInt(el.closest('form').riga_id.value, 10);
  await scrivi(() => S.db.run('UPDATE righe SET peso_saltato=1 WHERE id=?', [rid]));
  render();
};
AZ['pesi-salta-prodotto'] = async el => {
  const rid = parseInt(el.closest('form').riga_id.value, 10);
  await scrivi(() => {
    const pid = S.db.val('SELECT prodotto_id FROM v_righe WHERE id=?', [rid]);
    S.db.run('UPDATE righe SET peso_saltato=1 WHERE peso_g IS NULL AND id IN (SELECT id FROM v_righe WHERE prodotto_id=?)', [pid]);
  });
  render();
};
AZ['pesi-riprendi'] = async () => { await scrivi(() => S.db.run('UPDATE righe SET peso_saltato=0')); render(); };

AZ['prodotto-salva'] = async el => {
  const f = leggi(el.closest('form')), dp = datiProdotto(f);
  const id = parseInt(f.id, 10) || null;
  const ean = OFF.pulisci(f.ean) || null;
  if (!dp.nome || !dp.gruppo_id) { toast('Servono nome e gruppo', 'warn'); return; }
  if (ean && !OFF.valido(ean)) { toast('Codice EAN non valido', 'warn'); return; }
  const omonimo = S.db.one('SELECT id FROM prodotti WHERE nome=?', [dp.nome]);
  if (omonimo && omonimo.id !== id) { toast('Esiste già un prodotto con questo nome', 'warn'); return; }
  let nuovoId = id;
  await scrivi(() => {
    if (id) aggiornaProdotto(S.db, id, { ...dp, ean });
    else nuovoId = salvaProdotto(S.db, { ...dp, prezzo_kg: null, ean, oggi: oggi() });
    if (dp.prezzo_kg) aggiungiPrezzo(S.db, nuovoId, dp.prezzo_kg, dp.prezzo_dal);
  });
  toast('Salvato');
  const da = rotta().p.get('da');
  vai(`#/prodotto?id=${nuovoId}${da ? `&da=${da}` : ''}`);
};

AZ['prodotto-elimina'] = async el => {
  const id = parseInt(el.closest('form').id.value, 10);
  if (!confirm('Eliminare il prodotto?')) return;
  await scrivi(() => { S.db.run('DELETE FROM prezzi_kg WHERE prodotto_id=?', [id]); S.db.run('DELETE FROM prodotti WHERE id=?', [id]); });
  toast('Eliminato');
  vai('#/prodotti');
};

AZ['scontrino-elimina'] = async el => {
  if (!confirm('Eliminare lo scontrino e le sue righe?')) return;
  await scrivi(() => S.db.run('DELETE FROM scontrini WHERE id=?', [el.dataset.id]));
  vai('#/scontrini');
};

AZ['piano-salva'] = async el => {
  const form = el.closest('form');
  await scrivi(() => {
    for (const c of form.querySelectorAll('input[name^="g_"]')) S.db.run('UPDATE gruppi SET g_settimana=? WHERE id=?', [num(c.value), c.name.slice(2)]);
    for (const c of form.querySelectorAll('input[name^="m_"]')) {
      const v = num(c.value);
      S.db.run('UPDATE gruppi SET mia_g=? WHERE id=?', [v > 0 ? v : null, c.name.slice(2)]);
    }
  });
  toast('Piano salvato');
  render();
};

// condivisione/scaricamento: deve partire subito dal tocco, senza attese prima di navigator.share
function consegna(nome, bytes, tipo) {
  const file = new File([bytes], nome, { type: tipo });
  if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], title: nome }).then(() => true, e => (e.name === 'AbortError' ? false : scarica(file)));
  return Promise.resolve(scarica(file));
}
function scarica(file) {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  return true;
}

AZ.backup = async () => {
  const bytes = S.db.export();
  const fatto = await consegna(`spesa-backup-${oggi()}.sqlite`, bytes, 'application/octet-stream');
  if (fatto) { await scrivi(() => S.db.kvSet('ultimo_backup', oggi())); toast('Backup pronto'); render(); }
};
AZ.export = async () => { await consegna(`spesa_${oggi()}.zip`, IO.zipExport(S.db), 'application/zip'); };

AZ['cancella-tutto'] = async () => {
  if (!confirm('Cancellare tutti i dati dal telefono?')) return;
  if (!confirm('Sicuro? Senza un backup non si recuperano.')) return;
  S.db.close();
  S.db = new Db(S.SQL); init(S.db);
  await salvaDb();
  toast('Dati cancellati');
  vai('#/dafare');
};

// ---------------------------------------------------------------- eventi di cambio/input
const CH = {};

CH['conta-set'] = el => {
  const v = num(el.value);
  if (v === null || v < 0) { toast('Scrivi un numero di porzioni', 'warn'); render(); return; }
  return salvaConta(el.closest('.conta').dataset.gid, Math.round(v));
};

CH['pasti-set'] = async el => {
  await scrivi(() => S.db.kvSet('lista_pasti', Math.max(0, parseInt(el.value, 10) || 0)));
  render();
};

CH['importa-pdf'] = async el => {
  const files = [...el.files];
  if (!files.length) return;
  toast(`Leggo ${files.length} PDF…`);
  let lib;
  try { lib = await pdfjs(); } catch (e) { toast(e.message, 'warn'); return; }
  const esiti = [];
  for (const file of files) {
    let sc;
    try { sc = await parsePdf(lib, new Uint8Array(await file.arrayBuffer())); }
    catch (e) { esiti.push({ file: file.name, stato: 'errore', msg: e.message }); continue; }
    if (S.db.val('SELECT 1 FROM scontrini WHERE id=?', [sc.id])) {
      esiti.push({ file: file.name, stato: 'già presente', msg: `${dataBreve(sc.data)} · ${euro(sc.totale)}` });
      continue;
    }
    S.db.tx(() => {
      S.db.run(`INSERT INTO scontrini (id, data, ora, documento, negozio, totale, quadra, file, importato_il)
                VALUES (?,?,?,?,?,?,?,?,?)`, [sc.id, sc.data, sc.ora || null, sc.documento || null, sc.negozio, sc.totale, sc.quadra ? 1 : 0, file.name, adesso()]);
      for (const r of sc.righe)
        S.db.run('INSERT INTO righe (scontrino_id, n, descrizione, iva, prezzo, sconto, netto, peso_g) VALUES (?,?,?,?,?,?,?,?)',
          [sc.id, r.n, r.descrizione, r.iva, r.prezzo, r.sconto, r.netto, r.peso_g]);
    });
    let msg = `${dataBreve(sc.data)} · ${sc.righe.length} righe · ${euro(sc.totale)}`;
    if (!sc.quadra) msg += ` · ATTENZIONE: somma righe ${euro(sc.somma_righe)}`;
    if (sc.ignorate.length) msg += ` · righe non riconosciute: ${sc.ignorate.join('; ')}`;
    esiti.push({ file: file.name, stato: 'importato', msg });
  }
  await salvaDb();
  S.esitiImport = esiti;
  el.value = '';
  vai('#/dafare');
};

CH['importa-mac'] = async el => {
  const file = el.files[0];
  if (!file) return;
  let tabelle;
  try { tabelle = IO.leggiZipMac(new Uint8Array(await file.arrayBuffer())); }
  catch (e) { toast(`Zip non valido: ${e.message}`, 'warn'); el.value = ''; return; }
  if (!confirm(`Importare ${tabelle.scontrini.length} scontrini e ${tabelle.prodotti.length} prodotti? Sostituisce i dati sul telefono.`)) { el.value = ''; return; }
  try { IO.importaZipMac(S.db, tabelle); await salvaDb(); }
  catch (e) { toast(`Import fallito: ${e.message}`, 'warn'); el.value = ''; return; }
  toast('Dati importati');
  vai('#/lista');
};

CH.ripristina = async el => {
  const file = el.files[0];
  if (!file) return;
  let bytes;
  try { bytes = IO.apriBackup(S.SQL, new Uint8Array(await file.arrayBuffer())); }
  catch (e) { toast(e.message, 'warn'); el.value = ''; return; }
  if (!confirm('Ripristinare il backup? Sostituisce i dati sul telefono.')) { el.value = ''; return; }
  S.db.close();
  S.db = new Db(S.SQL, bytes); init(S.db);
  await salvaDb();
  toast('Backup ripristinato');
  vai('#/lista');
};

CH['scan-foto'] = async el => {
  const file = el.files[0];
  if (!file) return;
  toast('Cerco il codice nella foto…');
  try {
    await caricaScript('vendor/zxing.min.js');
    const codice = await scanner.daFoto(file);
    if (codice) vai(`#/ean?code=${enc(codice)}`);
    else toast('Nessun codice trovato: avvicinati e tieni il codice dritto', 'warn');
  } catch (e) { toast(e.message, 'warn'); }
  el.value = '';
};

CH['ean-voce'] = el => {
  const p = el.selectedOptions[0]?.dataset.prodotto;
  if (p) { const n = el.form.querySelector('[name=nome]'); n.value = p; IN['nome-prodotto'](n); }
};

const IN = {};

IN.calc = () => {
  const peso = num(document.getElementById('calc_peso').value), imp = num(document.getElementById('calc_euro').value);
  if (!(peso > 0 && imp > 0)) return;
  const kg = peso < 20 ? peso : peso / 1000;
  const v = (imp / kg).toFixed(2);
  document.getElementById('prezzo_kg').value = v.replace('.', ',');
  document.getElementById('calc_out').textContent = `${imp.toFixed(2)} € / ${kg.toFixed(3)} kg = ${v} €/kg`.replace(/\./g, ',');
};

// scegliendo un prodotto esistente, i campi si riempiono con i suoi dati
IN['nome-prodotto'] = el => {
  if (el.id === 'nome-scheda') return;
  const x = S.db.one('SELECT * FROM prodotti WHERE nome=?', [el.value.trim()]);
  const nota = document.getElementById('nota-nome');
  if (!x) { if (nota) nota.textContent = ''; return; }
  const form = el.form;
  form.gruppo_id.value = x.gruppo_id;
  form.preparazione.value = x.preparazione || '';
  form.peso_conf_g.value = x.peso_conf_g !== null ? n1(x.peso_conf_g) : '';
  form.kcal_100g.value = x.kcal_100g !== null ? n1(x.kcal_100g) : '';
  if (nota) nota.textContent = 'Prodotto esistente: dati caricati, la voce verrà collegata a lui.';
};

const filtra = (sel, testo) => {
  const q = testo.trim().toLowerCase();
  document.querySelectorAll(sel).forEach(a => { a.hidden = q && !a.dataset.nome.includes(q); });
};
IN['cerca-prodotto'] = el => {
  filtra('#risultati a', el.value);
  const nuovo = document.getElementById('nuovo-prodotto');
  nuovo.href = `#/prodotto?nuovo=1&da=scansiona&nome=${enc(el.value.trim())}`;
  nuovo.textContent = el.value.trim() ? `Nuovo prodotto «${el.value.trim()}»` : 'Nuovo prodotto';
};
IN['cerca-prodotti'] = el => filtra('.lista-link a[data-nome]', el.value);

// ---------------------------------------------------------------- avvio
document.addEventListener('click', e => {
  const ancora = e.target.closest('a[href="#dispensa"]');
  if (ancora) { e.preventDefault(); document.getElementById('dispensa')?.scrollIntoView({ behavior: 'smooth' }); return; }
  const el = e.target.closest('[data-act]');
  if (!el || !AZ[el.dataset.act]) return;
  e.preventDefault();
  Promise.resolve(AZ[el.dataset.act](el, e)).catch(err => { console.error(err); toast(`Errore: ${err.message}`, 'warn'); });
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el && CH[el.dataset.change]) Promise.resolve(CH[el.dataset.change](el, e)).catch(err => { console.error(err); toast(`Errore: ${err.message}`, 'warn'); });
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el && IN[el.dataset.input]) IN[el.dataset.input](el, e);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const act = e.target.dataset.submit;
  const btn = act && e.target.querySelector(`[data-act="${act}"]`);
  if (btn) btn.click();
});

function aggiornamenti() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const avvisa = w => {
      const b = document.getElementById('aggiorna');
      b.hidden = false;
      b.onclick = () => { S.aggiornando = true; w.postMessage('skipWaiting'); b.textContent = 'Aggiorno…'; };
    };
    if (reg.waiting && navigator.serviceWorker.controller) avvisa(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) avvisa(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(e => console.warn('service worker', e));
  // si ricarica solo dopo il tocco su "aggiorna": al primo avvio clients.claim() cambia controller
  // e una ricarica in quel momento interromperebbe un import in corso
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.aggiornando) { S.aggiornando = false; location.reload(); } });
}

async function avvia() {
  try {
    S.SQL = await globalThis.initSqlJs({ locateFile: f => `vendor/${f}` });
    const bytes = await store.carica();
    S.db = new Db(S.SQL, bytes || undefined);
    init(S.db);
    if (!bytes) await salvaDb();
  } catch (e) {
    app.innerHTML = `<div class="card warn">Impossibile aprire il database: ${esc(e.message)}</div>`;
    throw e;
  }
  window.addEventListener('hashchange', render);
  await render();
  store.chiediPersistenza();
  aggiornamenti();
}

window.__spesa = S;   // per i test
avvia();
