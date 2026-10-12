// Descarga velas de Yahoo Finance y las guarda en data/ como CSV para que la web las cargue directamente.
// Lo ejecuta cada día GitHub Actions (.github/workflows/datos.yml). En local: node scripts/actualizar-datos.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import '../js/signals.js';

async function fetchBars(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (analizador-entradas)' } });
  if (!res.ok) throw new Error(`${symbol} ${interval}: HTTP ${res.status}`);
  const r = (await res.json()).chart.result?.[0];
  if (!r?.timestamp) throw new Error(`${symbol} ${interval}: sin datos`);
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    const b = { t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] };
    if ([b.o, b.h, b.l, b.c].every(v => Number.isFinite(v) && v > 0)) bars.push(b);
  });
  return bars;
}

const round = v => Number(v.toPrecision(7));
const toCSV = bars => 'time,open,high,low,close\n'
  + bars.map(b => [new Date(b.t).toISOString().slice(0, 16).replace('T', ' '), round(b.o), round(b.h), round(b.l), round(b.c)].join(',')).join('\n') + '\n';

await mkdir('data', { recursive: true });
const index = { updated: new Date().toISOString(), source: 'Yahoo Finance', symbols: [] };
let failures = 0;

for (const s of Signals.MARKETS) {
  const entry = { id: s.id, name: s.name, group: s.group, intervals: {} };
  try {
    const h1 = await fetchBars(s.yahoo, '1h', '730d');
    const d1 = await fetchBars(s.yahoo, '1d', '10y');
    const sets = { '1h': h1, '4h': Signals.aggregate(h1, 4), '1d': d1 };
    for (const [iv, all] of Object.entries(sets)) {
      const bars = Signals.closedBars(all, iv);   // sin la vela en curso
      await writeFile(`data/${s.id}_${iv}.csv`, toCSV(bars));
      entry.intervals[iv] = { bars: bars.length, from: bars[0].t, to: bars[bars.length - 1].t };
    }
    index.symbols.push(entry);
    console.log(`${s.name}: 1h ${h1.length}, 1d ${d1.length}`);
  } catch (err) {
    failures++;
    console.error(`Error en ${s.name}: ${err.message}`);
  }
}

await writeFile('data/index.json', JSON.stringify(index, null, 1) + '\n');
if (failures === Signals.MARKETS.length) process.exit(1);
