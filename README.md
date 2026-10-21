# Spesa & piano

Web app (PWA) per registrare gli scontrini Esselunga, capire cosa comprare e confrontare la spesa con un piano alimentare.
Funziona offline. Tutti i dati restano nel telefono (SQLite nel browser): questo repository contiene solo il codice.

- `index.html`, `styles.css`, `js/` — l'app
- `sw.js` — cache offline (cambiare `VERSIONE` a ogni rilascio)
- `vendor/` — librerie di terze parti, con le rispettive licenze: sql.js (MIT), pdf.js (Apache 2.0), fflate (MIT), ZXing (Apache 2.0)
