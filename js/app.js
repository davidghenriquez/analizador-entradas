(() => {
  const $ = id => document.getElementById(id);
  let bars = null, result = null;

  const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '–';
  const num = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : (v === Infinity ? '∞' : '–');
  const signed = (v, d = 2) => Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(d) : '–';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };

  function fmtDate(t) {
    if (!Number.isFinite(t)) return '–';
    const d = new Date(t);
    const day = d.toISOString().slice(0, 10);
    return d.getUTCHours() || d.getUTCMinutes() ? `${day} ${d.toISOString().slice(11, 16)}` : day;
  }
  function priceDigits() {
    const c = bars[bars.length - 1].c;
    return c < 10 ? 5 : c < 1000 ? 3 : 2;
  }

  // ---------- Datos ----------
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab.dataset.tab));
  }));

  function setData(newBars, label) {
    if (newBars.length < 500) throw new Error(`Solo hay ${newBars.length} velas. Hacen falta al menos 500, mejor más de 2000.`);
    bars = newBars;
    result = null;
    currentMarket = null;
    $('results').classList.add('hidden');
    $('signal').classList.add('hidden');
    $('replay').classList.add('hidden');
    $('runBtn').disabled = false;
    info('dataInfo', `${label}: ${bars.length} velas, del ${fmtDate(bars[0].t)} al ${fmtDate(bars[bars.length - 1].t)}.`);
  }

  function info(id, msg, isError) {
    const el = $(id);
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  $('csvFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { setData(Data.parseCSV(await file.text()), file.name); }
    catch (err) { info('dataInfo', err.message, true); }
  });

  $('apiKey').value = store.get('tdKey') || '';
  $('apiLoad').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    if (!key) return info('dataInfo', 'Escribe tu clave API de Twelve Data.', true);
    store.set('tdKey', key);
    info('dataInfo', 'Descargando…');
    try {
      const symbol = $('apiSymbol').value.trim();
      setData(await Data.fetchTwelveData(symbol, $('apiInterval').value, key), `${symbol} ${$('apiInterval').value}`);
    } catch (err) { info('dataInfo', 'Error: ' + err.message, true); }
  });

  const groups = {};
  for (const s of Signals.MARKETS) (groups[s.group] ||= []).push(s);
  $('mkSymbol').innerHTML = Object.entries(groups).map(([g, list]) =>
    `<optgroup label="${g}">${list.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</optgroup>`).join('');

  // ---------- Ventaja según el entrenamiento diario ----------
  // edge[interval][id] = mejor salida con ventaja en el backtest walk-forward, o null si no tiene ninguna
  const edge = {};
  let userPicked = false;

  function bestEdge(market) {
    let best = null;
    for (const [tp, e] of Object.entries(market.exits)) {
      if (e.stats.edge && (!best || e.stats.avgR > best.avgR)) best = { tp: +tp, ...e.stats };
    }
    return best;
  }

  function labelOptions() {
    const iv = $('mkInterval').value, info = edge[iv];
    for (const opt of $('mkSymbol').options) {
      const name = Signals.MARKETS.find(m => m.id === opt.value).name;
      opt.textContent = !info ? name : info[opt.value] ? `${name} · con ventaja` : `${name} · sin ventaja`;
    }
    const withEdge = info ? Object.values(info).filter(Boolean).length : 0;
    $('edgeHint').textContent = info
      ? `En ${$('mkInterval').selectedOptions[0].text.toLowerCase()}, ${withEdge} de ${Signals.MARKETS.length} mercados tienen ventaja según el entrenamiento diario (backtest con datos no vistos). En los marcados "sin ventaja" el modelo no ha encontrado un patrón útil.`
      : '';
  }

  // Al abrir, el mercado con mejor resultado en el backtest de la temporalidad elegida
  function pickBest() {
    const info = edge[$('mkInterval').value];
    if (!info) return;
    const ranked = Object.entries(info).filter(([, e]) => e).sort((a, b) => b[1].avgR - a[1].avgR);
    if (ranked.length) $('mkSymbol').value = ranked[0][0];
  }

  Promise.all(Signals.INTERVALS.map(iv => fetch(`data/modelos/${iv}.json`, { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null).catch(() => null)))
    .then(sets => {
      sets.forEach((set, k) => {
        if (!set) return;
        edge[Signals.INTERVALS[k]] = Object.fromEntries(Object.entries(set.markets).map(([id, m]) => [id, bestEdge(m)]));
      });
      if (!userPicked) { $('mkInterval').value = '1d'; pickBest(); }
      labelOptions();
    });

  $('mkSymbol').addEventListener('change', () => { userPicked = true; });
  $('mkInterval').addEventListener('change', () => { if (!userPicked) pickBest(); labelOptions(); });

  // Aviso cuando el mercado cargado no tiene ventaja o el backtest no sale positivo
  function noEdgeWarning(m) {
    const loaded = currentMarket && edge[currentMarket.iv] ? edge[currentMarket.iv][currentMarket.id] : undefined;
    if (loaded === null) return 'Según el entrenamiento diario, el modelo no encuentra un patrón útil en este mercado y temporalidad: ninguna salida tiene ventaja en datos no vistos. No operes este mercado con él.';
    if (m.n < 30 || !(m.avgR > 0) || !(m.pf >= 1.1)) return 'Con estos datos y parámetros el modelo no encuentra un patrón útil: en datos que no había visto no gana dinero (o hay muy pocas operaciones para saberlo). No operes este mercado con estos ajustes.';
    return '';
  }
  let currentMarket = null;

  let marketIndex = null;
  fetch('data/index.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(idx => {
      marketIndex = idx;
      $('marketHint').textContent = `Velas de ${idx.source}, actualizadas solas cada día laborable. Última actualización: ${fmtDate(Date.parse(idx.updated))} UTC.`;
      $('mkLoad').disabled = false;
    })
    .catch(() => { $('marketHint').textContent = 'No se han encontrado datos de mercado. Usa un CSV o Twelve Data.'; });

  $('mkLoad').addEventListener('click', async () => {
    const s = marketIndex.symbols.find(x => x.id === $('mkSymbol').value);
    const iv = $('mkInterval').value;
    info('dataInfo', 'Cargando…');
    try {
      const res = await fetch(`data/${s.id}_${iv}.csv?u=${encodeURIComponent(marketIndex.updated)}`);
      if (!res.ok) throw new Error(`No hay datos de ${s.name} en ${iv}.`);
      setData(Data.parseCSV(await res.text()), `${s.name} ${$('mkInterval').selectedOptions[0].text}`);
      // Coste y duración máxima propios de este mercado y temporalidad
      const mk = Signals.MARKETS.find(m => m.id === s.id);
      $('pCost').value = mk.cost;
      $('pMax').value = Signals.MAX_BARS[iv];
      currentMarket = { id: s.id, iv };
    } catch (err) { info('dataInfo', err.message, true); }
  });

  $('demoLoad').addEventListener('click', () => setData(Data.synthetic(), 'Ejemplo sintético'));

  // ---------- Backtest ----------
  function params() {
    return {
      sl: +$('pSl').value, tp: +$('pTp').value, maxBars: Math.round(+$('pMax').value),
      cost: +$('pCost').value, trainPct: +$('pTrain').value / 100, folds: Math.round(+$('pFolds').value),
    };
  }

  $('runBtn').addEventListener('click', () => {
    const p = params();
    if (!(p.sl > 0 && p.tp > 0 && p.maxBars >= 2 && p.trainPct >= 0.2 && p.trainPct <= 0.9 && p.folds >= 1)) {
      return info('runStatus', 'Revisa los parámetros.', true);
    }
    $('runBtn').disabled = true;
    info('runStatus', 'Entrenando el modelo y haciendo el backtest…');
    setTimeout(() => {
      try {
        const t0 = performance.now();
        result = Backtest.run(bars, p);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        const skipped = result.skipped.length ? ` Bloques sin datos suficientes para entrenar: ${result.skipped.join(', ')}.` : '';
        info('runStatus', `Listo en ${secs} s.${skipped}`);
        renderAll();
      } catch (err) {
        console.error(err);
        info('runStatus', 'Error: ' + err.message, true);
      }
      $('runBtn').disabled = false;
    }, 30);
  });

  $('thr').addEventListener('input', () => result && renderResults());

  function renderAll() {
    $('results').classList.remove('hidden');
    // Arranca justo por encima del acierto mínimo para no perder
    $('thr').value = Math.min(0.8, Math.ceil((breakEven(result.params) + 0.03) * 100) / 100);
    renderResults();
    renderCalibration();
    renderWeights();
    renderSignal();
  }

  function breakEven(p) { return 1 / (1 + p.tp / p.sl); }

  function renderResults() {
    const thr = +$('thr').value;
    $('thrVal').textContent = Math.round(thr * 100) + '%';
    const p = result.params;
    const trades = Backtest.selectTrades(result, thr);
    const m = Backtest.metrics(trades);
    const base = Backtest.baseline(result);
    const be = breakEven(p);
    $('thrHint').textContent = `Solo entra cuando el modelo da al menos esta probabilidad. Por encima de ${pct(be)} (acierto mínimo para no perder con TP ${p.tp} y SL ${p.sl} ATR) el modelo espera ganar dinero con la entrada.`;

    const cls = (v, ref) => !Number.isFinite(v) ? '' : v > ref ? 'good' : 'bad';
    $('stats').innerHTML = [
      ['Operaciones', m.n, ''],
      ['% de aciertos', pct(m.winRate), cls(m.winRate, be)],
      ['Acierto sin filtro', pct(base.winRate), ''],
      ['Acierto mínimo para no perder', pct(be), ''],
      ['Resultado medio', signed(m.avgR) + ' R', cls(m.avgR, 0)],
      ['Resultado total', signed(m.totalR, 1) + ' R', cls(m.totalR, 0)],
      ['Profit factor', num(m.pf), cls(m.pf, 1)],
      ['Caída máxima', num(m.maxDD, 1) + ' R', ''],
    ].map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');

    let verdict;
    if (m.n < 30) verdict = 'Con menos de 30 operaciones el resultado no es fiable estadísticamente. Baja el umbral o usa más datos.';
    else if (m.avgR > 0 && m.winRate > base.winRate) verdict = `El filtro del modelo mejora el acierto en ${((m.winRate - base.winRate) * 100).toFixed(1)} puntos frente a entrar sin filtro y el resultado medio es positivo en datos no vistos. Confírmalo con otros periodos y otros activos antes de fiarte.`;
    else if (m.winRate > base.winRate) verdict = 'El modelo mejora algo el acierto frente a entrar sin filtro, pero no lo suficiente para cubrir las pérdidas y los costes.';
    else verdict = 'El modelo no mejora a entrar sin filtro: con estos datos y parámetros no ha encontrado un patrón útil.';
    $('verdict').textContent = `1 R = lo que pierdes si salta el stop. ${verdict}`;
    const warn = noEdgeWarning(m);
    for (const id of ['edgeWarn', 'replayWarn']) {
      $(id).textContent = warn;
      $(id).classList.toggle('hidden', !warn);
    }

    drawEquity(m.equity);
    renderThresholdTable(thr, base);
    renderTrades(trades);
    Replay.update(result, bars, thr, trades);
  }

  function renderThresholdTable(current, base) {
    const rows = [];
    const from = Math.max(0.2, Math.floor((breakEven(result.params) - 0.1) * 40) / 40);
    for (let t = from; t <= from + 0.351; t += 0.025) {
      const m = Backtest.metrics(Backtest.selectTrades(result, t));
      const isCur = Math.abs(t - current) < 0.0125;
      rows.push(`<tr class="${isCur ? 'current' : ''}"><td>${Math.round(t * 1000) / 10}%</td><td>${m.n}</td>
        <td>${pct(m.winRate)}</td><td>${signed(m.avgR)}</td><td>${signed(m.totalR, 1)}</td><td>${num(m.pf)}</td></tr>`);
    }
    $('thrTable').innerHTML = `<tr><th>Umbral</th><th>Operaciones</th><th>% aciertos</th><th>R medio</th><th>R total</th><th>Profit factor</th></tr>${rows.join('')}`
      + `<tr><td colspan="6" class="hint" style="text-align:left;white-space:normal">Ojo: elegir el mejor umbral mirando esta tabla es optimizar sobre el periodo de prueba; espera algo peor en real. Acierto sin filtro: ${pct(base.winRate)} en ${base.n} entradas posibles.</td></tr>`;
  }

  function renderCalibration() {
    const rows = Backtest.calibration(result).map(b => `<tr><td>${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))}%</td>
      <td>${b.n}</td><td>${pct(b.sumP / b.n)}</td><td>${pct(b.wins / b.n)}</td></tr>`);
    $('calTable').innerHTML = `<tr><th>Probabilidad del modelo</th><th>Casos</th><th>Media predicha</th><th>Acierto real</th></tr>${rows.join('')}`;
  }

  function renderWeights() {
    if (!result.weights) { $('weightsTable').innerHTML = ''; return; }
    const { long, short } = result.weights;
    const rows = Model.FEATURE_NAMES.map((name, j) => ({ name, l: long[j], s: short[j] }))
      .sort((a, b) => Math.max(Math.abs(b.l), Math.abs(b.s)) - Math.max(Math.abs(a.l), Math.abs(a.s)))
      .map(r => `<tr><td>${r.name}</td><td class="${r.l > 0 ? 'good' : 'bad'}">${signed(r.l)}</td><td class="${r.s > 0 ? 'good' : 'bad'}">${signed(r.s)}</td></tr>`);
    $('weightsTable').innerHTML = `<tr><th>Patrón</th><th>Peso en largos</th><th>Peso en cortos</th></tr>${rows.join('')}`
      + `<tr><td colspan="3" class="hint" style="text-align:left;white-space:normal">Positivo: cuanto mayor es ese valor, más probable el acierto según el modelo. Pesos del modelo entrenado con todo el histórico.</td></tr>`;
  }

  function renderTrades(trades) {
    const d = priceDigits();
    const rows = trades.slice(-30).reverse().map(t => `<tr><td>${fmtDate(bars[t.entryIdx].t)}</td>
      <td>${t.dir > 0 ? 'Largo' : 'Corto'}</td><td>${pct(t.prob)}</td><td>${t.entry.toFixed(d)}</td><td>${t.exit.toFixed(d)}</td>
      <td>${t.reason}</td><td class="${t.r > 0 ? 'good' : 'bad'}">${signed(t.r)}</td></tr>`);
    $('tradesTable').innerHTML = `<tr><th>Entrada</th><th>Dirección</th><th>Prob.</th><th>Precio entrada</th><th>Precio salida</th><th>Salida por</th><th>R</th></tr>${rows.join('') || '<tr><td colspan="7">Sin operaciones con este umbral.</td></tr>'}`;
  }

  function renderSignal() {
    const s = result.current;
    if (!s) { $('signal').classList.add('hidden'); return; }
    $('signal').classList.remove('hidden');
    const p = result.params, d = priceDigits(), last = bars[s.idx];
    const thr = +$('thr').value;
    const side = (name, dir, prob) => {
      const entry = last.c;
      const sl = entry - dir * p.sl * s.atr, tp = entry + dir * p.tp * s.atr;
      const ok = prob >= thr;
      return `<div class="stat"><div class="k">${name}</div><div class="v ${ok ? 'good' : ''}">${pct(prob)}</div>
        <div class="hint">Entrada aprox. ${entry.toFixed(d)} · SL ${sl.toFixed(d)} · TP ${tp.toFixed(d)}<br>${ok ? 'Supera el umbral' : 'No supera el umbral'} (${Math.round(thr * 100)}%)</div></div>`;
    };
    $('signalBody').innerHTML = `<p class="hint">Vela del ${fmtDate(last.t)}, cierre ${last.c.toFixed(d)}. Probabilidad estimada de acierto si se entra en la apertura de la vela siguiente:</p>
      <div class="signal-row">${side('Largo', 1, s.pL)}${side('Corto', -1, s.pS)}</div>
      <p class="hint">Compara esta probabilidad con la tabla de calibración: lo que importa es cuánto acertó el modelo en el pasado cuando dio valores parecidos. Es un cálculo estadístico, no una recomendación.</p>`;
  }

  function drawEquity(eq) {
    const cv = $('equity'), dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 220;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = n => css.getPropertyValue(n).trim();
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    if (eq.length < 2) {
      ctx.fillStyle = col('--muted');
      ctx.fillText('Sin operaciones', 12, 20);
      return;
    }
    const pad = { l: 44, r: 10, t: 12, b: 20 };
    const min = Math.min(0, ...eq), max = Math.max(0, ...eq), span = max - min || 1;
    const x = i => pad.l + (i / (eq.length - 1)) * (w - pad.l - pad.r);
    const y = v => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);

    ctx.strokeStyle = col('--grid'); ctx.fillStyle = col('--muted'); ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = min + (span * k) / 4, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillText(v.toFixed(1), 6, yy + 4);
    }
    ctx.strokeStyle = col('--muted');
    ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(w - pad.r, y(0)); ctx.stroke();
    ctx.fillText(`${eq.length - 1} operaciones`, pad.l, h - 5);

    ctx.strokeStyle = eq[eq.length - 1] >= 0 ? col('--good') : col('--bad');
    ctx.lineWidth = 2;
    ctx.beginPath();
    eq.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.stroke();
  }

  window.addEventListener('resize', () => result && renderResults());
})();
