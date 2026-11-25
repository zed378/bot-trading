import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { applyAndRestartOffice } from '../officeApi';
import type { AgentId, DeskState, Verdict } from '../types';
import { AGENT_ORDER } from '../types';
import { PamorPattern } from './Keris';
import { Bot } from './Bot';
import { fmt, fmtPx } from './format';
import { useI18n } from '../i18n';
import { activityEntries, activityForView, activityParticipants, filterActivity, type ActivityFilter, type ActivityView } from '../activityLog';
import { SessionLogs } from './SessionLogs';
import { FormattedText } from '../formatText';
export { fmt, fmtPx };

const SHORT: Record<AgentId, string> = { lead: 'Lead', market: 'Market', research: 'Research', strategist: 'Strategist', risk: 'Risk', execution: 'Exec' };
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
void PamorPattern;

export function TopBar({
  state,
  connected,
  theme,
  onTheme,
  onSetup,
  onTour
}: {
  state: DeskState | null;
  connected: boolean;
  theme?: string;
  onTheme?: () => void;
  onSetup?: () => void;
  onTour?: () => void;
}) {
  const { lang, toggleLang, t } = useI18n();
  const [restarting, setRestarting] = useState(false);
  const [restartReply, setRestartReply] = useState<string | null>(null);
  useEffect(() => {
    if (!restartReply) return;
    const timer = window.setTimeout(() => setRestartReply(null), 6000);
    return () => window.clearTimeout(timer);
  }, [restartReply]);
  const restart = async () => {
    setRestarting(true);
    setRestartReply(null);
    try {
      await applyAndRestartOffice();
      window.location.reload();
    } catch (error) {
      setRestartReply(error instanceof Error ? error.message : lang === 'id' ? 'Restart gagal. Periksa koneksi ke server.' : 'Restart failed. Check the server connection.');
    } finally { setRestarting(false); }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><img src="/mpu-gandring-logo.webp" alt="Trading Agent Mpu Gandring logo" width={72} height={45} /></div>
        <div className="brand-copy">
          <div className="brand-title-row">
            <h1>Trading Agent <span>Mpu Gandring</span></h1>
            <p>{t('subtitle')}</p>
          </div>
          <div className="brand-meta">
            <span className="badge" title={lang === 'id' ? 'Satu-satunya venue: Indodax spot' : 'The only venue is Indodax spot'}>Indodax spot</span>
            {state?.mode === 'LIVE'
              ? <span className="badge live-badge" title="LIVE only applies to the Indodax SL monitor">LIVE</span>
              : <span className="badge paper" title="Simulated trades only">{t('paperMode')}</span>}
            {state?.killed && <span className="badge warn">{t('killSwitchOn')}</span>}
            {state?.dailyLoss?.hit && <span className="badge warn">{t('dailyLossStop')}</span>}
            {state?.version && <span className="badge version-badge" title={'Trading Agent Mpu Gandring v' + state.version}>v{state.version}</span>}
          </div>
        </div>
      </div>
      <div className="badges">
        {(onSetup || onTour) && <details className="settings-menu">
          <summary id="setup-trigger" className="badge setup-btn" aria-label={lang === 'id' ? 'Menu Setup' : 'Setup menu'}>
            {t('setup')}
          </summary>
          <div className="settings-popover">
            {onSetup && <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onSetup(); }}>{t('setup')}</button>}
            <button type="button" className="lang-toggle-btn" onClick={toggleLang} aria-label="switch language" title="Switch language">{lang === 'en' ? 'EN ▾ ID' : 'ID ▾ EN'}</button>
            {onTour && <button className="tour-trigger-btn" onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onTour(); }}>{t('tutorial')}</button>}
          </div>
        </details>}
        {state?.paused && <span className="badge warn">{t('paused')}</span>}
        {!connected && <span className="badge warn" role="status">{t('reconnecting')}</span>}
        <button id="header-restart" type="button" className="badge setup-btn" onClick={() => void restart()} disabled={restarting} aria-busy={restarting} title={t('cbRestartTitle')}>
          ↻ {restarting ? (lang === 'id' ? 'Memulai…' : 'Restarting…') : 'Restart'}
        </button>
        {restartReply && <output className="topbar-restart-feedback" role="status">{restartReply}</output>}
        {onTheme && <button className="badge theme-toggle" onClick={onTheme} aria-label="toggle day or night">{theme === 'night' ? t('nightMode') : t('dayMode')}</button>}
      </div>
    </header>
  );
}



