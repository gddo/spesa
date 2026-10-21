// Formattazione e piccoli helper per l'interfaccia.
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const it = (v, dec) => v.toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
export const euro = v => (v === null || v === undefined || isNaN(v) ? '–' : `${it(v, 2)} €`);
export const g = v => (v === null || v === undefined || isNaN(v) ? '–' : v >= 1000 ? `${it(v / 1000, 1)} kg` : `${Math.round(v)} g`);
export const n1 = v => (v === null || v === undefined || isNaN(v) ? '–' : String(Math.round(v * 100) / 100).replace('.', ','));
export const intero = v => (v === null || v === undefined || isNaN(v) ? '–' : Math.round(v).toLocaleString('it-IT'));

/** Numero da un campo di testo con virgola o punto; vuoto = null. */
export function num(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const x = parseFloat(s);
  return isNaN(x) ? null : x;
}

export const attr = (cond, nome) => (cond ? ` ${nome}` : '');
export const opzioni = (lista, sel, vuota = '—') =>
  (vuota !== null ? `<option value="">${esc(vuota)}</option>` : '') +
  lista.map(([v, t]) => `<option value="${esc(v)}"${attr(String(v) === String(sel ?? ''), 'selected')}>${esc(t)}</option>`).join('');
