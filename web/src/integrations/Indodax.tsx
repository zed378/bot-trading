import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import type { IndodaxAnalysis, IndodaxPair, IndodaxTimeframe } from '../../../shared/indodax';
import { useI18n } from '../i18n';
import { officeFetch } from '../officeApi';
import { IndodaxStops } from './IndodaxStops';
import { IndodaxCredentials } from './IndodaxCredentials';

function SpotChart({ data }: { data: IndodaxAnalysis }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const tokens = getComputedStyle(document.documentElement);
    const chart = createChart(container.current, {
      autoSize: true, height: 240,
      layout: { background: { color: 'transparent' }, textColor: tokens.getPropertyValue('--chart-text').trim() || '#555555', attributionLogo: true },
      timeScale: { timeVisible: true },
      localization: { priceFormatter: (value: number) => `${value.toLocaleString('id-ID', { maximumFractionDigits: 8 })} ${data.pair.quote}` }
    });
    const candles = chart.addSeries(CandlestickSeries);
    candles.setData(data.candles.map(c => ({ time: c.time as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);
  return <div ref={container} style={{ height: 240, minWidth: 0 }} aria-label={`${data.pair.symbol} ${data.timeframe} closed candles`} />;
}

export function Indodax() {
  const { lang } = useI18n();
  const id = lang === 'id';
  const [pairs, setPairs] = useState<IndodaxPair[]>([]);
  const [symbol, setSymbol] = useState('BTCIDR');
  const [tf, setTf] = useState<IndodaxTimeframe>('4h');
  const [data, setData] = useState<IndodaxAnalysis | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPairs([]);
    void officeFetch('/api/indodax/pairs', { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || 'Indodax pairs unavailable.');
      if (controller.signal.aborted) return;
      const available: IndodaxPair[] = body.pairs.filter((p: IndodaxPair) => !p.maintenance && !p.suspended);
      if (!available.length) throw new Error('No available Indodax pairs.');
      setSymbol(previous => available.some(p => p.symbol === previous) ? previous : available[0].symbol);
      setPairs(available);
    }).catch(e => { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Indodax unavailable.'); setBusy(false); } });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!pairs.length) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setData(null);
    void officeFetch(`/api/indodax/market?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { signal: controller.signal }, 25_000).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || 'Indodax data unavailable.');
      if (!controller.signal.aborted) setData(body.data);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Indodax unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [pairs, symbol, tf]);

  const price = (value: string | number | null) => value === null ? '—' : `${Number(value).toLocaleString(lang === 'id' ? 'id-ID' : 'en-US', { maximumFractionDigits: 8 })} ${data?.pair.quote ?? ''}`;
  return <section className="panel integration-panel" aria-labelledby="indodax-title">
    <div className="panel-head"><h2 id="indodax-title">Indodax · Spot</h2><span className="badge">{id ? 'Analisis publik' : 'Public analysis'}</span></div>
    <p className="wallet-note">{id ? 'Data Indodax tanpa API key. Harga memakai mata uang pasangan, terpisah dari saldo dan order desk USDT.' : 'Indodax data without API keys. Prices use the pair quote currency, separate from the USDT desk balance and orders.'}</p>
    <p className="wallet-note">{id ? 'Order entry Indodax dari desk utama belum tersedia. Bagian SL di bawah dapat melindungi aset yang didaftarkan melalui pemantau tersendiri.' : 'Main desk Indodax entries are not available. The SL section below can protect adopted holdings through a separate monitor.'}</p>
    <div className="setup-nav">
      <label>{id ? 'Pasangan' : 'Pair'} <select aria-label="Indodax pair" value={symbol} onChange={e => setSymbol(e.target.value)} disabled={!pairs.length || busy}>
        {!pairs.some(p => p.symbol === symbol) && <option value={symbol}>{symbol}</option>}
        {pairs.map(p => <option key={p.symbol} value={p.symbol}>{p.asset}/{p.quote}</option>)}
      </select></label>
      <label>Timeframe <select aria-label="Indodax timeframe" value={tf} onChange={e => setTf(e.target.value as IndodaxTimeframe)} disabled={busy}><option value="4h">4h</option><option value="1d">1d</option></select></label>
      <button type="button" disabled={busy} onClick={() => { setBusy(true); setData(null); setError(''); setRetry(n => n + 1); }}>{id ? 'Muat ulang' : 'Refresh'}</button>
    </div>
    {busy && <p role="status">{id ? 'Mengambil data Indodax…' : 'Loading Indodax data…'}</p>}
    {error && <p role="alert">{error}</p>}
    {data && <>
      <p><b>{data.pair.asset}/{data.pair.quote}</b> · {price(data.last)}</p>
      <p className="wallet-note">Bid {price(data.bid)} · Ask {price(data.ask)}</p>
      <SpotChart data={data} />
      <dl>
        <dt>{id ? 'Tren candle tertutup' : 'Closed candle trend'} ({data.timeframe})</dt><dd>{data.indicators.trend}</dd>
        <dt>EMA 20</dt><dd>{price(data.indicators.ema20)}</dd>
        <dt>EMA 50</dt><dd>{price(data.indicators.ema50)}</dd>
        <dt>RSI 14</dt><dd>{data.indicators.rsi14.toFixed(2)}</dd>
        <dt>{id ? 'Minimum nilai order (metadata)' : 'Minimum order value (metadata)'}</dt><dd>{price(data.pair.minQuote)}</dd>
      </dl>
      <p className="wallet-note">{id ? 'Observasi' : 'Observed'}: {new Date(data.observedAt).toLocaleString()} · {data.candles.length} {id ? 'candle tertutup' : 'closed candles'}. {id ? 'Indikator dihitung dari candle Indodax; bukan instruksi order.' : 'Indicators are calculated from Indodax candles; they are not order instructions.'}</p>
      <p className="wallet-note">{id ? 'Sumber' : 'Sources'}: <a href={data.sources.ticker} target="_blank" rel="noreferrer">Trade API 2.0</a> · <a href={data.sources.candles} target="_blank" rel="noreferrer">history_v2</a></p>
    </>}
    <IndodaxCredentials />
    <IndodaxStops symbol={symbol} />
  </section>;
}