export function TickerStrip({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const items = Object.values(state.tickers);
  if (!items.length) return <div className="ticker"><span className="muted">{t('waitingPrices')}</span></div>;
  const row = [...items, ...items, ...items];
  return (
    <div className="ticker" aria-label="prices">
      <div className="ticker-track">
        {row.map((tk, i) => (
          <span key={i} className="tick">
            <b>{tk.symbol}</b>
            <span>{fmtPx(tk.last)}</span>
            <em className={tk.change24hPct >= 0 ? 'up' : 'down'}>{tk.change24hPct >= 0 ? '▲' : '▼'} {fmt(Math.abs(tk.change24hPct))}%</em>
            <small>{tk.example ? 'sample · EXAMPLE' : tk.source}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

export function FightMeter({ state, meter, fighting = false }: { state: DeskState; meter: { weighted: number; disagreement: number } | null; fighting?: boolean }) {
  const { t } = useI18n();
  const d = state.debate;
  const latestVerdict = state.verdicts?.[0];
  const dis = meter?.disagreement ?? d?.disagreement ?? latestVerdict?.disagreement ?? 0;
  const camps = d?.camps ?? latestVerdict?.camps ?? { bull: [], bear: [], neutral: [] };
  const totalCampCount = camps.bull.length + camps.bear.length + camps.neutral.length;
  const fallbackWeighted = totalCampCount > 0 ? (camps.bull.length - camps.bear.length) / totalCampCount : 0;
  const w = meter?.weighted ?? d?.weighted ?? fallbackWeighted;
  const opposing = camps.bull.length > 0 && camps.bear.length > 0;
  const rawKey = fighting
    ? 'full-brawl'
    : dis >= state.fightThreshold && opposing
      ? 'fists-out'
      : dis > 0.25
        ? 'heated'
        : dis > 0 || opposing || camps.bull.length > 0 || camps.bear.length > 0
          ? 'mostly-agree'
          : 'quiet';
  const label = rawKey === 'full-brawl' ? t('fullBrawl') : rawKey === 'fists-out' ? t('meterHeatedViews') : rawKey === 'heated' ? (opposing ? t('meterOpposingViews') : t('meterGeneralTension')) : rawKey === 'mostly-agree' ? t('mostlyAgree') : t('quiet');
  return (
    <section className="panel meter">
      <div className="panel-head"><h2>{t('fightMeter')}</h2><span className={`heat-label h-${rawKey}`}>{label}</span></div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, Math.round(dis * 100)))}%` }} />
        <div className="meter-pin" style={{ left: `clamp(5px, ${Math.round(dis * 100)}%, calc(100% - 5px))` }} title={`${Math.round(dis * 100)}% disagreement`} />
        <div className="meter-threshold" style={{ left: `clamp(0px, ${state.fightThreshold * 100}%, calc(100% - 2px))` }} title="Configured debate escalation threshold" />
      </div>
      <div className="meter-scale"><span>{t('consensus')}</span><span className="meter-reading-full">{Math.round(dis * 100)}{t('disagreementSuffix')}</span><span className="meter-reading-short" aria-hidden="true">{Math.round(dis * 100)}%</span><span>{t('brawl')}</span></div>
      <div className="tug">
        <span className="bear-side">BEAR</span>
        <div className="rope"><i style={{ left: `${50 + w * 50}%` }} /></div>
        <span className="bull-side">BULL</span>
      </div>
      <div className="camps">
        <Camp label={t('bulls')} ids={camps.bull} state={state} cls="bull" noneLabel={t('none')} />
        <Camp label={t('bears')} ids={camps.bear} state={state} cls="bear" noneLabel={t('none')} />
        <Camp label={t('fence')} ids={camps.neutral} state={state} cls="neutral" noneLabel={t('none')} />
      </div>
    </section>
  );
}
function Camp({ label, ids, state, cls, noneLabel }: { label: string; ids: AgentId[]; state: DeskState; cls: string; noneLabel: string }) {
  return (
    <div className={`camp ${cls}`}>
      <small>{label}</small>
      <div>{ids.length ? ids.map((id) => <span key={id} className="chip" style={{ ['--agent' as string]: state.agents[id].color }}>{SHORT[id]}</span>) : <span className="muted">{noneLabel}</span>}</div>
    </div>
  );
}






const ACTION_LABEL: Record<Verdict['action'], string> = { OPEN_LONG: 'OPEN LONG', OPEN_SHORT: 'OPEN SHORT', CLOSE: 'CLOSE', HOLD: 'HOLD' };
export function Verdicts({ state, compact = false }: { state: DeskState; compact?: boolean }) {
  const { t } = useI18n();
  const detailId = useId();
  return (
    <section className={`panel verdicts${compact ? ' verdicts-compact' : ''}`}>
      <div className="panel-head"><h2>{t('verdictsTitle')}</h2><small className="muted">{t('verdictsSub')}</small></div>
      {state.verdicts.length === 0 && <p className="muted">{t('noVerdictYet')}</p>}
      <div className="verdict-list">
        {state.verdicts.slice(0, compact ? 3 : 6).map((v, idx) => {
          const popId = idx === 0 ? detailId : `${detailId}-${idx}`;
          return (
          <article key={v.id} className={`verdict a-${v.action}`} title={time(v.at)}>
            <div className="v-top">
              <span className="v-action">{ACTION_LABEL[v.action]}</span>
              <b>{v.symbol}</b>
              {v.example && <em className="tag-example">EXAMPLE</em>}
              <time>{time(v.at)}</time>
            </div>
            {compact ? <>
              <button className="verdict-reason-trigger" type="button" popoverTarget={popId}>{v.reason}</button>
              <div id={popId} popover="auto" className="office-verdict-popover" role="dialog" aria-label={t('verdictsTitle')}>
                <strong>{ACTION_LABEL[v.action]} · {v.symbol}</strong><p>{v.reason}</p>
                <button type="button" popoverTarget={popId} popoverTargetAction="hide">{t('closeBtn')}</button>
              </div>
            </> : <p>{v.reason}</p>}
            <div className="v-meta">
              <span>risk {v.riskDecision}</span>
              <span>heat {Math.round(v.disagreement * 100)}%</span>
              <span>{v.executed ? `${state.mode === 'PAPER' ? 'Paper' : state.mode} ${v.executionStatus ?? v.order?.status ?? 'execution recorded'}` : t('noFill')}</span>
              {!compact && v.order && <span>{v.order.qty} @ {fmtPx(v.order.entry)} · SL {fmtPx(v.order.stop)}{v.order.tp ? ` · TP ${fmtPx(v.order.tp)}` : ''}</span>}
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}

export function TradeLog({ state, active = true, view = 'log' }: { state: DeskState; active?: boolean; view?: ActivityView }) {
  const { t, lang } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const entries = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const wasActive = useRef(false);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(200);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const lines = filterActivity(activityForView(activityEntries(state), view), filter, query, state.agents);
  const isHistory = view === 'history';
  const searchLabel = isHistory ? 'Search history' : 'Search activity log';
  const last = lines.at(-1);
  useLayoutEffect(() => {
    if (!active) { wasActive.current = false; return; }
    if (!wasActive.current) follow.current = true;
    wasActive.current = true;
    if (follow.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [active, last?.at, last?.text, lines.length, filter, query, limit]);
  useLayoutEffect(() => {
    const element = ref.current, content = entries.current;
    if (!active || !element || !content) return;
    const observer = new ResizeObserver(() => { if (follow.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element); observer.observe(content);
    return () => observer.disconnect();
  }, [active]);
  return (
    <section className="panel log">
      <div className="panel-head"><h2>{isHistory ? 'History' : lang === 'id' ? 'Log sistem' : 'System log'}</h2>
        {!isHistory && <div className="session-log-tabs" role="group" aria-label={lang === 'id' ? 'Tampilan log' : 'Log view'}>
          <button type="button" aria-pressed={!archiveOpen} onClick={() => setArchiveOpen(false)}>{lang === 'id' ? 'Langsung' : 'Live'}</button>
          <button type="button" aria-pressed={archiveOpen} onClick={() => setArchiveOpen(true)}>{lang === 'id' ? 'Sesi arsip' : 'Archived sessions'}</button>
        </div>}
        {!archiveOpen && <span>{lines.length} {lang === 'id' ? 'catatan' : 'entries'}</span>}
      </div>
      {archiveOpen && !isHistory ? <SessionLogs lang={lang} /> : <>
      <div className="activity-log-controls">
        <select aria-label={isHistory ? 'History filter' : 'Log filter'} value={filter} onChange={event => { follow.current = true; setFilter(event.target.value as ActivityFilter); }}>
          <option value="all">{t('allFilter')}</option>
          {isHistory ? <>
          <option value="trades">{lang === 'id' ? 'Riwayat trading' : 'Trade history'}</option><option value="chat">{lang === 'id' ? 'Sesi chat' : 'Chat sessions'}</option>
          <option value="discussion">{lang === 'id' ? 'Diskusi agen' : 'Agent discussions'}</option><option value="command">{lang === 'id' ? 'Perintah' : 'Commands'}</option>
          </> : <>
          <option value="tool">Tools</option><option value="mcp">MCP</option><option value="plugin">Plugins</option><option value="process">Processes</option>
          <option value="frontend">Frontend</option><option value="backend">Backend</option>
          <option value="errors">{lang === 'id' ? 'Error dan peringatan' : 'Errors and warnings'}</option>
          </>}
        </select>
        <input type="search" aria-label={searchLabel} placeholder={isHistory ? (lang === 'id' ? 'Cari riwayat…' : 'Search history…') : lang === 'id' ? 'Cari aktivitas…' : 'Search activity…'} value={query} onChange={event => { follow.current = true; setQuery(event.target.value); }} />
        <select aria-label="Visible log entries" value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={200}>200</option><option value={500}>500</option><option value={2000}>2000</option></select>
        <button type="button" onClick={() => { follow.current = true; ref.current?.scrollTo({ top: ref.current.scrollHeight }); }}>{lang === 'id' ? 'Terbaru' : 'Latest'}</button>
      </div>
      <div className="log-body" ref={ref} role="log" aria-live="polite" onScroll={() => { const element = ref.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
        <div className="log-entries" ref={entries}>
        {!lines.length && <p className="muted">{filter === 'trades' ? t('noTradesYet') : t('noDeskActivity')}</p>}
        {lines.slice(-limit).map((l, i) => (
          <div key={l.id || `${l.at}-${i}`} className={`line k-${l.kind} level-${l.level || (l.kind === 'warn' ? 'warn' : 'info')}`}>
            <time dateTime={new Date(l.at).toISOString()}>{new Date(l.at).toLocaleString()}</time>
            <b>{l.source || l.kind}</b>
            {l.from ? <b>{activityParticipants(l, state.agents)}</b> : l.agent && <b style={{ color: state.agents[l.agent]?.color }}>{state.agents[l.agent]?.name}</b>}
            {l.status && <small>{l.status}</small>}
            {'durationMs' in l && l.durationMs !== undefined && <small>{l.durationMs}ms</small>}
            <span><FormattedText text={l.text} /></span>
          </div>
        ))}
        </div>
      </div>
      </>}
    </section>
  );
}

export function Roster({ state, onSelect }: { state: DeskState; onSelect: (id: AgentId) => void }) {
  return (
    <div className="roster">
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        return (
          <button key={id} className={`roster-item status-${a.status}`} title={`${a.name} · ${a.provider}`} style={{ ['--agent' as string]: a.color }} onClick={() => onSelect(id)}>
            <Bot id={id} size={20} pose="idle" />
            <span>{a.name}</span>
            <small>{a.provider === 'mock' ? 'mock' : a.provider}</small>
          </button>
        );
      })}
    </div>
  );
}
