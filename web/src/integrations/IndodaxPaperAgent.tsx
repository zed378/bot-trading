import { useEffect, useState } from 'react';
import { officeFetch, readOfficeJson } from '../officeApi';
import { useI18n } from '../i18n';

interface PaperPosition { quantity: string; entry: string; stop: string; target: string | null; feeRate: string | null }
interface PaperStats {
  n: number; winRate: number; payoffRR: number | null; profitFactor: number | null; expectancy: number;
  breakEvenWinRate: number | null; kellyRaw: number | null; maxDrawdown: number; recoveryFactor: number | null;
}
interface PaperTrade { side: 'BUY' | 'SELL'; price: string; quantity: string; reason: string; at: number }
interface PaperView {
  mode: 'PAPER'; running: boolean; busy: boolean; symbol: string; quote: string;
  initialCash: string; cash: string; lastPrice: string; lastAction: string; lastCycleAt: number;
  protection: string; position: PaperPosition | null; trades: PaperTrade[]; stats: PaperStats | null;
}

export function IndodaxPaperAgent({ symbol }: { symbol: string }) {
  const { lang } = useI18n();
  const id = lang === 'id';
  const [budget, setBudget] = useState('');
  const [intervalMin, setIntervalMin] = useState('15');
  const [status, setStatus] = useState<PaperView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const activeSymbol = status?.running || status?.position ? status.symbol : symbol;

  useEffect(() => { setBudget(''); }, [symbol]);

  const refresh = async (signal?: AbortSignal) => {
    const response = await officeFetch('/api/indodax/paper-agent', { signal });
    const body = await readOfficeJson<PaperView & { error?: string }>(response, 'loading Indodax paper status');
    if (!response.ok) throw new Error(body.error || 'Paper agent status unavailable.');
    setStatus(body);
  };
  useEffect(() => {
    const controller = new AbortController();
    const load = () => { void refresh(controller.signal).catch(() => {}); };
    load();
    const timer = setInterval(load, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  const action = async (kind: 'start' | 'stop' | 'close') => {
    setBusy(true); setMessage('');
    try {
      const body = kind === 'start' ? { symbol, budget, intervalMin: Number(intervalMin) } : {};
      const response = await officeFetch(`/api/indodax/paper-agent/${kind}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }, 30_000);
      const result = await readOfficeJson<PaperView & { error?: string }>(response, 'sending the Indodax paper command');
      if (!response.ok) throw new Error(result.error || 'Paper agent action failed.');
      setStatus(result);
      setMessage(kind === 'start' ? (id ? 'Simulasi agen dimulai.' : 'Agent simulation started.') :
        kind === 'stop' ? (id ? 'Siklus agen dihentikan.' : 'Agent cycles stopped.') :
          (id ? 'Posisi simulasi ditutup.' : 'Paper position closed.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Paper agent action failed.');
    } finally { setBusy(false); }
  };

  const money = (value: string) => `${Number(value).toLocaleString(id ? 'id-ID' : 'en-US', { maximumFractionDigits: 8 })} ${status?.quote || (activeSymbol.endsWith('IDR') ? 'IDR' : 'USDT')}`;
  return <section className="wallet-panel" aria-labelledby="indodax-paper-agent-title">
    <h3 id="indodax-paper-agent-title">{id ? 'Otomasi agen · PAPER' : 'Agent automation · PAPER'} <span className="badge">PAPER</span></h3>
    <p className="wallet-note">{id
      ? 'Memakai enam agen dan model yang dikonfigurasi di Desk, serta candle/harga publik Indodax 4 jam. Simulasi terpisah dari akun dan order nyata; key Indodax tidak digunakan.'
      : 'Uses the six configured Desk agents and public Indodax 4h prices/candles. This simulation is separate from the account and real orders; the Indodax key is not used.'}</p>
    <p className="wallet-note">{id
      ? 'Fee taker dari metadata pasangan Indodax dikenakan di kedua sisi bila tersedia; pajak dan clearing tidak termasuk. Jeda siklus mempertahankan posisi; pemantau SL/TP berjalan selama backend aktif. Data simulasi hilang saat backend dimulai ulang.'
      : 'The taker fee from the Indodax pair metadata is charged on both legs when published; tax and clearing are not included. Pausing agent cycles retains the position; its simulated SL/TP monitor runs while the backend is up. Paper state is lost when the backend restarts.'}</p>
    <div className="setup-nav">
      <label>{id ? 'Saldo simulasi' : 'Paper balance'} ({symbol.endsWith('IDR') ? 'IDR' : 'USDT'})
        <input value={budget} onChange={e => setBudget(e.target.value)} inputMode="decimal" placeholder={symbol.endsWith('IDR') ? '1000000' : '100'} disabled={busy || Boolean(status?.running) || Boolean(status?.position)} />
      </label>
      <label>{id ? 'Interval siklus (menit)' : 'Cycle interval (minutes)'}
        <input type="number" min="1" max="1440" value={intervalMin} onChange={e => setIntervalMin(e.target.value)} disabled={busy || Boolean(status?.running)} />
      </label>
      {!status?.running
        ? <button type="button" disabled={busy || (status?.position ? activeSymbol !== symbol : !budget.trim() || Number(budget) <= 0)} onClick={() => void action('start')}>{status?.position ? (id ? 'Lanjutkan siklus agen' : 'Resume agent cycles') : (id ? 'Mulai PAPER' : 'Start PAPER')}</button>
        : <button type="button" disabled={busy} onClick={() => void action('stop')}>{id ? 'Hentikan siklus agen' : 'Stop agent cycles'}</button>}
      {status?.position && <button type="button" disabled={busy || status.busy} onClick={() => void action('close')}>{id ? 'Tutup posisi simulasi' : 'Close paper position'}</button>}
    </div>
    {status && <div className="wallet-note" aria-live="polite">
      <p>Status: {status.running ? (status.busy ? (id ? 'Menjalankan siklus agen' : 'Agent cycle running') : (id ? 'Aktif' : 'Running')) : (id ? 'Berhenti' : 'Stopped')} · {id ? 'Kas simulasi' : 'Paper cash'}: {money(status.cash)}</p>
      {status.lastPrice && <p>{id ? 'Harga terakhir' : 'Last price'}: {money(status.lastPrice)}</p>}
      {status.position && <p>{id ? 'Posisi' : 'Position'}: {status.position.quantity} {activeSymbol.replace(status.quote, '')} @ {money(status.position.entry)} · SL {money(status.position.stop)} · TP {status.position.target ? money(status.position.target) : '—'}</p>}
      {status.lastAction && <p>{id ? 'Siklus terakhir' : 'Last cycle'}: {status.lastAction}</p>}
      {status.lastCycleAt > 0 && <p>{new Date(status.lastCycleAt).toLocaleString()}</p>}
    </div>}
    {status?.stats && <p className="wallet-note" aria-label={id ? 'Statistik sesi' : 'Session stats'}>
      {id ? 'Episode tertutup' : 'Closed episodes'}: {status.stats.n} · WR {(status.stats.winRate * 100).toFixed(1)}%
      {status.stats.breakEvenWinRate !== null && ` (${id ? 'impas' : 'break-even'} ${(status.stats.breakEvenWinRate * 100).toFixed(1)}%)`}
      {status.stats.payoffRR !== null && ` · RR ${status.stats.payoffRR.toFixed(2)}`}
      {status.stats.profitFactor !== null && ` · PF ${status.stats.profitFactor.toFixed(2)}`}
      {` · ${id ? 'Ekspektasi' : 'Expectancy'} ${money(String(status.stats.expectancy))}`}
      {` · MDD ${money(String(status.stats.maxDrawdown))}`}
      {status.stats.n < 30 && ` · ${id ? 'sampel kecil, bukan bukti edge' : 'small sample, not evidence of an edge'}`}
    </p>}
    {status?.trades.length ? <ul aria-label={id ? 'Riwayat simulasi' : 'Paper trade history'}>
      {status.trades.slice(0, 8).map((trade, index) => <li key={`${trade.at}-${index}`}>{trade.side} {trade.quantity} @ {money(trade.price)} · {trade.reason}</li>)}
    </ul> : null}
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
