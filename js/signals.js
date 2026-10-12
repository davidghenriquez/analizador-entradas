// Mercados disponibles y señal en vivo: probabilidad de entrada y salida recomendada
// para la última vela cerrada. Lo usan la web, el Worker de avisos y el entrenamiento diario.
const Signals = (() => {
  // cost = spread + comisión aproximados, en unidades de precio
  const MARKETS = [
    { id: 'eurusd', name: 'EUR/USD', yahoo: 'EURUSD=X', group: 'Forex', cost: 0.0001 },
    { id: 'gbpusd', name: 'GBP/USD', yahoo: 'GBPUSD=X', group: 'Forex', cost: 0.00015 },
    { id: 'usdjpy', name: 'USD/JPY', yahoo: 'USDJPY=X', group: 'Forex', cost: 0.015 },
    { id: 'audusd', name: 'AUD/USD', yahoo: 'AUDUSD=X', group: 'Forex', cost: 0.00015 },
    { id: 'usdcad', name: 'USD/CAD', yahoo: 'USDCAD=X', group: 'Forex', cost: 0.0002 },
    { id: 'usdchf', name: 'USD/CHF', yahoo: 'USDCHF=X', group: 'Forex', cost: 0.0002 },
    { id: 'eurjpy', name: 'EUR/JPY', yahoo: 'EURJPY=X', group: 'Forex', cost: 0.02 },
    { id: 'gbpjpy', name: 'GBP/JPY', yahoo: 'GBPJPY=X', group: 'Forex', cost: 0.03 },
    { id: 'eurgbp', name: 'EUR/GBP', yahoo: 'EURGBP=X', group: 'Forex', cost: 0.00015 },
    { id: 'oro', name: 'Oro (futuro)', yahoo: 'GC=F', group: 'Materias primas', cost: 0.4 },
    { id: 'sp500', name: 'S&P 500', yahoo: '^GSPC', group: 'Índices', cost: 0.6 },
    { id: 'nasdaq100', name: 'Nasdaq 100', yahoo: '^NDX', group: 'Índices', cost: 2 },
    { id: 'dowjones', name: 'Dow Jones', yahoo: '^DJI', group: 'Índices', cost: 4 },
    { id: 'dax', name: 'DAX 40', yahoo: '^GDAXI', group: 'Índices', cost: 2 },
    { id: 'ibex35', name: 'IBEX 35', yahoo: '^IBEX', group: 'Índices', cost: 6 },
    { id: 'eurostoxx50', name: 'Euro Stoxx 50', yahoo: '^STOXX50E', group: 'Índices', cost: 2 },
    { id: 'nikkei', name: 'Nikkei 225', yahoo: '^N225', group: 'Índices', cost: 10 },
  ];
  const INTERVALS = ['1h', '4h', '1d'];
  const INTERVAL_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3 };
  const MAX_BARS = { '1h': 24, '4h': 18, '1d': 10 };

  const SL = 1;                   // stop loss: 1 ATR
  const EXITS = [1, 1.5, 2, 3];   // take profit posibles, en ATR
  const MIN_EV = 0.1;             // ventaja mínima esperada (en R) para dar señal

  // Resultado esperado en R si la probabilidad de acierto es p
  const ev = (p, tp) => p * tp / SL - (1 - p);
  // Probabilidad mínima para que el resultado esperado llegue a MIN_EV
  const minProb = tp => (1 + MIN_EV) / (1 + tp / SL);

  // Velas de varias horas a partir de las de 1 hora (bloques UTC de 00, 04, 08…)
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

  // Quita la vela en curso, que aún no ha cerrado
  function closedBars(bars, interval, now = Date.now()) {
    return bars.filter(b => b.t + INTERVAL_MS[interval] <= now);
  }

  // model: { cost, exits: { '1.5': { long, short, stats } } } (data/modelos/<intervalo>.json)
  function evaluate(bars, model) {
    const feats = Model.buildFeatures(bars);
    const i = bars.length - 1;
    const x = feats.X[i];
    if (!x) return null;
    const a = feats.atr[i], close = bars[i].c;
    const options = [];
    for (const [tpKey, e] of Object.entries(model.exits)) {
      const tp = +tpKey;
      for (const [dir, m] of [[1, e.long], [-1, e.short]]) {
        const p = Model.predict(m, x);
        const entry = close + dir * model.cost;   // aprox.: la apertura de la vela siguiente
        options.push({
          dir, tp, p, ev: ev(p, tp), minProb: minProb(tp), entry,
          stop: entry - dir * SL * a, target: entry + dir * tp * a,
          stats: e.stats, edge: !!e.stats.edge,
        });
      }
    }
    options.sort((a, b) => b.ev - a.ev);
    const best = options.find(o => o.edge && o.ev >= MIN_EV) || null;
    return { t: bars[i].t, close, atr: a, options, best };
  }

  const digits = price => price < 10 ? 5 : price < 1000 ? 3 : 1;

  return { MARKETS, INTERVALS, INTERVAL_MS, MAX_BARS, SL, EXITS, MIN_EV, ev, minProb, aggregate, closedBars, evaluate, digits };
})();

globalThis.Signals = Signals;
