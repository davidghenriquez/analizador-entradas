// Repaso vela a vela del periodo de prueba del backtest: el gráfico solo enseña hasta la vela actual,
// el modelo (entrenado solo con el pasado) decide si entra y el resultado se descubre al avanzar.
const Replay = (() => {
  const $ = id => document.getElementById(id);
  const pct = v => (v * 100).toFixed(1) + '%';
  const signed = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  const WINDOW = 150;

  let res = null, bars = null, thr = 0.5, trades = [], bySignal = new Map();
  let cursor = 0, chart = null, series = null, lines = [], playTimer = null, digits = 5;

  const timeOf = (i) => Number.isFinite(bars[i].t) ? Math.floor(bars[i].t / 1000) : i * 3600;
  const fmt = i => Number.isFinite(bars[i].t) ? new Date(bars[i].t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : `vela ${i}`;
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function levels(t) {
    const a = res.prep.feats.atr[t.signalIdx], p = res.params;
    return { stop: t.entry - t.dir * p.sl * a, target: t.entry + t.dir * p.tp * a };
  }

  function ensureChart() {
    if (chart || typeof LightweightCharts === 'undefined') return;
    chart = LightweightCharts.createChart($('replayChart'), {
      autoSize: true,
      layout: { background: { color: cssVar('--card') }, textColor: cssVar('--muted') },
      grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderColor: cssVar('--border') },
      timeScale: { borderColor: cssVar('--border'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    series = chart.addCandlestickSeries({
      upColor: '#16a34a', downColor: '#dc2626', borderVisible: false, wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
  }

  // Qué pasa en la vela i: una operación que se cierra, una señal nueva o una operación abierta.
  // Una operación puede cerrarse en la misma vela en que aparece la señal siguiente.
  function stateAt(i) {
    let closing = null, signal = null, open = null;
    for (const t of trades) {
      if (t.signalIdx > i) break;
      if (t.exitIdx === i) closing = t;
      if (t.signalIdx === i) signal = t;
      else if (i < t.exitIdx) open = t;
    }
    return { closing, signal, open, active: signal || open };
  }

  function draw() {
    const i = cursor;
    ensureChart();
    if (series) {
      const from = Math.max(0, i - WINDOW);
      series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits } });
      series.setData(bars.slice(from, i + 1).map((b, k) => ({ time: timeOf(from + k), open: b.o, high: b.h, low: b.l, close: b.c })));

      // Marcas: entradas ya ejecutadas y salidas ya ocurridas (nunca el futuro)
      const markers = [];
      for (const t of trades) {
        if (t.signalIdx > i) break;
        if (t.entryIdx >= from && t.entryIdx <= i) markers.push({
          time: timeOf(t.entryIdx), position: t.dir > 0 ? 'belowBar' : 'aboveBar', shape: t.dir > 0 ? 'arrowUp' : 'arrowDown',
          color: '#2563eb', text: t.dir > 0 ? 'Compra' : 'Venta',
        });
        if (t.exitIdx >= from && t.exitIdx <= i) markers.push({
          time: timeOf(t.exitIdx), position: t.dir > 0 ? 'aboveBar' : 'belowBar', shape: 'circle',
          color: t.r > 0 ? '#16a34a' : '#dc2626', text: `${signed(t.r)}R`,
        });
      }
      markers.sort((a, b) => a.time - b.time);
      series.setMarkers(markers);

      lines.forEach(l => series.removePriceLine(l));
      lines = [];
      const t = stateAt(i).active;
      if (t) {
        const lv = levels(t);
        const add = (price, color, title) => lines.push(series.createPriceLine({ price, color, lineWidth: 2, axisLabelVisible: true, title }));
        add(t.entry, '#2563eb', 'Entrada'); add(lv.stop, '#dc2626', 'SL'); add(lv.target, '#16a34a', 'TP');
      }
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i - from - 100), to: i - from + 6 });
    }
    panel();
  }

  function panel() {
    const i = cursor, d = digits;
    const pL = res.probL[i], pS = res.probS[i];
    const { closing, signal, open } = stateAt(i);
    let decision = '';

    if (closing) {
      const t = closing;
      const why = { TP: 'Tocó el take profit', SL: 'Saltó el stop loss', Tiempo: `Cerrada por tiempo (${res.params.maxBars} velas)` }[t.reason];
      decision += `<div class="reco ${t.r > 0 ? 'buy' : 'sell'}"><div class="title">Resultado: ${t.r > 0 ? 'acierto' : 'fallo'} · ${signed(t.r)} R</div>
        <p class="hint">${why}. Entrada ${t.entry.toFixed(d)}, salida ${t.exit.toFixed(d)}, ${t.exitIdx - t.entryIdx + 1} velas.</p></div>`;
    }
    if (signal) {
      const t = signal;
      const lv = levels(t);
      decision += `<div class="reco ${t.dir > 0 ? 'buy' : 'sell'}"><div class="title">Entra: ${t.dir > 0 ? 'Compra' : 'Venta'} · ${pct(t.prob)}</div>
        <div class="levels">
          <div><span>Entrada (apertura siguiente)</span><strong>${t.entry.toFixed(d)}</strong></div>
          <div><span>Stop loss</span><strong>${lv.stop.toFixed(d)}</strong></div>
          <div><span>Take profit</span><strong>${lv.target.toFixed(d)}</strong></div>
        </div>
        <p class="hint">El resultado está oculto: avanza vela a vela o pulsa "Ver resultado".</p></div>`;
    } else if (open) {
      const t = open, lv = levels(t);
      decision += `<div class="reco"><div class="title">Operación abierta: ${t.dir > 0 ? 'Compra' : 'Venta'} desde ${t.entry.toFixed(d)}</div>
        <p class="hint">Stop loss ${lv.stop.toFixed(d)} · Take profit ${lv.target.toFixed(d)} · lleva ${i - t.entryIdx + 1} de ${res.params.maxBars} velas. No se abren operaciones nuevas mientras tanto.</p></div>`;
    } else if (closing) {
      // ya se ha mostrado el resultado; no hay señal nueva en esta vela
    } else if (!Number.isFinite(pL)) {
      decision += `<div class="reco"><div class="title">Sin predicción en esta vela</div></div>`;
    } else {
      decision += `<div class="reco"><div class="title">No entra</div>
        <p class="hint">Ninguna probabilidad llega al umbral de ${pct(thr)}.</p></div>`;
    }

    // Marcador: solo operaciones ya cerradas hasta esta vela
    let n = 0, wins = 0, sumR = 0;
    for (const x of trades) { if (x.exitIdx > i) break; n++; sumR += x.r; if (x.r > 0) wins++; }

    $('replayPanel').innerHTML = `<p class="hint">${fmt(i)} · cierre ${bars[i].c.toFixed(d)} · probabilidad compra <strong>${Number.isFinite(pL) ? pct(pL) : '–'}</strong>, venta <strong>${Number.isFinite(pS) ? pct(pS) : '–'}</strong> · umbral ${pct(thr)}</p>
      ${decision}
      <div class="stats">
        <div class="stat"><div class="k">Operaciones cerradas</div><div class="v">${n}</div></div>
        <div class="stat"><div class="k">% de aciertos</div><div class="v">${n ? pct(wins / n) : '–'}</div></div>
        <div class="stat"><div class="k">Resultado acumulado</div><div class="v ${sumR >= 0 ? 'good' : 'bad'}">${signed(sumR)} R</div></div>
        <div class="stat"><div class="k">Progreso</div><div class="v">${Math.round((i - res.startTest) / Math.max(1, res.n - 1 - res.startTest) * 100)}%</div></div>
      </div>`;
    $('replayResult').disabled = !(signal || open);
  }

  function go(i) { cursor = Math.max(res.startTest, Math.min(res.n - 1, i)); draw(); }

  function nextEntry() {
    const t = trades.find(x => x.signalIdx > cursor);
    if (t) go(t.signalIdx);
  }

  function stop() { clearInterval(playTimer); playTimer = null; $('replayPlay').textContent = 'Reproducir'; }

  function play() {
    if (playTimer) return stop();
    $('replayPlay').textContent = 'Pausa';
    playTimer = setInterval(() => {
      if (cursor >= res.n - 1) return stop();
      go(cursor + 1);
      const st = stateAt(cursor);
      if (st.signal || st.closing) stop();   // se para en cada entrada y en cada resultado
    }, +$('replaySpeed').value);
  }

  function bind() {
    $('replayStart').onclick = () => { stop(); go(res.startTest); };
    $('replayPrev').onclick = () => { stop(); go(cursor - 1); };
    $('replayNext').onclick = () => { stop(); go(cursor + 1); };
    $('replayNextEntry').onclick = () => { stop(); nextEntry(); };
    $('replayResult').onclick = () => { stop(); const t = stateAt(cursor).active; if (t) go(t.exitIdx); };
    $('replayPlay').onclick = play;
  }

  // Se llama tras cada backtest y al mover el umbral
  function update(result, allBars, threshold, selected) {
    const fresh = res !== result;
    res = result; bars = allBars; thr = threshold; trades = selected;
    digits = Signals.digits(bars[bars.length - 1].c);
    $('replay').classList.remove('hidden');
    if (fresh) { stop(); bind(); cursor = res.startTest; }
    draw();
  }

  return { update };
})();
