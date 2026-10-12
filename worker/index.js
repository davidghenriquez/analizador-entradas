// Worker del Analizador de Entradas:
//  - GET /velas?s=eurusd&i=1h  → velas cerradas recientes de Yahoo Finance, con CORS, para la web.
//  - Cron cada hora → calcula la señal de cada mercado con la vela recién cerrada y, si alguna
//    supera la probabilidad mínima en una salida con ventaja en el backtest, envía un correo.
import { EmailMessage } from 'cloudflare:email';
import '../js/indicators.js';
import '../js/model.js';
import '../js/signals.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const RANGE = { '1h': ['1h', '1mo'], '4h': ['1h', '3mo'], '1d': ['1d', '1y'] };
const CRON_INTERVAL = { '2 * * * *': '1h', '4 * * * *': '4h', '6 * * * *': '1d' };

async function yahoo(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (analizador-entradas)' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const r = (await res.json()).chart.result?.[0];
  if (!r?.timestamp) throw new Error(`Yahoo ${symbol}: sin datos`);
  const q = r.indicators.quote[0], bars = [];
  r.timestamp.forEach((t, i) => {
    const b = { t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] };
    if ([b.o, b.h, b.l, b.c].every(v => Number.isFinite(v) && v > 0)) bars.push(b);
  });
  return { bars, session: r.meta?.currentTradingPeriod?.regular };
}

async function liveBars(market, interval) {
  const [yi, range] = RANGE[interval];
  let { bars, session } = await yahoo(market.yahoo, yi, range);
  if (interval === '4h') bars = Signals.aggregate(bars, 4);
  if (interval === '1d' && session && bars.length) {
    // Yahoo fecha la vela diaria a la apertura: la de hoy está cerrada si la sesión ya terminó
    const last = bars[bars.length - 1];
    const closed = Date.now() >= session.end * 1000 && last.t >= session.start * 1000 - 3600e3;
    return closed ? bars : Signals.closedBars(bars, interval);
  }
  return Signals.closedBars(bars, interval);
}

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
});

async function handleVelas(url) {
  const market = Signals.MARKETS.find(m => m.id === url.searchParams.get('s'));
  const interval = url.searchParams.get('i');
  if (!market || !RANGE[interval]) return json({ error: 'Mercado o temporalidad no válidos' }, 400);
  const bars = await liveBars(market, interval);
  return json({ id: market.id, interval, bars: bars.map(b => [b.t, b.o, b.h, b.l, b.c]) }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// ---------- Avisos por correo ----------
function describe(market, interval, s) {
  const o = s.best, d = Signals.digits(s.close);
  const side = o.dir > 0 ? 'COMPRA' : 'VENTA';
  const fecha = new Date(s.t).toISOString().slice(0, 16).replace('T', ' ');
  return {
    subject: `${side} ${market.name} ${interval} · ${(o.p * 100).toFixed(0)}%`,
    text: [
      `${side} ${market.name} (${interval}) · vela cerrada ${fecha} UTC`,
      `Probabilidad de acierto: ${(o.p * 100).toFixed(1)}% (mínimo para esta salida: ${(o.minProb * 100).toFixed(1)}%)`,
      `Resultado esperado: ${o.ev >= 0 ? '+' : ''}${o.ev.toFixed(2)} R`,
      `Entrada aprox.: ${o.entry.toFixed(d)} (apertura de la vela siguiente)`,
      `Stop loss: ${o.stop.toFixed(d)} (${Signals.SL} ATR)`,
      `Take profit: ${o.target.toFixed(d)} (${o.tp} ATR)`,
      `Cierre por tiempo: ${Signals.MAX_BARS[interval]} velas si no toca ni SL ni TP`,
      `Backtest de esta salida: ${o.stats.n} operaciones, ${(o.stats.winRate * 100).toFixed(1)}% de aciertos, ${o.stats.avgR >= 0 ? '+' : ''}${o.stats.avgR} R de media`,
    ].join('\n'),
  };
}

function encodeHeader(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

async function sendMail(env, subject, text) {
  const raw = [
    `From: ${encodeHeader('Analizador de Entradas')} <${env.REMITENTE}>`,
    `To: <${env.DESTINO}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${env.REMITENTE.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  ].join('\r\n');
  await env.CORREO.send(new EmailMessage(env.REMITENTE, env.DESTINO, raw));
}

async function checkInterval(env, interval) {
  const res = await fetch(`${env.MODELOS_URL}${interval}.json`, { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error(`Modelos ${interval}: HTTP ${res.status}`);
  const models = await res.json();
  const alerts = [], errors = [];

  await Promise.all(Signals.MARKETS.map(async market => {
    const model = models.markets[market.id];
    if (!model) return;
    try {
      const bars = await liveBars(market, interval);
      if (bars.length < 80) return;
      const key = `ultima:${market.id}:${interval}`;
      const lastT = String(bars[bars.length - 1].t);
      if (await env.ALERTAS.get(key) === lastT) return;   // esta vela ya se revisó
      await env.ALERTAS.put(key, lastT, { expirationTtl: 30 * 86400 });
      const s = Signals.evaluate(bars, model);
      if (s?.best) alerts.push(describe(market, interval, s));
    } catch (err) { errors.push(`${market.id}: ${err.message}`); }
  }));

  if (errors.length) console.log(`Errores ${interval}: ${errors.join('; ')}`);
  if (!alerts.length) return 0;
  const subject = alerts.length === 1 ? alerts[0].subject : `${alerts.length} señales ${interval}: ${alerts.map(a => a.subject.split(' · ')[0]).join(', ')}`;
  const body = alerts.map(a => a.text).join('\n\n----------\n\n')
    + `\n\n${env.WEB_URL}\nCálculo estadístico con datos pasados, no es una recomendación de inversión.`;
  await sendMail(env, subject, body);
  return alerts.length;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/velas') return await handleVelas(url);
      if (url.pathname === '/probar-correo' && env.CLAVE_ADMIN && url.searchParams.get('clave') === env.CLAVE_ADMIN) {
        await sendMail(env, 'Prueba del Analizador de Entradas', `Los avisos por correo funcionan.\n\n${env.WEB_URL}`);
        return json({ ok: true });
      }
      return json({ servicio: 'Analizador de Entradas', rutas: ['/velas?s=eurusd&i=1h'] });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    const interval = CRON_INTERVAL[event.cron];
    if (!interval) return;
    // Las velas de 4 h cierran a las 00, 04, 08… UTC
    if (interval === '4h' && new Date(event.scheduledTime).getUTCHours() % 4 !== 0) return;
    const n = await checkInterval(env, interval);
    console.log(`${interval}: ${n} señales enviadas`);
  },
};
