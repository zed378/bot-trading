import { useEffect, useState } from 'react';
import { officeFetch } from '../officeApi';
import { useI18n } from '../i18n';
export function IndodaxCredentials() {
  const { lang } = useI18n(); const id = lang === 'id';
  const [key, setKey] = useState(''), [secret, setSecret] = useState('');
  const [configured, setConfigured] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { void officeFetch('/api/indodax/credentials').then(r => r.json()).then(body => { if (!body.ok) throw new Error(body.error); setConfigured(body.configured); }).catch(() => setMessage(id ? 'Status kredensial belum tersedia.' : 'Credential status unavailable.')); }, []);
  const send = async (check = false) => {
    setBusy(true); setMessage('');
    try {
      const r = await officeFetch(`/api/indodax/credentials${check ? '/check' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(check ? {} : { key, secret }) }, 30_000);
      const body = await r.json(); if (!r.ok || !body.ok) throw new Error(body.error || 'Indodax credential request failed.');
      if (!check) { setKey(''); setSecret(''); setConfigured(true); } setMessage(body.note);
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Credential request failed.'); } finally { setBusy(false); }
  };
  return <section aria-labelledby="indodax-credentials-title">
    <h3 id="indodax-credentials-title">{id ? 'Kredensial Indodax' : 'Indodax credentials'} <span className="badge">{configured ? (id ? 'Tersimpan' : 'Saved') : (id ? 'Belum diatur' : 'Not configured')}</span></h3>
    <p className="wallet-note">{id ? 'Disimpan terenkripsi AES-256-GCM di PostgreSQL. Gunakan key Read + Trade dengan penarikan crypto dan fiat nonaktif. Menyimpan key tidak mengaktifkan LIVE. Hentikan pemantau LIVE sebelum mengganti key.' : 'Encrypted with AES-256-GCM in PostgreSQL. Use Read + Trade keys with crypto and fiat withdrawals off. Saving keys does not enable LIVE. Stop LIVE monitors before rotating keys.'}</p>
    <form className="integration-form" onSubmit={e => { e.preventDefault(); void send(); }}>
      <label htmlFor="indodax-api-key">API Key</label><input id="indodax-api-key" type="password" value={key} onChange={e => setKey(e.target.value)} required autoComplete="off" spellCheck={false} disabled={busy} />
      <label htmlFor="indodax-api-secret">API Secret</label><input id="indodax-api-secret" type="password" value={secret} onChange={e => setSecret(e.target.value)} required autoComplete="off" spellCheck={false} disabled={busy} />
      <div className="setup-nav"><button type="submit" disabled={busy}>{id ? 'Simpan terenkripsi' : 'Save encrypted'}</button><button type="button" disabled={busy || !configured} onClick={() => void send(true)}>{id ? 'Periksa izin key' : 'Check key permissions'}</button></div>
    </form><p role="status">{message}</p>
  </section>;
}
