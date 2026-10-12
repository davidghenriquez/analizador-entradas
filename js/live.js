// Señal en vivo: pide las velas recientes al Worker, aplica el modelo entrenado a diario
// y muestra la probabilidad y la salida recomendada. Se refresca sola al cerrar cada vela.
(() => {
  const WORKER_URL = 'https://analizador-entradas.davidg-henriquez.workers.dev';
  const $ = id => document.getElementById(id);
  const pct = v => (v * 100).toFixed(1) + '%';
  const signed = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  const fmt = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const models = {};
  let timer = null, current = null, lastSeen = null, lastAlerted = null;

  async function loadModels(interval) {
    if (!models[interval]) {
      const res = await fetch(`data/modelos/${interval}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error('Todavía no hay modelos entrenados para esta temporalidad.');
      models[interval] = await res.json();
    }
    return models[interval];
  }

  async function liveBars(id, interval) {
    const res = await fetch(`${WORKER_URL}/velas?s=${id}&i=${interval}&_=${Date.now()}`);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    return json.bars.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  }

  function status(msg, isError) {
    $('liveStatus').textContent = msg;
    $('liveStatus').classList.toggle('error', !!isError);
  }

  async function update() {
    const { id, interval } = current;
    const market = Signals.MARKETS.find(m => m.id === id);
    try {
      const [set, bars] = await Promise.all([loadModels(interval), liveBars(id, interval)]);
      const model = set.markets[id];
      if (!model) throw new Error(`No hay modelo entrenado para ${market.name} ${interval}.`);
      const s = Signals.evaluate(bars, model);
      if (!s) throw new Error('No hay velas suficientes para calcular la señal.');
      const isNew = lastSeen !== null && s.t !== lastSeen;
      lastSeen = s.t;
      render(market, interval, s, set);
      if (s.best && s.t !== lastAlerted && (isNew || lastAlerted === null)) {
        lastAlerted = s.t;
        notify(market, interval, s);
      }
      schedule(interval, s.t);
    } catch (err) {
      status('Error: ' + err.message, true);
      clearTimeout(timer);
      timer = setTimeout(update, 120e3);
    }
  }

  // Siguiente comprobación: 2 minutos después del cierre de la vela en curso. Si se esperaba una vela
  // hace poco y aún no ha llegado, cada minuto; si el mercado está cerrado (fin de semana), al siguiente cierre.
  function schedule(interval, lastT) {
    clearTimeout(timer);
    const ms = Signals.INTERVAL_MS[interval], now = Date.now();
    const expected = lastT + 2 * ms;   // cierre de la vela que sigue a la última cerrada
    let wait, next;
    if (now < expected + 10 * 60e3) {
      next = expected;
      wait = Math.max(60e3, expected + 120e3 - now);
    } else {
      next = expected;
      while (next <= now) next += ms;
      wait = next + 120e3 - now;
    }
    timer = setTimeout(update, Math.min(wait, ms));
    status(`Actualizado a las ${new Date().toLocaleTimeString()}. Próxima comprobación hacia las ${fmt(next)} UTC, se actualiza sola${interval === '1d' ? ' (las velas diarias cierran al terminar la sesión de cada mercado)' : ''}.`);
  }

  function render(market, interval, s, set) {
    const d = Signals.digits(s.close);
    const o = s.best;
    const reco = o
      ? `<div class="reco ${o.dir > 0 ? 'buy' : 'sell'}">
          <div class="title">${o.dir > 0 ? 'Compra' : 'Venta'} · ${pct(o.p)} de probabilidad</div>
          <div class="levels">
            <div><span>Entrada aprox.</span><strong>${o.entry.toFixed(d)}</strong></div>
            <div><span>Stop loss (${Signals.SL} ATR)</span><strong>${o.stop.toFixed(d)}</strong></div>
            <div><span>Take profit (${o.tp} ATR)</span><strong>${o.target.toFixed(d)}</strong></div>
            <div><span>Resultado esperado</span><strong>${signed(o.ev)} R</strong></div>
          </div>
          <p class="hint">Si en ${Signals.MAX_BARS[interval]} velas no toca ni el stop ni el objetivo, se cierra a mercado. En el backtest esta salida tuvo ${o.stats.n} operaciones con un ${pct(o.stats.winRate)} de aciertos y ${signed(o.stats.avgR)} R de media.</p>
        </div>`
      : `<div class="reco"><div class="title">Sin entrada en esta vela</div>
          <p class="hint">Ninguna salida con ventaja en el backtest llega a la probabilidad mínima. La tabla muestra lo que calcula el modelo para cada opción.</p></div>`;

    const rows = s.options.map(x => `<tr class="${x === o ? 'best' : ''}">
      <td>${x.dir > 0 ? 'Compra' : 'Venta'}</td><td>${x.tp} ATR</td>
      <td class="${x.p >= x.minProb ? 'good' : ''}">${pct(x.p)}</td><td>${pct(x.minProb)}</td><td>${signed(x.ev)}</td>
      <td>${x.stop.toFixed(d)}</td><td>${x.target.toFixed(d)}</td>
      <td>${x.stats.n} op · ${pct(x.stats.winRate || 0)} · ${signed(x.stats.avgR || 0)} R</td>
      <td>${x.edge ? '<span class="badge good">Sí</span>' : '<span class="badge">No</span>'}</td></tr>`).join('');

    $('liveBody').innerHTML = `<p class="hint">${market.name} ${interval} · última vela cerrada ${fmt(s.t)} UTC · cierre ${s.close.toFixed(d)} · ATR ${s.atr.toFixed(d)}</p>
      ${reco}
      <div class="table-wrap"><table>
        <tr><th>Dirección</th><th>Take profit</th><th>Probabilidad</th><th>Mínima</th><th>R esperado</th><th>Stop loss</th><th>Objetivo</th><th>Backtest</th><th>Ventaja</th></tr>
        ${rows}
      </table></div>
      <p class="hint">Modelos entrenados el ${fmt(Date.parse(set.updated))} UTC. Cálculo estadístico con datos pasados, no es una recomendación de inversión.</p>`;
  }

  function notify(market, interval, s) {
    if (!$('liveNotify').checked) return;
    const o = s.best, d = Signals.digits(s.close);
    const title = `${o.dir > 0 ? 'Compra' : 'Venta'} ${market.name} ${interval} · ${pct(o.p)}`;
    const body = `Entrada ${o.entry.toFixed(d)} · SL ${o.stop.toFixed(d)} · TP ${o.target.toFixed(d)}`;
    try { if (Notification.permission === 'granted') new Notification(title, { body }); } catch { /* sin notificaciones */ }
    try {
      const ctx = new AudioContext(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880; gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.35);
    } catch { /* sin sonido */ }
  }

  $('liveNotify').addEventListener('change', e => {
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  });

  $('liveBtn').addEventListener('click', () => {
    current = { id: $('mkSymbol').value, interval: $('mkInterval').value };
    lastSeen = null; lastAlerted = null;
    status('Calculando…');
    update();
  });
  $('liveBtn').disabled = false;
})();
