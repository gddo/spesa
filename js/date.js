// Date come stringhe ISO locali (YYYY-MM-DD), senza fusi orari.
const pad = n => String(n).padStart(2, '0');

export function oggi(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function adesso(d = new Date()) {
  return `${oggi(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const giorno = iso => { const [y, m, g] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, g) / 86400000; };

export function piuGiorni(iso, n) {
  const d = new Date((giorno(iso) + n) * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const diffGiorni = (a, b) => giorno(a) - giorno(b);   // a - b in giorni

export function dataBreve(iso) {
  if (!iso) return '';
  const [y, m, g] = iso.slice(0, 10).split('-');
  return `${g}/${m}/${y.slice(2)}`;
}
