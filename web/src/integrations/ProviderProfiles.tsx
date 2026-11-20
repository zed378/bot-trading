import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { officeFetch } from '../officeApi';

export function ProviderProfiles() {
  const { lang } = useI18n(); const id = lang === 'id';
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [protocol, setProtocol] = useState('chat_completions');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState(''); const [apiKey, setApiKey] = useState('');
  const [profiles, setProfiles] = useState<Array<{ provider: string; configured: boolean; metadata: Record<string, string>; updatedAt: string | null }>>([]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const load = async (initialize = false) => {
    const r = await officeFetch('/api/providers'); const body = await r.json();
    if (!r.ok || !body.ok) throw new Error(body.error || 'Provider settings unavailable.');
    setProfiles(body.profiles);
    if (initialize) {
      const saved = body.profiles.find((p: { provider: string }) => p.provider === 'openai');
      setProtocol(saved?.metadata.protocol || 'chat_completions');
      setBaseUrl(saved?.metadata.baseUrl || 'https://api.openai.com/v1');
      setModel(saved?.metadata.model || '');
    }
  };
  useEffect(() => { void load(true).catch(e => setMessage(e.message)); }, []);
  const select = (value: 'openai' | 'anthropic') => {
    setProvider(value); setApiKey(''); setMessage('');
    const saved = profiles.find(p => p.provider === value);
    setProtocol(saved?.metadata.protocol || (value === 'anthropic' ? 'anthropic' : 'chat_completions'));
    setBaseUrl(saved?.metadata.baseUrl || (value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'));
    setModel(saved?.metadata.model || '');
  };
  const send = async (action: string, body: Record<string, unknown>) => {
    setBusy(true); setMessage('');
    try {
      const r = await officeFetch(`/api/providers${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 25_000);
      const result = await r.json(); if (!r.ok || !result.ok) throw new Error(result.error || 'Provider request failed.');
      setApiKey(''); setMessage(result.note || 'OK'); await load();
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Provider request failed.'); } finally { setBusy(false); }
  };
  const configured = profiles.find(p => p.provider === provider)?.configured;
  return <section className="panel integration-panel" aria-labelledby="provider-form-title">
    <div className="panel-head"><h2 id="provider-form-title">AI Providers</h2><span className="badge">{id ? 'Key terenkripsi' : 'Encrypted keys'}</span></div>
    <p className="wallet-note">{id ? 'Konfigurasi endpoint dan model sendiri. Menyimpan provider tidak mengaktifkan Auto Trading. Field API key kosong mempertahankan key yang sudah tersimpan.' : 'Configure your endpoint and model. Saving a provider does not enable Auto Trading. An empty API key keeps the saved key.'}</p>
    <div className="seg"><button type="button" className={provider === 'openai' ? 'on' : ''} disabled={busy} onClick={() => select('openai')}>OpenAI compatible</button><button type="button" className={provider === 'anthropic' ? 'on' : ''} disabled={busy} onClick={() => select('anthropic')}>Anthropic</button></div>
    <form className="integration-form" onSubmit={e => { e.preventDefault(); void send('', { provider, protocol, baseUrl, model, ...(apiKey ? { apiKey } : {}) }); }}>
      <label htmlFor="provider-protocol">{id ? 'Protokol API' : 'API protocol'}</label>
      <select id="provider-protocol" value={protocol} disabled={busy || provider === 'anthropic'} onChange={e => setProtocol(e.target.value)}>{provider === 'anthropic' ? <option value="anthropic">Anthropic Messages</option> : <><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></>}</select>
      <label htmlFor="provider-base-url">Base URL</label><input id="provider-base-url" type="url" value={baseUrl} required disabled={busy} onChange={e => setBaseUrl(e.target.value)} />
      <label htmlFor="provider-model">{id ? 'Nama model' : 'Model name'}</label><input id="provider-model" value={model} required disabled={busy} onChange={e => setModel(e.target.value)} />
      <label htmlFor="provider-api-key">API Key · {configured ? (id ? 'Tersimpan' : 'Saved') : (id ? 'Belum tersimpan' : 'Not configured')}</label><input id="provider-api-key" type="password" value={apiKey} autoComplete="off" spellCheck={false} disabled={busy} onChange={e => setApiKey(e.target.value)} />
      <button type="submit" disabled={busy}>{id ? 'Simpan provider' : 'Save provider'}</button>
    </form>
    <div className="setup-nav"><button type="button" disabled={busy || !configured} onClick={() => void send('/check', { provider })}>{id ? 'Uji model (memakai token)' : 'Test model (uses tokens)'}</button><button type="button" disabled={busy || !configured} onClick={() => void send('/apply', { provider })}>{id ? 'Gunakan untuk 6 agen' : 'Assign to all 6 agents'}</button></div>
    <p role="status">{message}</p>
    <dl className="setup-summary">{profiles.map(p => <div key={p.provider}><dt>{p.provider}</dt><dd>{p.configured ? `${p.metadata.protocol} · ${p.metadata.model}` : id ? 'Belum dikonfigurasi' : 'Not configured'}</dd></div>)}</dl>
  </section>;
}
