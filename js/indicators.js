// Indicadores técnicos. Todas las series devuelven NaN donde aún no hay datos suficientes.
const Ind = (() => {
  function sma(v, p) {
    const out = new Array(v.length).fill(NaN);
    let sum = 0, valid = 0;
    for (let i = 0; i < v.length; i++) {
      if (Number.isFinite(v[i])) { sum += v[i]; valid++; }
      if (i >= p && Number.isFinite(v[i - p])) { sum -= v[i - p]; valid--; }
      if (i >= p - 1 && valid === p) out[i] = sum / p;
    }
    return out;
  }

  function ema(v, p) {
    const out = new Array(v.length).fill(NaN);
    const k = 2 / (p + 1);
    let prev = NaN;
    for (let i = 0; i < v.length; i++) {
      if (i < p - 1) continue;
      if (i === p - 1) {
        let s = 0;
        for (let j = 0; j < p; j++) s += v[j];
        prev = s / p;
      } else {
        prev = v[i] * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    return out;
  }

  // ATR con suavizado de Wilder
  function atr(bars, p) {
    const out = new Array(bars.length).fill(NaN);
    let prev = NaN, sum = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const tr = i === 0 ? b.h - b.l
        : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
      if (i < p) {
        sum += tr;
        if (i === p - 1) { prev = sum / p; out[i] = prev; }
      } else {
        prev = (prev * (p - 1) + tr) / p;
        out[i] = prev;
      }
    }
    return out;
  }

  // RSI con suavizado de Wilder
  function rsi(c, p) {
    const out = new Array(c.length).fill(NaN);
    let gain = 0, loss = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (i <= p) {
        gain += g; loss += l;
        if (i === p) { gain /= p; loss /= p; }
        else continue;
      } else {
        gain = (gain * (p - 1) + g) / p;
        loss = (loss * (p - 1) + l) / p;
      }
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function rollingMax(v, p) {
    const out = new Array(v.length).fill(NaN);
    for (let i = p - 1; i < v.length; i++) {
      let m = -Infinity;
      for (let j = i - p + 1; j <= i; j++) if (v[j] > m) m = v[j];
      out[i] = m;
    }
    return out;
  }

  function rollingMin(v, p) {
    const out = new Array(v.length).fill(NaN);
    for (let i = p - 1; i < v.length; i++) {
      let m = Infinity;
      for (let j = i - p + 1; j <= i; j++) if (v[j] < m) m = v[j];
      out[i] = m;
    }
    return out;
  }

  return { sma, ema, atr, rsi, rollingMax, rollingMin };
})();
