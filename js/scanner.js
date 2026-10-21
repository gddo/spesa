// Lettura codici a barre con ZXing (Safari su iPhone non ha BarcodeDetector).
let lettore = null;

function suggerimenti() {
  const Z = globalThis.ZXing;
  const h = new Map();
  h.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
  h.set(Z.DecodeHintType.TRY_HARDER, true);
  return h;
}

/** Fotocamera posteriore nel <video>; alla prima lettura ferma la fotocamera e chiama onCodice. */
export async function avviaLive(video, onCodice) {
  ferma();
  const Z = globalThis.ZXing;
  lettore = new Z.BrowserMultiFormatReader(suggerimenti(), 250);
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.muted = true;
  const vincoli = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };
  await lettore.decodeFromConstraints(vincoli, video, res => {
    if (!res) return;
    const testo = res.getText();
    ferma();
    onCodice(testo);
  });
}

export function ferma() {
  if (!lettore) return;
  try { lettore.reset(); } catch { /* già fermo */ }
  lettore = null;
}

export const attivo = () => !!lettore;

function caricaImmagine(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('immagine non leggibile')); };
    img.src = url;
  });
}

function disegna(img, maxLato, gradi) {
  const k = Math.min(1, maxLato / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas');
  const ruota = gradi % 180 !== 0;
  c.width = ruota ? h : w; c.height = ruota ? w : h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(gradi * Math.PI / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

/** Codice da una foto: prova più dimensioni e la rotazione di 90° (codice fotografato in verticale). */
export async function daFoto(file) {
  const Z = globalThis.ZXing;
  const img = await caricaImmagine(file);
  const reader = new Z.MultiFormatReader();
  for (const lato of [1600, 1000, 2400])
    for (const gradi of [0, 90]) {
      try {
        const sorgente = new Z.HTMLCanvasElementLuminanceSource(disegna(img, lato, gradi));
        return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(sorgente)), suggerimenti()).getText();
      } catch { /* nessun codice a questa scala */ }
    }
  return null;
}
