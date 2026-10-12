// Descarga velas de Yahoo Finance y las guarda en data/ como CSV para que la web las cargue directamente.
// Lo ejecuta cada día GitHub Actions (.github/workflows/datos.yml). En local: node scripts/actualizar-datos.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const SYMBOLS = [
  { id: 'eurusd', name: 'EUR/USD', yahoo: 'EURUSD=X', group: 'Forex' },
  { id: 'gbpusd', name: 'GBP/USD', yahoo: 'GBPUSD=X', group: 'Forex' },
  { id: 'usdjpy', name: 'USD/JPY', yahoo: 'USDJPY=X', group: 'Forex' },
  { id: 'audusd', name: 'AUD/USD', yahoo: 'AUDUSD=X', group: 'Forex' },
  { id: 'usdcad', name: 'USD/CAD', yahoo: 'USDCAD=X', group: 'Forex' },
  { id: 'usdchf', name: 'USD/CHF', yahoo: 'USDCHF=X', group: 'Forex' },
  { id: 'eurjpy', name: 'EUR/JPY', yahoo: 'EURJPY=X', group: 'Forex' },
  { id: 'gbpjpy', name: 'GBP/JPY', yahoo: 'GBPJPY=X', group: 'Forex' },
  { id: 'eurgbp', name: 'EUR/GBP', yahoo: 'EURGBP=X', group: 'Forex' },
  { id: 'oro', name: 'Oro (futuro)', yahoo: 'GC=F', group: 'Materias primas' },
  { id: 'sp500', name: 'S&P 500', yahoo: '^GSPC', group: 'Índices' },
  { id: 'nasdaq100', name: 'Nasdaq 100', yahoo: '^NDX', group: 'Índices' },
  { id: 'dowjones', name: 'Dow Jones', yahoo: '^DJI', group: 'Índices' },
  { id: 'dax', name: 'DAX 40', yahoo: '^GDAXI', group: 'Índices' },
  { id: 'ibex35', name: 'IBEX 35', yahoo: '^IBEX', group: 'Índices' },
  { id: 'eurostoxx50', name: 'Euro Stoxx 50', yahoo: '^STOXX50E', group: 'Índices' },
  { id: 'nikkei', name: 'Nikkei 225', yahoo: '^N225', group: 'Índices' },
];

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
  // La última vela puede estar a medias: se descarta
  return bars.slice(0, -1);
}

// Velas de 4 horas a partir de las de 1 hora (bloques UTC de 00, 04, 08…)
function aggregate(bars, hours) {
  const size = hours * 3600e3, out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / size) * size;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c;
    } else out.push({ ...b, t });
  }
  return out;
}

const round = v => Number(v.toPrecision(7));
const toCSV = bars => 'time,open,high,low,close\n'
  + bars.map(b => [new Date(b.t).toISOString().slice(0, 16).replace('T', ' '), round(b.o), round(b.h), round(b.l), round(b.c)].join(',')).join('\n') + '\n';

await mkdir('data', { recursive: true });
const index = { updated: new Date().toISOString(), source: 'Yahoo Finance', symbols: [] };
let failures = 0;

for (const s of SYMBOLS) {
  const entry = { id: s.id, name: s.name, group: s.group, intervals: {} };
  try {
    const h1 = await fetchBars(s.yahoo, '1h', '730d');
    const d1 = await fetchBars(s.yahoo, '1d', '10y');
    for (const [iv, bars] of [['1h', h1], ['4h', aggregate(h1, 4)], ['1d', d1]]) {
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
if (failures === SYMBOLS.length) process.exit(1);
