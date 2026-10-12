// Entrena los modelos de la señal en vivo con los CSV de data/ y guarda data/modelos/<intervalo>.json.
// Para cada mercado y cada salida posible (TP en ATR) hace un backtest walk-forward: la salida solo
// se marca como "con ventaja" si en datos no vistos: tuvo al menos 50 operaciones, +0,05 R de media y profit
// factor 1,15; acierta 2 puntos más que entrar sin filtro; sus probabilidades ordenan bien (AUC >= 0,52) y
// gana en al menos 3 de 4 tramos del periodo de prueba (ver Backtest.edgeCheck).
// Lo ejecuta cada día GitHub Actions. En local: node scripts/entrenar-modelos.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import '../js/indicators.js';
import '../js/model.js';
import '../js/backtest.js';
import '../js/data.js';
import '../js/signals.js';

const r = (v, d = 5) => Number.isFinite(v) ? Number(v.toPrecision(d)) : null;
const pack = m => ({ w: m.w.map(v => r(v)), b: r(m.b), mean: m.mean.map(v => r(v, 6)), std: m.std.map(v => r(v, 6)) });

await mkdir('data/modelos', { recursive: true });
const t0 = Date.now();

for (const iv of Signals.INTERVALS) {
  const out = { interval: iv, updated: new Date().toISOString(), sl: Signals.SL, minEv: Signals.MIN_EV, markets: {} };
  for (const mk of Signals.MARKETS) {
    let bars;
    try { bars = Data.parseCSV(await readFile(`data/${mk.id}_${iv}.csv`, 'utf8')); }
    catch { console.error(`Sin datos: ${mk.id} ${iv}`); continue; }
    if (bars.length < 500) { console.error(`Pocas velas: ${mk.id} ${iv} (${bars.length})`); continue; }

    const entry = { cost: mk.cost, bars: bars.length, exits: {} };
    const summary = [];
    for (const tp of Signals.EXITS) {
      const p = { sl: Signals.SL, tp, maxBars: Signals.MAX_BARS[iv], cost: mk.cost, trainPct: 0.5, folds: 5 };
      const res = Backtest.run(bars, p);
      if (!res.models) continue;
      // Exigente a propósito: con 200+ combinaciones probadas, algunas salen positivas por azar
      const chk = Backtest.edgeCheck(res, Backtest.selectTrades(res, Signals.minProb(tp)));
      const { m, base, edge } = chk;
      entry.exits[tp] = {
        long: pack(res.models.long), short: pack(res.models.short),
        stats: {
          n: m.n, winRate: r(m.winRate, 3), avgR: r(m.avgR, 3), pf: r(m.pf, 3), maxDD: r(m.maxDD, 3),
          baseWinRate: r(base.winRate, 3), auc: r(chk.auc, 3), positiveBlocks: chk.positiveBlocks, edge, fails: chk.fails,
        },
      };
      summary.push(`TP${tp}: ${m.n} op, ${(m.winRate * 100 || 0).toFixed(1)}% (sin filtro ${(base.winRate * 100).toFixed(1)}%), ${(m.avgR || 0).toFixed(2)}R, AUC ${chk.auc.toFixed(3)}, ${chk.positiveBlocks}/4${edge ? ' *' : ''}`);
    }
    out.markets[mk.id] = entry;
    console.log(`${mk.name} ${iv} | ${summary.join(' | ')}`);
  }
  await writeFile(`data/modelos/${iv}.json`, JSON.stringify(out) + '\n');
}
console.log(`Entrenamiento terminado en ${((Date.now() - t0) / 1000).toFixed(0)} s (* = salida con ventaja en el backtest)`);
