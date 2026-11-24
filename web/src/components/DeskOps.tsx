// Desk controls for the Indodax spot desk: kill switch, start an agent debate for one pair, last verdict.
import { useEffect, useState } from 'react';
import { officeFetch as fetch } from '../officeApi';
import type { DeskState } from '../types';
import { useI18n } from '../i18n';

const PAIRS = ['BTCIDR', 'ETHIDR', 'SOLIDR', 'BTCUSDT', 'ETHUSDT'];

export function DeskOps({ state }: { state: DeskState }) {
  const { lang } = useI18n();
  const id = lang === 'id';
  const [pair, setPair] = useState(PAIRS[0]);
  const [busy, setBusy] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [killed, setKilled] = useState(state.killed);
  useEffect(() => { setKilled(state.killed); }, [state.killed]);
  const running = Boolean(state.auto?.running);

  const post = async (url: string, body: unknown) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: response.ok, body: await response.json().catch(() => ({})) as Record<string, any> };
  };

  const startDebate = async () => {
    const symbol = pair.trim().toUpperCase();
    if (!symbol || busy) return;
    setBusy(true); setMessage(null);
    try {
      const res = await post('/api/command', { text: `analyze ${symbol}` });
      setMessage({ ok: res.ok && res.body.ok !== false, text: String(res.body.reply ?? res.body.error ?? res.body.message ?? '') });
    } catch {
      setMessage({ ok: false, text: id ? 'Debat tidak bisa dimulai. Periksa koneksi ke server.' : 'Could not start the debate. Check the server connection.' });
    } finally { setBusy(false); }
  };

  const toggleKill = async (on: boolean) => {
    if (killBusy) return;
    setKillBusy(true);
    try {
      const res = await post('/api/ops/kill', { on });
      if (res.ok && typeof res.body.killed === 'boolean') {
        setKilled(res.body.killed);
        setMessage({ ok: true, text: res.body.killed ? (id ? 'Kill switch aktif. Siklus agen dan pemantau SL berhenti.' : 'Kill switch is on. Agent cycles and the SL monitor stop.') : (id ? 'Kill switch dilepas.' : 'Kill switch released.') });
      } else {
        setMessage({ ok: false, text: String(res.body.error ?? (id ? 'Kill switch gagal diubah.' : 'Could not change the kill switch.')) });
      }
    } catch {
      setMessage({ ok: false, text: id ? 'Kill switch gagal diubah.' : 'Could not change the kill switch.' });
    } finally { setKillBusy(false); }
  };

  const verdict = state.verdicts[0];
  return <section className="wallet-panel" aria-labelledby="desk-ops-title">
    <h3 id="desk-ops-title">{id ? 'Kontrol meja Indodax' : 'Indodax desk controls'}</h3>
    <div className={`ops-kill-bar ${killed ? 'is-killed' : 'is-active'}`}>
      <div className="kill-status-wrap"><span className="kill-indicator" /><span className="kill-status-label" role="status">{killed ? (id ? 'Kill switch aktif' : 'Kill switch on') : (id ? 'Kill switch mati, siap' : 'Kill switch off, ready')}</span></div>
      <button type="button" role="switch" aria-label="Kill switch" aria-checked={killed} aria-busy={killBusy} disabled={killBusy} className={`kill-toggle-btn ${killed ? 'release-btn' : 'engage-btn'}`} onClick={() => void toggleKill(!killed)}>{killBusy ? '…' : killed ? (id ? 'Lepas' : 'Release') : (id ? 'Aktifkan kill' : 'Engage kill')}</button>
    </div>
    <p className="wallet-note">{id
      ? 'Debat enam agen memakai data publik Indodax (candle 4 jam tertutup) dan hanya memberi saran. Posisi simulasi dibuka dari panel Indodax.'
      : 'The six-agent debate uses public Indodax data (closed 4h candles) and only gives advice. Simulated positions are opened from the Indodax panel.'}</p>
    <div className="setup-nav">
      <label>{id ? 'Pasangan Indodax' : 'Indodax pair'}
        <input list="desk-ops-pairs" value={pair} onChange={(e) => setPair(e.target.value)} maxLength={20} disabled={busy} />
        <datalist id="desk-ops-pairs">{PAIRS.map((p) => <option key={p} value={p} />)}</datalist>
      </label>
      <button type="button" disabled={busy || running || killed || !pair.trim()} onClick={() => void startDebate()}>{busy ? '…' : (id ? 'Mulai debat' : 'Start debate')}</button>
    </div>
    {running && <p className="wallet-note" role="status">{id ? 'Satu siklus agen sedang berjalan.' : 'An agent cycle is running.'}</p>}
    {message && <p className={`wallet-msg ${message.ok ? '' : 'bad'}`} role="status">{message.text}</p>}
    {verdict && <p className="wallet-note">{id ? 'Verdict terakhir' : 'Last verdict'}: <b>{verdict.action}</b> {verdict.symbol} · {verdict.reason}</p>}
  </section>;
}
