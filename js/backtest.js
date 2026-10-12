// Backtesting walk-forward: el modelo se reentrena por bloques usando solo el pasado
// y se evalúa sobre el bloque siguiente, que nunca ha visto.
const Backtest = (() => {
  const MIN_TRAIN = 150;

  function prepare(bars, p) {
    const feats = Model.buildFeatures(bars);
    const outL = new Array(bars.length).fill(null), outS = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      if (!feats.X[i]) continue;
      outL[i] = Model.simulate(bars, i, 1, feats.atr[i], p);
      outS[i] = Model.simulate(bars, i, -1, feats.atr[i], p);
    }
    return { feats, outL, outS };
  }

  // Muestras de entrenamiento cuya operación terminó antes de `limit` (sin fuga de información).
  function trainingSet(prep, limit) {
    const X = [], yL = [], yS = [];
    for (let i = 0; i < limit; i++) {
      const x = prep.feats.X[i], l = prep.outL[i], s = prep.outS[i];
      if (!x || !l || !s || l.exitIdx >= limit || s.exitIdx >= limit) continue;
      X.push(x); yL.push(l.r > 0 ? 1 : 0); yS.push(s.r > 0 ? 1 : 0);
    }
    return { X, yL, yS };
  }

  function run(bars, p, onProgress) {
    const prep = prepare(bars, p);
    const n = bars.length;
    const startTest = Math.floor(n * p.trainPct);
    const chunk = Math.ceil((n - startTest) / p.folds);
    const probL = new Array(n).fill(NaN), probS = new Array(n).fill(NaN);
    const skipped = [];

    for (let f = 0; f < p.folds; f++) {
      const s = startTest + f * chunk, end = Math.min(n, s + chunk);
      if (s >= end) break;
      const ts = trainingSet(prep, s);
      if (ts.X.length < MIN_TRAIN) { skipped.push(f + 1); continue; }
      const mL = Model.train(ts.X, ts.yL), mS = Model.train(ts.X, ts.yS);
      for (let i = s; i < end; i++) {
        const x = prep.feats.X[i];
        if (!x) continue;
        probL[i] = Model.predict(mL, x);
        probS[i] = Model.predict(mS, x);
      }
      onProgress && onProgress((f + 1) / p.folds);
    }

    // Modelo final con todos los datos resueltos, para la señal de la última vela
    const all = trainingSet(prep, n);
    let current = null, weights = null, models = null;
    if (all.X.length >= MIN_TRAIN) {
      const mL = Model.train(all.X, all.yL), mS = Model.train(all.X, all.yS);
      const last = n - 1;
      const x = prep.feats.X[last];
      if (x) current = { idx: last, pL: Model.predict(mL, x), pS: Model.predict(mS, x), atr: prep.feats.atr[last] };
      weights = { long: mL.w, short: mS.w };
      models = { long: mL, short: mS };
    }

    return { prep, probL, probS, startTest, skipped, current, weights, models, params: p, n };
  }

  // Selecciona operaciones sin solaparse: solo una abierta a la vez.
  function selectTrades(res, thr) {
    const { prep, probL, probS, startTest, n } = res;
    const trades = [];
    let busyUntil = -1;
    for (let i = startTest; i < n; i++) {
      if (i < busyUntil || !Number.isFinite(probL[i])) continue;
      const long = probL[i] >= probS[i];
      const prob = long ? probL[i] : probS[i];
      const out = long ? prep.outL[i] : prep.outS[i];
      if (prob < thr || !out) continue;
      trades.push({ ...out, signalIdx: i, prob });
      busyUntil = out.exitIdx;
    }
    return trades;
  }

  function metrics(trades) {
    let wins = 0, sumR = 0, gross = 0, loss = 0, eq = 0, peak = 0, maxDD = 0;
    const equity = [0];
    for (const t of trades) {
      if (t.r > 0) { wins++; gross += t.r; } else loss -= t.r;
      sumR += t.r;
      eq += t.r; equity.push(eq);
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, peak - eq);
    }
    const n = trades.length;
    return {
      n, wins, winRate: n ? wins / n : NaN, avgR: n ? sumR / n : NaN, totalR: sumR,
      pf: loss > 0 ? gross / loss : (gross > 0 ? Infinity : NaN), maxDD, equity,
    };
  }

  // Referencia: todas las entradas posibles (largas y cortas) del periodo de prueba, sin filtro.
  function baseline(res) {
    let n = 0, wins = 0, sumR = 0;
    for (let i = res.startTest; i < res.n; i++) {
      if (!Number.isFinite(res.probL[i])) continue;
      for (const o of [res.prep.outL[i], res.prep.outS[i]]) {
        if (!o) continue;
        n++; sumR += o.r; if (o.r > 0) wins++;
      }
    }
    return { n, winRate: n ? wins / n : NaN, avgR: n ? sumR / n : NaN };
  }

  // Calibración: probabilidad predicha frente a acierto real, por tramos.
  function calibration(res) {
    const edges = [0, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 1.01];
    const buckets = edges.slice(0, -1).map((lo, k) => ({ lo, hi: edges[k + 1], n: 0, wins: 0, sumP: 0 }));
    for (let i = res.startTest; i < res.n; i++) {
      if (!Number.isFinite(res.probL[i])) continue;
      for (const [p, o] of [[res.probL[i], res.prep.outL[i]], [res.probS[i], res.prep.outS[i]]]) {
        if (!o) continue;
        const b = buckets.find(b => p >= b.lo && p < b.hi);
        b.n++; b.sumP += p; if (o.r > 0) b.wins++;
      }
    }
    return buckets.filter(b => b.n > 0);
  }

  // AUC: probabilidad de que una entrada ganadora tenga más probabilidad predicha que una perdedora.
  // 0,5 = el modelo no distingue nada; por debajo de 0,5 ordena al revés.
  function auc(res) {
    const pts = [];
    for (let i = res.startTest; i < res.n; i++) {
      if (!Number.isFinite(res.probL[i])) continue;
      if (res.prep.outL[i]) pts.push([res.probL[i], res.prep.outL[i].r > 0]);
      if (res.prep.outS[i]) pts.push([res.probS[i], res.prep.outS[i].r > 0]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    let rankSum = 0, pos = 0;
    for (let k = 0; k < pts.length;) {
      let j = k;
      while (j < pts.length && pts[j][0] === pts[k][0]) j++;
      const rank = (k + j + 1) / 2;   // rango medio para empates
      for (let q = k; q < j; q++) if (pts[q][1]) { rankSum += rank; pos++; }
      k = j;
    }
    const neg = pts.length - pos;
    return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : NaN;
  }

  // Resultado por tramos consecutivos del periodo de prueba, para ver si la ventaja es estable
  function blocks(res, trades, count = 4) {
    const size = (res.n - res.startTest) / count;
    const out = Array.from({ length: count }, () => ({ n: 0, totalR: 0 }));
    for (const t of trades) {
      const b = Math.min(count - 1, Math.floor((t.entryIdx - res.startTest) / size));
      out[b].n++; out[b].totalR += t.r;
    }
    return out;
  }

  // Criterio de ventaja: gana dinero, mejora a entrar sin filtro, sus probabilidades ordenan bien
  // y el resultado es positivo en la mayoría de tramos. Devuelve también los motivos si no la tiene.
  function edgeCheck(res, trades) {
    const m = metrics(trades), base = baseline(res), a = auc(res), bl = blocks(res, trades);
    const positive = bl.filter(b => b.totalR > 0).length;
    const lift = m.winRate - base.winRate;
    const fails = [];
    if (!(m.n >= 50)) fails.push(`pocas operaciones (${m.n})`);
    if (!(m.avgR >= 0.05 && m.pf >= 1.15)) fails.push('no gana lo suficiente');
    if (!(lift >= 0.02)) fails.push('no mejora a entrar sin filtro');
    if (!(a >= 0.52)) fails.push('sus probabilidades no ordenan bien');
    if (positive < 3) fails.push(`solo ${positive} de 4 tramos positivos`);
    return { edge: fails.length === 0, fails, m, base, auc: a, lift, blocks: bl, positiveBlocks: positive };
  }

  return { run, selectTrades, metrics, baseline, calibration, auc, blocks, edgeCheck };
})();

globalThis.Backtest = Backtest;
