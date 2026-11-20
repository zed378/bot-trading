import { useEffect, useState } from 'react';
import { officeFetch } from '../officeApi';
import { useI18n } from '../i18n';

interface StopView {
  symbol: string; quantity: string; entry: string; stop: string; quote: string; mode: 'PAPER' | 'LIVE';
  status: string; lastError: string | null; workerHeartbeatAt: number | null;
}
interface Status { worker: { mode: string; state: string } | null; lastError: string | null; stops: StopView[] }
const CONFIRM = 'I understand LIVE trades real money';

export function IndodaxStops({ symbol }: { symbol: string }) {
  const { lang } = useI18n();
  const id = lang === 'id';
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<'PAPER' | 'LIVE'>('PAPER');
  const [quantity, setQuantity] = useState('');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setQuantity(''); setEntry(''); setStop(''); setMessage(''); }, [symbol]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await officeFetch('/api/indodax/stops', { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || 'SL status unavailable.');
        if (!controller.signal.aborted) setStatus(body);
      } catch (error) {
        if (!controller.signal.aborted) { setStatus(null); setMessage(error instanceof Error ? error.message : 'SL status unavailable.'); }
      } finally { if (!controller.signal.aborted) timer = setTimeout(load, 5000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [retry]);
  const send = async (action: string, body: Record<string, unknown>) => {
    setBusy(true); setMessage('');
    try {
      const response = await officeFetch(`/api/indodax/stops/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 30_000);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'SL request failed.');
      setMessage(result.note || 'OK'); setRetry(n => n + 1);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'SL request failed.'); }
    finally { setBusy(false); }
  };
  const liveReady = mode === 'PAPER' || confirmation === CONFIRM;
  return <section aria-labelledby="indodax-sl-title">
    <h3 id="indodax-sl-title">{id ? 'SL di database · dijalankan bot' : 'Database SL · bot managed'}</h3>
    <p className="wallet-note">{id ? 'Daftarkan jumlah aset spot yang sudah dimiliki. Pemantau hanya menjual jumlah yang didaftarkan saat harga terakhir ≤ SL. Harga entry adalah referensi Anda; formulir ini tidak membeli aset.' : 'Adopt an existing spot holding. The monitor only sells the adopted quantity when last price ≤ SL. Entry is your cost reference; this form does not buy assets.'}</p>
    <p role="status"><b>{status?.worker ? `${status.worker.mode} · ${status.worker.state}` : id ? 'Pemantau Office tidak aktif' : 'Office monitor is not running'}</b></p>
    {status?.lastError && <p role="alert">{status.lastError}</p>}
    <label htmlFor="indodax-sl-mode">{id ? 'Mode pemantau SL (terpisah dari desk utama)' : 'SL monitor mode (separate from the main desk)'}</label>
    <select id="indodax-sl-mode" value={mode} disabled={busy} onChange={e => { setMode(e.target.value as 'PAPER' | 'LIVE'); setConfirmation(''); }}><option value="PAPER">PAPER</option><option value="LIVE">LIVE</option></select>
    <p className="wallet-note">{id ? 'SL tersimpan bukan order exchange. Jika bot, komputer, internet, atau API berhenti, SL tidak dapat dieksekusi. Kill juga menjeda pemantau. Harga jual dapat melewati SL.' : 'A stored SL is not an exchange order. Bot, computer, internet or API outages prevent execution. Kill also pauses the monitor. Sale price may be worse than SL.'}</p>
    {mode === 'LIVE' && <>
      <p role="alert"><b>{id ? 'LIVE menjual aset riil secara otomatis dan dapat merugikan Anda. Ini bukan nasihat keuangan. Key harus Read + Trade; penarikan crypto dan fiat harus nonaktif.' : 'LIVE automatically sells real assets and can lose money. This is not financial advice. Keys must have Read + Trade with crypto and fiat withdrawals disabled.'}</b></p>
      <label htmlFor="indodax-sl-confirm">{id ? 'Ketik sendiri' : 'Type yourself'}: <code>{CONFIRM}</code></label>
      <input id="indodax-sl-confirm" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" disabled={busy} />
    </>}
    <form className="integration-form" onSubmit={e => { e.preventDefault(); void send('arm', { mode, confirmation, symbol, quantity, entry, stop }); }}>
      <p><b>{symbol}</b></p>
      <label htmlFor="indodax-sl-qty">{id ? 'Jumlah aset' : 'Asset quantity'}</label>
      <input id="indodax-sl-qty" value={quantity} onChange={e => setQuantity(e.target.value)} inputMode="decimal" required disabled={busy} />
      <label htmlFor="indodax-sl-entry">{id ? 'Harga entry referensi (mata uang pasangan)' : 'Reference entry price (pair quote currency)'}</label>
      <input id="indodax-sl-entry" value={entry} onChange={e => setEntry(e.target.value)} inputMode="decimal" required disabled={busy} />
      <label htmlFor="indodax-sl-price">{id ? 'Harga SL (mata uang pasangan)' : 'SL price (pair quote currency)'}</label>
      <input id="indodax-sl-price" value={stop} onChange={e => setStop(e.target.value)} inputMode="decimal" required disabled={busy} />
      <button type="submit" disabled={busy || !liveReady}>{id ? 'Simpan / perbarui SL' : 'Save / update SL'}</button>
    </form>
    <div className="setup-nav">
      <button type="button" disabled={busy || !liveReady || Boolean(status?.worker)} onClick={() => void send('watch', { mode, confirmation })}>{id ? 'Jalankan pemantau SL' : 'Start SL monitor'}</button>
      <button type="button" disabled={busy || !status?.worker} onClick={() => void send('watch/stop', {})}>{id ? 'Hentikan pemantau SL' : 'Stop SL monitor'}</button>
    </div>
    <p role="status">{message}</p>
    {status?.stops.map((r, i) => <article key={`${r.mode}:${r.symbol}:${i}`}>
      <p><b>{r.mode} · {r.symbol} · {r.status}</b><br />{r.quantity} · SL {r.stop} {r.quote}</p>
      <p className="wallet-note">Heartbeat: {r.workerHeartbeatAt ? new Date(r.workerHeartbeatAt).toLocaleString() : id ? 'Belum aktif / dihentikan' : 'Not started / stopped'}. {id ? 'Heartbeat lama menandakan pemantau mungkin tidak berjalan.' : 'An old heartbeat indicates the monitor may not be running.'}</p>
      {r.lastError && <p role="alert">{r.lastError}</p>}
      {!['CLOSED', 'DISARMED'].includes(r.status) && <button type="button" disabled={busy || (r.mode === 'LIVE' && (mode !== 'LIVE' || !liveReady))} onClick={() => void send('disarm', { mode: r.mode, confirmation, symbol: r.symbol })}>{id ? 'Nonaktifkan SL' : 'Disarm SL'}</button>}
    </article>)}
  </section>;
}
