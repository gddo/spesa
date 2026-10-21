// Lettura degli scontrini digitali Esselunga (PDF con testo, scaricati dall'app).
// estraiTesto() ricostruisce le righe del PDF con pdf.js; parse() interpreta il testo.

const RE_BARCODE = /^\d{20,}$/;
const RE_ARTICOLO = /^(.+?)\s+\*([a-z])\s+(-?\d+,\d{2})$/;
const RE_SCONTO = /SCONTO.*?(\d+,\d{2})-S$/;
const RE_PESO = /^(\d+,\d{3})\s*kg/i;               // riga peso, se Esselunga la stampa
const RE_ALIQUOTA = /^\*([a-z])\s*=\s*IVA\s*(\d+)%/;
const RE_DATA = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}:\d{2})$/;
const RE_DOC = /DOCUMENTO N\.\s*(\S+)/;
const RE_TOTALE = /^TOTALE EURO\s+(\d+,\d{2})/;
const RE_NEGOZIO = /^Via .+ - ([A-Z ]+)$/;
// righe dentro il corpo dello scontrino che non sono articoli né sconti
const IGNORA = /PUNTI FRAGOLA|BUONO SCONTO|^P\)PUNTI/i;

const euro = s => parseFloat(s.replace(',', '.'));
const r2 = v => Math.round(v * 100) / 100;
const titolo = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

export class ScontrinoNonLeggibile extends Error {}

/** Testo del PDF riga per riga: elementi con la stessa y, in ordine di x, spazi multipli ridotti a uno. */
export async function estraiTesto(pdfjsLib, data) {
  const doc = await pdfjsLib.getDocument({ data, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const righe = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const perY = new Map();
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5] * 2) / 2;
        let k = [...perY.keys()].find(v => Math.abs(v - y) < 1.5);
        if (k === undefined) { k = y; perY.set(k, []); }
        perY.get(k).push(it);
      }
      const ys = [...perY.keys()].sort((a, b) => b - a);   // dall'alto in basso
      for (const y of ys) {
        const testo = perY.get(y).sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join('');
        const t = testo.replace(/\s+/g, ' ').trim();
        if (t) righe.push(t);
      }
    }
  } finally {
    doc.destroy();
  }
  return righe.join('\n');
}

export function parse(testo) {
  const righeTxt = testo.split('\n').map(r => r.trim()).filter(Boolean);
  if (!righeTxt.length || !RE_BARCODE.test(righeTxt[0]))
    throw new ScontrinoNonLeggibile('codice a barre iniziale non trovato: non sembra uno scontrino Esselunga');
  if (!testo.includes('ESSELUNGA')) throw new ScontrinoNonLeggibile('non è uno scontrino Esselunga');

  const sc = { id: righeTxt[0], negozio: 'Esselunga', righe: [], ignorate: [] };
  const aliquote = {};
  let dentro = false, m;
  for (const riga of righeTxt) {
    if ((m = RE_NEGOZIO.exec(riga))) sc.negozio = `Esselunga ${titolo(m[1].trim())}`;
    if (riga.startsWith('IVA EURO')) { dentro = true; continue; }
    if ((m = RE_TOTALE.exec(riga))) { sc.totale = euro(m[1]); dentro = false; continue; }
    if (dentro) {
      const ultima = sc.righe[sc.righe.length - 1];
      if ((m = RE_ARTICOLO.exec(riga))) {
        sc.righe.push({ descrizione: m[1].trim(), ivaCod: m[2], prezzo: euro(m[3]), sconto: 0, peso_g: null });
      } else if ((m = RE_SCONTO.exec(riga)) && ultima) {
        ultima.sconto += euro(m[1]);
      } else if ((m = RE_PESO.exec(riga)) && ultima) {
        ultima.peso_g = euro(m[1]) * 1000;
      } else if (!IGNORA.test(riga)) {
        sc.ignorate.push(riga);
      }
      continue;
    }
    if ((m = RE_ALIQUOTA.exec(riga))) aliquote[m[1]] = parseInt(m[2], 10);
    else if ((m = RE_DATA.exec(riga)) && !sc.data) { sc.data = `${m[3]}-${m[2]}-${m[1]}`; sc.ora = m[4]; }
    else if ((m = RE_DOC.exec(riga)) && !sc.documento) sc.documento = m[1];
  }
  if (!sc.data || sc.totale === undefined || !sc.righe.length)
    throw new ScontrinoNonLeggibile('mancano data, totale o articoli');

  sc.righe.forEach((r, i) => {
    r.n = i + 1;
    r.iva = aliquote[r.ivaCod] ?? null;
    delete r.ivaCod;
    r.sconto = r2(r.sconto);
    r.netto = r2(r.prezzo - r.sconto);
  });
  sc.somma_righe = r2(sc.righe.reduce((s, r) => s + r.netto, 0));
  sc.quadra = Math.abs(sc.somma_righe - sc.totale) < 0.005;
  return sc;
}

export async function parsePdf(pdfjsLib, data) {
  return parse(await estraiTesto(pdfjsLib, data));
}
