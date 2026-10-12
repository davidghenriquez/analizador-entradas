// Patrones (features), simulación de operaciones y modelo de regresión logística.
const Model = (() => {
  const FEATURE_NAMES = [
    'Retorno 1 vela', 'Retorno 3 velas', 'Retorno 5 velas', 'Retorno 10 velas',
    'RSI 14', 'Pendiente RSI',
    'Distancia a EMA 20', 'Distancia a EMA 50', 'EMA 20 vs EMA 50', 'Pendiente EMA 20',
    'Volatilidad relativa (ATR)',
    'Cuerpo de la vela', 'Mecha superior', 'Mecha inferior',
    'Posición en rango 20 velas',
  ];

  // Cada fila usa solo información disponible al cierre de la vela i (sin mirar el futuro).
  function buildFeatures(bars) {
    const o = bars.map(b => b.o), h = bars.map(b => b.h), l = bars.map(b => b.l), c = bars.map(b => b.c);
    const atr = Ind.atr(bars, 14);
    const atrMean = Ind.sma(atr, 50);
    const e20 = Ind.ema(c, 20), e50 = Ind.ema(c, 50);
    const r14 = Ind.rsi(c, 14);
    const hi20 = Ind.rollingMax(h, 20), lo20 = Ind.rollingMin(l, 20);
    const X = new Array(bars.length).fill(null);

    for (let i = 70; i < bars.length; i++) {
      const a = atr[i];
      if (!(a > 0) || !Number.isFinite(atrMean[i]) || !Number.isFinite(e50[i]) || !Number.isFinite(r14[i - 3])) continue;
      const range = h[i] - l[i] || a * 1e-3;
      const span = hi20[i] - lo20[i] || a;
      const f = [
        (c[i] - c[i - 1]) / a, (c[i] - c[i - 3]) / a, (c[i] - c[i - 5]) / a, (c[i] - c[i - 10]) / a,
        (r14[i] - 50) / 50, (r14[i] - r14[i - 3]) / 50,
        (c[i] - e20[i]) / a, (c[i] - e50[i]) / a, (e20[i] - e50[i]) / a, (e20[i] - e20[i - 5]) / a,
        a / atrMean[i] - 1,
        (c[i] - o[i]) / range, (h[i] - Math.max(o[i], c[i])) / range, (Math.min(o[i], c[i]) - l[i]) / range,
        (c[i] - lo20[i]) / span - 0.5,
      ];
      if (f.every(Number.isFinite)) X[i] = f;
    }
    return { X, atr, names: FEATURE_NAMES };
  }

  // Simula una entrada decidida al cierre de la vela i y ejecutada en la apertura de i+1.
  // dir = 1 largo, -1 corto. Devuelve null si no hay velas suficientes para resolverla.
  function simulate(bars, i, dir, a, p) {
    const e = i + 1;
    const last = e + p.maxBars - 1;
    if (last >= bars.length || !(a > 0)) return null;
    const entry = bars[e].o + dir * p.cost;
    const dist = p.sl * a;
    const sl = entry - dir * dist;
    const tp = entry + dir * p.tp * a;

    for (let k = e; k <= last; k++) {
      const b = bars[k];
      const hitSL = dir > 0 ? b.l <= sl : b.h >= sl;
      const hitTP = dir > 0 ? b.h >= tp : b.l <= tp;
      if (hitSL) {
        // Si en la misma vela se tocan SL y TP, se asume lo peor (SL). Con gap, se sale a la apertura.
        const gap = k > e && (dir > 0 ? b.o < sl : b.o > sl);
        const exit = gap ? b.o : sl;
        return { dir, entryIdx: e, exitIdx: k, entry, exit, r: dir * (exit - entry) / dist, reason: 'SL' };
      }
      if (hitTP) {
        const gap = k > e && (dir > 0 ? b.o > tp : b.o < tp);
        const exit = gap ? b.o : tp;
        return { dir, entryIdx: e, exitIdx: k, entry, exit, r: dir * (exit - entry) / dist, reason: 'TP' };
      }
    }
    const exit = bars[last].c;
    return { dir, entryIdx: e, exitIdx: last, entry, exit, r: dir * (exit - entry) / dist, reason: 'Tiempo' };
  }

  // Regresión logística con regularización L2 y descenso de gradiente (Adam).
  function train(X, y, opts = {}) {
    const epochs = opts.epochs || 250, lr = opts.lr || 0.05, l2 = opts.l2 ?? 0.01;
    const n = X.length, d = X[0].length;
    const mean = new Array(d).fill(0), std = new Array(d).fill(0);
    for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
    for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
    const Z = X.map(x => x.map((v, j) => Math.max(-5, Math.min(5, (v - mean[j]) / std[j]))));

    const pos = y.reduce((s, v) => s + v, 0) / n;
    const w = new Array(d).fill(0);
    let b = Math.log(Math.max(pos, 1e-3) / Math.max(1 - pos, 1e-3));
    const mW = new Array(d).fill(0), vW = new Array(d).fill(0);
    let mB = 0, vB = 0;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const g = new Array(d);

    for (let t = 1; t <= epochs; t++) {
      g.fill(0);
      let gb = 0;
      for (let i = 0; i < n; i++) {
        const z = Z[i];
        let s = b;
        for (let j = 0; j < d; j++) s += w[j] * z[j];
        const err = 1 / (1 + Math.exp(-s)) - y[i];
        gb += err;
        for (let j = 0; j < d; j++) g[j] += err * z[j];
      }
      for (let j = 0; j < d; j++) {
        const gj = g[j] / n + l2 * w[j];
        mW[j] = b1 * mW[j] + (1 - b1) * gj;
        vW[j] = b2 * vW[j] + (1 - b2) * gj * gj;
        w[j] -= lr * (mW[j] / (1 - b1 ** t)) / (Math.sqrt(vW[j] / (1 - b2 ** t)) + eps);
      }
      gb /= n;
      mB = b1 * mB + (1 - b1) * gb;
      vB = b2 * vB + (1 - b2) * gb * gb;
      b -= lr * (mB / (1 - b1 ** t)) / (Math.sqrt(vB / (1 - b2 ** t)) + eps);
    }
    return { w, b, mean, std, baseRate: pos, n };
  }

  function predict(m, x) {
    let s = m.b;
    for (let j = 0; j < x.length; j++) s += m.w[j] * Math.max(-5, Math.min(5, (x[j] - m.mean[j]) / m.std[j]));
    return 1 / (1 + Math.exp(-s));
  }

  return { buildFeatures, simulate, train, predict, FEATURE_NAMES };
})();

globalThis.Model = Model;
