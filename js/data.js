// Carga de datos OHLC: CSV (MetaTrader, TradingView, genérico), Twelve Data y datos de ejemplo.
const Data = (() => {
  const NAMES = {
    date: ['date', 'fecha', 'datetime', 'timestamp', 'dia', 'día'],
    time: ['time', 'hora'],
    o: ['open', 'apertura', 'abrir', 'o'],
    h: ['high', 'max', 'maximo', 'máximo', 'alto', 'h'],
    l: ['low', 'min', 'minimo', 'mínimo', 'bajo', 'l'],
    c: ['close', 'cierre', 'cerrar', 'ultimo', 'último', 'price', 'precio', 'c'],
  };

  function parseDate(s) {
    s = String(s).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const v = Number(s);
      if (v > 1e11) return v;          // milisegundos
      if (v > 1e8) return v * 1000;     // segundos (unix)
    }
    s = s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3')               // 2024.01.02 (MetaTrader)
      .replace(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/, (m, d, mo, y) =>    // 02/01/2024 (dd/mm/aaaa)
        `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
    // Fecha y hora sin zona horaria: se interpreta como UTC, igual que se muestra
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }

  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('El archivo está vacío.');
    const first = lines[0];
    const delim = ['\t', ';', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const header = first.split(delim).map(s => s.replace(/[<>"']/g, '').trim().toLowerCase());
    const find = list => header.findIndex(h => list.includes(h));

    let dIdx = find(NAMES.date), tIdx = find(NAMES.time);
    if (dIdx < 0 && tIdx >= 0) { dIdx = tIdx; tIdx = -1; }
    const idx = { o: find(NAMES.o), h: find(NAMES.h), l: find(NAMES.l), c: find(NAMES.c) };
    const missing = Object.entries(idx).filter(([, v]) => v < 0).map(([k]) => ({ o: 'apertura', h: 'máximo', l: 'mínimo', c: 'cierre' }[k]));
    if (missing.length) throw new Error(`No encuentro las columnas: ${missing.join(', ')}. Cabecera leída: ${header.join(' | ')}`);

    const num = s => Number(String(s).trim().replace(/"/g, '').replace(delim === ';' ? /,/ : /(?!)/, '.'));
    const bars = [];
    for (let k = 1; k < lines.length; k++) {
      const cols = lines[k].split(delim);
      const bar = { o: num(cols[idx.o]), h: num(cols[idx.h]), l: num(cols[idx.l]), c: num(cols[idx.c]) };
      if (![bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)) continue;
      const raw = dIdx >= 0 ? (cols[dIdx] + (tIdx >= 0 ? ' ' + cols[tIdx] : '')).replace(/"/g, '') : '';
      bar.t = dIdx >= 0 ? parseDate(raw) : NaN;
      bars.push(bar);
    }
    return normalize(bars);
  }

  function normalize(bars) {
    if (bars.length && bars.every(b => Number.isFinite(b.t))) bars.sort((a, b) => a.t - b.t);
    for (const b of bars) { b.h = Math.max(b.h, b.o, b.c); b.l = Math.min(b.l, b.o, b.c); }
    return bars;
  }

  async function fetchTwelveData(symbol, interval, apikey) {
    const url = 'https://api.twelvedata.com/time_series?' + new URLSearchParams({
      symbol, interval, outputsize: '5000', order: 'ASC', apikey,
    });
    const res = await fetch(url);
    const json = await res.json();
    if (json.status === 'error' || !json.values) throw new Error(json.message || 'Twelve Data no devolvió datos.');
    return normalize(json.values.map(v => ({
      t: parseDate(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close,
    })));
  }

  // Serie sintética con rachas de tendencia: solo para probar la herramienta.
  function synthetic(n = 4000) {
    let seed = 42;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    const bars = [];
    let price = 1.1, drift = 0, vol = 0.0012, t = Date.UTC(2023, 0, 2);
    for (let i = 0; i < n; i++) {
      if (rand() < 0.01) drift = (rand() - 0.5) * 0.0008;
      vol = Math.max(0.0005, Math.min(0.003, vol * (1 + gauss() * 0.05)));
      const o = price;
      const c = o * (1 + drift + gauss() * vol);
      const h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.5);
      const l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.5);
      bars.push({ t, o, h, l, c });
      price = c;
      t += 3600e3;
    }
    return bars;
  }

  return { parseCSV, fetchTwelveData, synthetic };
})();
