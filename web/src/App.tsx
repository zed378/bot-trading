import { lazy, useEffect, useState } from 'react';
import { useDesk } from './useDesk';
import type { AgentId, CandleData, ChartTimeframe } from './types';
import { Office } from './components/Office';
import { DeferredPanel } from './components/DeferredPanel';
import { CommandBar } from './components/CommandBar';
import { Reports } from './components/Reports';
import { WorkspaceTools } from './components/WorkspaceTools';
import { Tour } from './components/Tour';
import { TopBar, TickerStrip, FightMeter, Verdicts, Roster } from './components/Panels';
import { I18nProvider, useI18n } from './i18n';
import './styles/dashboard-v2.css';

const PriceChart = lazy(() => import('./components/PriceChart').then((m) => ({ default: m.PriceChart })));
const SetupWizard = lazy(() => import('./components/Setup').then((m) => ({ default: m.SetupWizard })));
const AgentPanel = lazy(() => import('./components/AgentPanel').then((m) => ({ default: m.AgentPanel })));

function initialTheme() {
  const saved = localStorage.getItem('mg-theme');
  if (saved === 'day' || saved === 'night') return saved;
  return 'day';
}

function initialTourOpen() {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('mpu_tour_done_v1') !== '1';
  } catch {
    return false;
  }
}

function AppInner() {
  const { t, lang } = useI18n();
  const { state, connected, speech, fights, meter, reactions, cendolBanner, dismissCendolBanner, triggerCendolTip, sceneEvents, command, activeConversationId, selectConversation, newConversation, deleteConversation } = useDesk();
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [theme, setTheme] = useState<string>(initialTheme);
  const [symbol, setSymbol] = useState<string>('');
  const [candles, setCandles] = useState<CandleData | null>(null);
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('4h');
  const [chartError, setChartError] = useState('');
  const [chartRetry, setChartRetry] = useState(0);
  const [setup, setSetup] = useState<boolean>(() => window.location.hash === '#setup');
  const [tourOpen, setTourOpen] = useState<boolean>(initialTourOpen);
  useEffect(() => {
    const h = () => setSetup(window.location.hash === '#setup');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const closeSetup = () => { setSetup(false); if (window.location.hash.startsWith('#setup')) history.replaceState(null, '', window.location.pathname); };
  const closeTour = () => {
    setTourOpen(false);
    try { localStorage.setItem('mpu_tour_done_v1', '1'); } catch { /* ignore */ }
  };

  const anyModalOpen = Boolean(state) && (setup || tourOpen);
  useEffect(() => {
    document.documentElement.classList.toggle('modal-open', anyModalOpen);
    document.body.classList.toggle('modal-open', anyModalOpen);
    return () => {
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
    };
  }, [anyModalOpen]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('mg-theme', theme); }, [theme]);

  // the chart follows the debate symbol, otherwise the user's pick
  const debating = state?.debate?.symbol;
  useEffect(() => { if (debating) setSymbol(debating); }, [debating]);
  const sym = symbol || state?.watchlist[0] || '';
  useEffect(() => {
    if (!sym) return;
    const controller = new AbortController();
    let timer: number;
    setCandles(null);
    setChartError('');
    const load = async () => {
      try {
        const response = await fetch(`/api/candles?symbol=${encodeURIComponent(sym)}&tf=${timeframe}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Candles unavailable. Retry.');
        if (!controller.signal.aborted) { setCandles(data); setChartError(''); }
      } catch (error) {
        if (!controller.signal.aborted) setChartError(error instanceof Error ? error.message : 'Candles unavailable. Retry.');
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(load, 30_000);
      }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sym, timeframe, chartRetry]);

  if (!state) {
    return (
      <div className="app dashboard">
        <TopBar state={null} connected={connected} />
        <div className="loading"><div className="loader" /><p>{t('openingOfficeMsg')} <code>npm run dev</code></p></div>
      </div>
    );
  }
  const dis = meter?.disagreement ?? state.debate?.disagreement ?? 0;
  const spark = candles && candles.symbol === sym ? candles.candles.slice(-40).map((c) => c.close) : [];
  const id = lang === 'id';
  return (
    <div className="app dashboard">
      <a className="skip-office" href="#office-workspace">{id ? 'Ke ruang kerja' : 'Skip to workspace'}</a>
      <TopBar
        state={state}
        connected={connected}
        theme={theme}
        onTheme={() => setTheme(theme === 'night' ? 'day' : 'night')}
        onSetup={() => { window.location.hash = 'setup'; }}
        onTour={() => setTourOpen(true)}
      />
      <TickerStrip state={state} />
      <main className="layout" id="office-workspace" tabIndex={-1}>
        <section className="stage">
          <Office sceneEvents={sceneEvents} state={state} speech={speech} fights={fights} reactions={reactions} disagreement={dis} selected={selected} spark={spark} onSelect={setSelected} command={command} activeConversationId={activeConversationId} selectConversation={selectConversation} newConversation={newConversation} deleteConversation={deleteConversation} cendolBanner={cendolBanner} onDismissCendol={dismissCendolBanner}>
            <FightMeter state={state} meter={meter} fighting={fights.length > 0} />
            <Verdicts state={state} compact />
          </Office>
          <section className="desk-team" id="desk-team" aria-label={id ? 'Tim agen' : 'Agent team'}><Roster state={state} onSelect={setSelected} /></section>
          <CommandBar state={state} command={(cmd) => command(cmd)} />
          <div className="workspace-section-title market-section-title"><h2>{id ? 'Pasar & catatan meja' : 'Markets & desk notes'}</h2><span>{id ? 'Harga, keputusan, dan laporan' : 'Prices, decisions, and reports'}</span></div>
          <div className="market-workspace" id="market-workspace">
            <DeferredPanel label="Price chart"><PriceChart state={state} symbol={sym} onSymbol={setSymbol} data={candles} theme={theme} timeframe={timeframe} onTimeframe={setTimeframe} error={chartError} onRetry={() => setChartRetry((n) => n + 1)} /></DeferredPanel>
            <Reports state={state} />
          </div>
        </section>
        <aside className="side">
          <WorkspaceTools state={state} command={(cmd) => void command(cmd)} onActiveChange={(id) => { if (id) setSelected(null); }} />
        </aside>
      </main>
      {setup && <DeferredPanel label="Setup"><SetupWizard state={state} onClose={closeSetup} /></DeferredPanel>}
      {selected && <DeferredPanel label="Agent"><AgentPanel state={state} id={selected} onClose={() => setSelected(null)} command={command} conversationId={activeConversationId} onNewConversation={newConversation} onDeleteConversation={deleteConversation} /></DeferredPanel>}
      <Tour open={tourOpen && !setup} onClose={closeTour} />
      <footer className="footer">{t('footerNote')} Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>.</footer>
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
