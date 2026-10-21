// Codici EAN: cifra di controllo e ricerca su Open Food Facts (l'API consente richieste dal browser).
const URL_OFF = 'https://world.openfoodfacts.org/api/v2/product/{ean}.json?fields=product_name,product_name_it,brands,quantity,product_quantity,product_quantity_unit,nutriments';

export const pulisci = ean => String(ean || '').replace(/\D/g, '');

/** Cifra di controllo GTIN (EAN-8, UPC-12, EAN-13, GTIN-14): intercetta i codici scritti male. */
export function valido(ean) {
  if (![8, 12, 13, 14].includes(ean.length)) return false;
  const cifre = ean.split('').map(Number);
  const controllo = cifre.pop();
  const somma = cifre.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (somma % 10)) % 10 === controllo;
}

/** EAN-13 che iniziano per 2: codici interni del negozio (pesati al banco), non identificano il prodotto. */
export const pesoVariabile = ean => ean.length === 13 && ean.startsWith('2');

export async function cerca(ean, timeoutMs = 8000) {
  const esito = { trovato: false, nome: null, marca: null, quantita: null, peso_g: null, kcal_100g: null, errore: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let dati;
  try {
    const r = await fetch(URL_OFF.replace('{ean}', ean), { signal: ctl.signal });
    if (r.status === 404) return esito;
    if (!r.ok) { esito.errore = `Open Food Facts ha risposto ${r.status}`; return esito; }
    dati = await r.json();
  } catch (e) {
    esito.errore = navigator.onLine === false ? 'sei offline: inserisci i dati a mano'
      : `Open Food Facts non raggiungibile (${e.name === 'AbortError' ? 'tempo scaduto' : e.message})`;
    return esito;
  } finally { clearTimeout(timer); }
  if (dati.status !== 1) return esito;
  const p = dati.product || {}, n = p.nutriments || {};
  esito.trovato = true;
  esito.nome = p.product_name_it || p.product_name || null;
  esito.marca = (p.brands || '').split(',')[0].trim() || null;
  esito.quantita = p.quantity || null;
  if (p.product_quantity && ['g', 'ml'].includes(String(p.product_quantity_unit || 'g').toLowerCase())) {
    const v = parseFloat(p.product_quantity);
    if (v > 0) esito.peso_g = v;
  }
  let kcal = n['energy-kcal_100g'];
  if ((kcal === undefined || kcal === null) && n.energy_100g != null) kcal = parseFloat(n.energy_100g) / 4.184;  // solo kJ
  if (kcal !== undefined && kcal !== null && !isNaN(kcal)) esito.kcal_100g = Math.round(kcal);
  return esito;
}
