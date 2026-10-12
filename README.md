# Analizador de Entradas

Web estática (HTML + JavaScript, sin servidor ni dependencias) para analizar entradas de trading en Forex e índices:

1. **Aprende patrones** de las velas: retornos recientes, RSI, distancia a las EMA 20/50, volatilidad (ATR), forma de la vela y posición dentro del rango de 20 velas.
2. **Calcula la probabilidad** de que una entrada larga o corta, con stop y objetivo en múltiplos del ATR, termine en ganancia. Usa una regresión logística, con un modelo para largos y otro para cortos.
3. **Lo comprueba con backtesting walk-forward**: el modelo se entrena solo con el pasado y se evalúa en bloques que nunca ha visto, reentrenándose bloque a bloque. Muestra el **% de aciertos**, el resultado en R, el profit factor y la caída máxima, siempre comparados con entrar sin filtro y con el acierto mínimo para no perder.

## Uso

Abre `index.html` en el navegador o la versión publicada en GitHub Pages.

### Datos

- **CSV**: exportado de MetaTrader 4/5 (Centro de históricos, Exportar), de TradingView (Exportar datos del gráfico) o cualquier archivo con columnas fecha, apertura, máximo, mínimo y cierre. Acepta separadores `,` `;` o tabulador y cabeceras en inglés o español.
- **Twelve Data**: descarga directa con una clave API gratuita (máximo 5000 velas). La clave se guarda solo en tu navegador.
- **Ejemplo**: serie sintética para probar la herramienta.

### Cómo evita engañarse

- Cada decisión se toma al cierre de una vela y la entrada se ejecuta en la apertura de la siguiente.
- Para entrenar solo se usan operaciones que ya habían terminado antes del bloque de prueba.
- Si en la misma vela se tocan el SL y el TP, se cuenta como pérdida. Los gaps se ejecutan al precio de apertura.
- El coste (spread más comisión) se descuenta en cada entrada.
- Solo hay una operación abierta a la vez.
- La tabla de calibración comprueba si las probabilidades que da el modelo se cumplen en la realidad.

## Aviso

Herramienta educativa. No es asesoramiento financiero. Un backtest positivo no garantiza resultados futuros.
