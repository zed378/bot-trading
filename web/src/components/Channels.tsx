// Telegram notifications for the Desk Lead, inside the Setup wizard.
// Secrets are typed into masked inputs, sent once to the localhost-only route, written to .env (chmod 600) and cleared from the page.
import { useEffect, useState } from 'react';
import { officeFetch as fetch } from '../officeApi';
import { useI18n } from '../i18n';

interface Link { label: string; url: string; login?: boolean }
interface Field { env: string; label: string; secret: boolean; required: boolean; hint: string }
interface Guide { channel: string; label: string; official: string; outbound: string; inbound: string; publicUrl: boolean; fields: Field[]; steps: { title: string; text: string; links: Link[] }[]; notes: string[] }
interface Info { ok: boolean; error?: string; linksCheckedOn: string; entry: { available: boolean; reason: string }; notShipped: Record<string, string>; supervisorEnv: { env: string; text: string }[];
  status: { commands: boolean; supervisor: { on: boolean; intervalMin: number; cooldownMin: number }; channels: { channel: string; label: string; enabled: boolean; commandsReady: boolean; fields: { env: string; set: boolean; shown: string | null }[] }[] }; guides: Guide[] }

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export function ChannelsSetup() {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const ch = 'telegram';
  const [at, setAt] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [commands, setCommands] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [chats, setChats] = useState<{ chatId: string; chat: string; userId: string; user: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = () => fetch('/api/setup/channels').then((r) => r.json()).then((d: Info) => { setInfo(d); if (d.ok) setCommands(d.status.commands); }).catch(() => setInfo({ ok: false, error: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office backend not reachable' } as Info));
  useEffect(() => { void load(); }, [lang]);
  if (!info) return null;
  if (!info.ok) return <p className="wallet-msg bad">{info.error}</p>;
  const g = info.guides.find((x) => x.channel === ch) ?? info.guides[0];
  const st = info.status.channels.find((x) => x.channel === ch) ?? info.status.channels[0];
  if (!g || !st) return <p className="wallet-note">{lang === 'id' ? 'Kanal Telegram belum tersedia.' : 'Telegram channel unavailable.'}</p>;
  const step = Math.min(at, g.steps.length - 1);
  const cur = g.steps[step];

  async function save() { setBusy(true); const r = await post('/api/setup/channels/save', { channel: ch, values: vals, commands }).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable' })); setVals({}); setBusy(false); setMsg({ ok: r.ok, text: r.detail ?? r.error }); if (r.ok) { setEditing(false); void load(); } }
  async function resetChannelConfig(channel: string) {
    if (!window.confirm(lang === 'id' ? `Hapus dan reset seluruh konfigurasi ${g.label}?` : `Delete and reset all configuration for ${g.label}?`)) return;
    setBusy(true);
    const r = await post('/api/setup/channels/reset', { channel }).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable' }));
    setBusy(false);
    setVals({});
    setEditing(false);
    setMsg({ ok: r.ok, text: r.detail ?? r.error });
    if (r.ok) void load();
  }
  async function test() { setBusy(true); const r = await post('/api/setup/channels/test', { channel: ch }).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable' })); setBusy(false); setMsg({ ok: r.ok, text: r.detail ?? r.error }); }
  async function findChats() { setBusy(true); const r = await post('/api/setup/channels/telegram-chats', {}).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable', chats: [] })); setBusy(false); setChats(r.chats ?? []); setMsg({ ok: r.ok, text: r.detail ?? r.error }); }
  async function syncTelegramCommands() {
    setBusy(true);
    try { const result = await post('/api/setup/channels/telegram-sync', {}); setMsg({ ok: result.ok, text: result.detail }); }
    catch { setMsg({ ok: false, text: lang === 'id' ? 'Sinkronisasi Telegram gagal.' : 'Telegram synchronization failed.' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="setup-channels">
      <p className="wallet-note">{t('setupChannelsNote')}</p>
      <div className="setup-section-actions">
        <p className="wallet-note">{st.enabled ? t('setupChannelsConnReady') : t('setupChannelsNoConn')} {t('setupChannelsSafeCommands')} {info.status.commands ? (lang === 'id' ? 'aktif' : 'on') : (lang === 'id' ? 'mati' : 'off')}.</p>
        <div className="setup-channel-actions">
          {st.enabled && (
            <button type="button" disabled={busy || !info.entry.available} className="bad" onClick={() => void resetChannelConfig(ch)}>
              {lang === 'id' ? `Hapus Konfigurasi (${g.label})` : `Delete Config (${g.label})`}
            </button>
          )}
          {!editing && <button disabled={!info.entry.available} onClick={() => { setCommands(info.status.commands); setEditing(true); }}>{t('setupChannelsEditBtn')} ({g.label})</button>}
        </div>
      </div>
      {!editing && (
        <>
          <dl className="setup-summary">
            {st.fields.map((f) => (
              <div key={f.env}>
                <dt>{f.env}</dt>
                <dd>{f.set ? f.shown ?? (lang === 'id' ? 'Tersimpan · disembunyikan' : 'Saved · hidden') : (lang === 'id' ? 'Belum diatur' : 'Not set')}</dd>
              </div>
            ))}
          </dl>
          <div className="setup-nav" style={{ marginTop: '8px' }}>
            <button disabled={busy || !st.enabled} onClick={test}>{t('setupChannelsSendTestBtn')}</button>
            <button type="button" disabled={busy || !st.enabled} onClick={() => void syncTelegramCommands()}>
              {lang === 'id' ? 'Sinkronkan Perintah Telegram' : 'Sync Telegram Commands'}
            </button>
          </div>
        </>
      )}
      <div hidden={!editing}>
      <p className="wallet-note small">{g.official}. {lang === 'id' ? 'Kirim:' : 'Posts:'} {g.outbound}. {lang === 'id' ? 'Perintah:' : 'Commands:'} {g.inbound}.</p>
      <details className="setup-reference"><summary>{lang === 'id' ? 'Panduan koneksi' : 'Connection guide'}</summary>
      <h4>{lang === 'id' ? 'Langkah' : 'Step'} {step + 1} {lang === 'id' ? 'dari' : 'of'} {g.steps.length}: {cur.title}</h4>
      <div className="setup-step"><p>{cur.text}</p><ul>{cur.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>{l.login ? (lang === 'id' ? ' (masuk dulu)' : ' (sign in first)') : ''}</li>)}</ul></div>
      <div className="setup-nav"><button disabled={step === 0} onClick={() => setAt(step - 1)}>{lang === 'id' ? 'Kembali' : 'Back'}</button><button disabled={step >= g.steps.length - 1} onClick={() => setAt(step + 1)}>{lang === 'id' ? 'Langkah berikutnya' : 'Next step'}</button>
        <button disabled={busy} onClick={findChats}>{t('setupChannelsFindChatIdBtn')}</button></div>
      {chats && chats.length > 0 && <ul className="wallet-note small">{chats.map((c) => <li key={c.chatId + c.userId}>chat id <code>{c.chatId}</code> ({c.chat}), user id <code>{c.userId}</code> ({c.user})</li>)}</ul>}

      </details>
      {info.entry.available ? (
        <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {g.fields.map((f) => <label key={f.env}><span>{f.label}{f.required ? '' : (lang === 'id' ? ' (opsional)' : ' (optional)')} <code>{f.env}</code></span><input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={st.fields.find((x) => x.env === f.env)?.set ? (lang === 'id' ? 'sudah diatur, kosongkan bila tidak diganti' : 'already set, empty keeps it') : f.hint} value={vals[f.env] ?? ''} onChange={(e) => setVals({ ...vals, [f.env]: e.target.value })} /></label>)}
          <label className="setup-check"><input type="checkbox" checked={commands} onChange={(e) => setCommands(e.target.checked)} /> <span>{t('setupChannelsAllowCommandsCheck')}</span></label>
          <div className="setup-nav" style={{ marginTop: '8px' }}>
            <button disabled={busy} type="submit">{t('setupChannelsSaveBtn')}</button>
            <button type="button" disabled={busy || !st.enabled} onClick={test}>{t('setupChannelsSendTestBtn')}</button>
            {st.enabled && (
              <button type="button" disabled={busy} className="bad" onClick={() => void resetChannelConfig(ch)}>
                {lang === 'id' ? `Hapus Konfigurasi (${g.label})` : `Delete Config (${g.label})`}
              </button>
            )}
            <button type="button" disabled={busy || (!st.enabled && !vals.TELEGRAM_BOT_TOKEN)} onClick={() => void syncTelegramCommands()}>
              {lang === 'id' ? 'Sinkronkan Perintah Telegram' : 'Sync Telegram Commands'}
            </button>
          </div>
        </form>
      ) : <p className="wallet-note">{lang === 'id' ? `Input dinonaktifkan di sini: ${info.entry.reason}` : `Entry is off here: ${info.entry.reason}`}</p>}
      <p className="wallet-note small">{lang === 'id' ? 'Kredensial lama tetap dipakai jika kolom dikosongkan. Secret tidak pernah ditampilkan kembali. Restart meja trading setelah menyimpan.' : 'Existing values are retained when left blank. Secrets are never loaded back into inputs. Restart the desk after saving.'}</p>
      {g.notes.map((n) => <p key={n} className="wallet-note small">{n}</p>)}
      <button disabled={busy} onClick={() => { setVals({}); setCommands(info.status.commands); setEditing(false); setMsg(null); }}>{t('setupDeskCancelBtn')}</button>
      </div>
      {msg && <p role="status" className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
      <p className="wallet-note small">Desk Lead {info.status.supervisor.on ? `${lang === 'id' ? 'aktif, setiap' : 'on, every'} ${info.status.supervisor.intervalMin} ${lang === 'id' ? 'mnt' : 'min'}` : (lang === 'id' ? 'mati sampai Telegram dikonfigurasi' : 'off until Telegram is set')}.</p>
    </div>
  );
}
