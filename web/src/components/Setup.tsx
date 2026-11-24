// Settings for the Indodax desk: model assignment per agent, local agents, chat alerts and desk preferences.
// Indodax keys and AI providers have their own panels in the tool menu.
import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import { ChannelsSetup } from './Channels';
import { ModelsSetup } from './ModelsSetup';
import { PreferencesSetup } from './PreferencesSetup';
import { LocalAgentsSetup } from './LocalAgentsSetup';
import { JevSetup } from './JevSetup';
import { useI18n } from '../i18n';

type SetupTab = 'models' | 'local' | 'channels' | 'desk';

export function SetupWizard({ onClose }: { state: DeskState | null; onClose: () => void }) {
  const { lang } = useI18n();
  const id = lang === 'id';
  const [activeTab, setActiveTab] = useState<SetupTab>('models');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('.setup-tab-btn.active')?.focus();
    return () => previous?.focus();
  }, []);
  const tabs: { id: SetupTab; label: string }[] = [
    { id: 'models', label: id ? 'Model agen' : 'Agent models' },
    { id: 'local', label: id ? 'Agen lokal' : 'Local agents' },
    { id: 'channels', label: 'Telegram' },
    { id: 'desk', label: id ? 'Preferensi' : 'Preferences' }
  ];
  return <div className="setup-overlay" ref={dialog} role="dialog" aria-modal="true" aria-label={id ? 'Pengaturan' : 'Settings'} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
    <div className="panel setup setup-tabbed">
      <div className="panel-head">
        <h2>{id ? 'Pengaturan meja Indodax' : 'Indodax desk settings'}</h2>
        <button onClick={onClose}>{id ? 'Tutup' : 'Close'}</button>
      </div>
      <div className="setup-body">
        <nav className="setup-sidebar" aria-label={id ? 'Bagian pengaturan' : 'Settings sections'}>
          {tabs.map((tab) => <button key={tab.id} type="button" className={`setup-tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}><span>{tab.label}</span></button>)}
        </nav>
        <main className="setup-content">
          <section className="setup-pane" hidden={activeTab !== 'models'}>
            <ModelsSetup available appMode="local" />
            <JevSetup available />
          </section>
          <section className="setup-pane setup-local-pane" hidden={activeTab !== 'local'}><LocalAgentsSetup available /></section>
          <section className="setup-pane" hidden={activeTab !== 'channels'}><ChannelsSetup /></section>
          <section className="setup-pane" hidden={activeTab !== 'desk'}><PreferencesSetup /></section>
        </main>
      </div>
      <p className="wallet-note small">{id ? 'Bukan nasihat keuangan.' : 'Not financial advice.'}</p>
    </div>
  </div>;
}
