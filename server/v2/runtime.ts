import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentId, RoomMessage } from '../types.js';
import { log, safe } from '../redact.js';
import { configurationFingerprint } from '../session-entry.js';
import {
  getSessionLogger,
  recordDiagnostic,
  registerDiagnosticSecrets
} from '../session-log.js';
import { EXCHANGES, ROLE_IDS, type AppMode, type Network, type OfficeCommand, type OfficeReply, type OfficeRuntime, type OfficeState, type RoleId, type TradingMode, type VenueId } from './contracts.js';
import {
  attachOfficeWebSocket,
  createInitialOfficeState,
  OfficeEventHub
} from './office.js';
import { createReplacementApp } from './app.js';
import { RoleRunner, type RoleResult, type RoleTask } from './agents/runner.js';
import { CycleRunner, type CyclePolicy, type CycleReason } from './decision/cycle.js';
import { JevClient } from './agents/jev.js';
import { createOfficialProviderCaller, type ProviderAssignment } from './agents/providers.js';
import { loadProviderProfiles, type SavedProviderProfile } from './settings/provider-profiles.js';
import { resolveCanonicalRole } from './agents/roles.js';
import { PROVIDER_KEY_ENV, SecretStore } from './settings/secrets.js';
import { type ApiProviderId } from './settings/schema.js';
import type { Position, Stance, Verdict } from '../../shared/office.js';
import type { IndodaxContext } from '../../shared/indodax-context.js';
import type { IndodaxTimeframe } from '../../shared/indodax.js';
import { IndodaxDataError, IndodaxPublicClient } from '../market/indodax.js';
import { buildIndodaxContext, indodaxPromptSummary } from '../market/indodax-context.js';
import { resolveIndodaxSymbol } from '../market/indodax-symbol.js';
import { toIndodaxVerdict } from './decision/indodax-verdict.js';
import { RuntimeStore } from './store/database.js';
import { ExecutionAuthorityService } from './accounts/authority.js';
import { AccountRegistry } from './accounts/registry.js';
import { SettingsService } from './settings/service.js';
import { ChatService } from './api/chat.js';
import { HELP_TEXT, syncTelegramCommandsV2, TelegramPoller } from './telegram.js';
import { formatDeskReportText, ReportsService } from './reports.js';
import { deskOpenPnl, formatLessonsCard, formatScorecardCard, formatStatusCard } from './channel-text.js';
import { readKill, writeKill, clearKill, DEFAULT_KILL_FILE } from './kill-file.js';



export class StartupValidationError extends Error {
  constructor(message: string, public readonly exitCode = 2) {
    super(message);
    this.name = 'StartupValidationError';
  }
}

const VENUE_PREFIX: Record<VenueId, string> = {
  indodax: 'INDODAX'
};

export function venueCredentialEnvNames(
  venue: VenueId,
  _network: Network = 'mainnet'
): { key: string; secret: string; passphrase?: string } {
  const prefix = VENUE_PREFIX[venue];
  return { key: `${prefix}_API_KEY`, secret: `${prefix}_API_SECRET` };
}

export interface StartupEnvCheck {
  tradingMode: TradingMode;
  appMode: AppMode;
  host: string;
  port: number;
  venue: VenueId | null;
  network: Network | null;
}

export function resolveEffectiveSafetyNet(
  env: NodeJS.ProcessEnv = process.env,
  network: Network | null = null,
  savedValue?: number | null
): { value: number; source: string; isExplicitZero: boolean; isValidPositive: boolean } {
  if (savedValue !== undefined && savedValue !== null && Number.isFinite(savedValue)) {
    return {
      value: savedValue,
      source: 'saved_settings',
      isExplicitZero: savedValue === 0,
      isValidPositive: savedValue > 0
    };
  }

  const networkKey = network === 'mainnet' ? 'MAINNET_DESK_SAFETY_NET' : null;
  const netRaw = networkKey ? env[networkKey] : undefined;
  if (netRaw !== undefined && netRaw.trim() !== '') {
    const parsed = Number(netRaw.trim());
    if (Number.isFinite(parsed)) {
      return {
        value: parsed,
        source: networkKey!,
        isExplicitZero: parsed === 0,
        isValidPositive: parsed > 0
      };
    }
  }

  const globalRaw = env.SAFETY_NET;
  if (globalRaw !== undefined && globalRaw.trim() !== '') {
    const parsed = Number(globalRaw.trim());
    if (Number.isFinite(parsed)) {
      return {
        value: parsed,
        source: 'SAFETY_NET',
        isExplicitZero: parsed === 0,
        isValidPositive: parsed > 0
      };
    }
  }

  return {
    value: 200,
    source: 'default',
    isExplicitZero: false,
    isValidPositive: true
  };
}

export function validateStartupEnvironment(env: NodeJS.ProcessEnv = process.env): StartupEnvCheck {
  const rawMode = (env.TRADING_MODE ?? 'PAPER').trim().toUpperCase();
  if (rawMode !== 'PAPER' && rawMode !== 'LIVE') {
    throw new StartupValidationError(
      `TRADING_MODE is "${rawMode}". Use PAPER (default) or LIVE. Refusing to start.`,
      2
    );
  }
  const tradingMode = rawMode as TradingMode;

  const rawAppMode = (env.APP_MODE || 'local').trim().toLowerCase();
  if (rawAppMode !== 'local') {
    throw new StartupValidationError('APP_MODE must be local', 2);
  }
  const appMode = rawAppMode as AppMode;

  const rawVenue = (env.EXCHANGE ?? '').trim().toLowerCase();
  if (rawVenue && rawVenue !== 'none' && !(EXCHANGES as readonly string[]).includes(rawVenue)) {
    throw new StartupValidationError(
      `EXCHANGE="${rawVenue}" is not one of none, ${EXCHANGES.join(', ')}`,
      2
    );
  }
  const venue = rawVenue && rawVenue !== 'none' ? (rawVenue as VenueId) : 'indodax';
  const network: Network | null = tradingMode === 'LIVE' ? 'mainnet' : null;

  if (network) {
    const reasons: string[] = [];
    const resolvedSafety = resolveEffectiveSafetyNet(env, network);
    if (resolvedSafety.value < 0) {
      reasons.push(`SAFETY_NET cannot be negative (resolved ${resolvedSafety.value} from ${resolvedSafety.source})`);
    }
    if (reasons.length > 0) {
      throw new StartupValidationError(
        `TRADING_MODE=${tradingMode} cannot start, refusing. Fix this with "mpu setup" or go back to PAPER with "mpu paper":\n  - ${reasons.join('\n  - ')}`,
        2
      );
    }
  }

  const rawN = env.OPEN_ORDERS_N;
  if (rawN !== undefined && rawN !== '') {
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new StartupValidationError('OPEN_ORDERS_N must be an integer from 1 to 100', 2);
    }
  }

  const rawPort = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT);
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new StartupValidationError('PORT must be a valid TCP port (0..65535)', 2);
  }

  const requestedHost = (env.HOST || '127.0.0.1').trim();
  const host = tradingMode === 'LIVE' ? '127.0.0.1' : requestedHost;

  return {
    tradingMode,
    appMode,
    host,
    port: rawPort,
    venue,
    network
  };
}

export interface ReplacementRuntimeHandle extends OfficeRuntime {
  readonly hub: OfficeEventHub;
  readonly roleRunner: RoleRunner;
  readonly cycleRunner: CycleRunner;
  readonly indodaxClient: IndodaxPublicClient;
  runIndodaxDebate(
    symbol: string,
    reason?: CycleReason,
    timeframe?: IndodaxTimeframe
  ): Promise<{ ok: boolean; message: string; cycleId?: string; verdict?: Verdict }>;
  updateState(mutator: (draft: OfficeState) => OfficeState | void): OfficeState;
  triggerCycle(
    symbol?: string,
    reason?: CycleReason
  ): Promise<{ ok: boolean; message: string; cycleId?: string }>;
  updateAutoSettings(patch: {
    on?: boolean;
    intervalMin?: number;
    maxHoldHours?: number;
    reportIntervalMin?: number;
    symbols?: string[];
    debateMode?: 'normal' | 'fast';
    n?: number;
  }): OfficeState;
  handleCommand(input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
    conversationId?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }>;
  readonly reportsService?: ReportsService;
  stop(): Promise<void>;
  runFastReflex?(): Promise<void>;
  reconfigureVenueMode?(mode: TradingMode, venue?: VenueId): Promise<{ ok: boolean; error?: string }>;
  syncVenueAccount?(): Promise<void>;
}

export interface ReplacementRuntimeOptions {
  providerProfiles?: Map<string, SavedProviderProfile>;
  version?: string;
  sessionId?: string | null;
  startedAt?: number;
  initialMode?: TradingMode;
  initialAppMode?: AppMode;
  dispatcher?: (input: OfficeCommand, state: OfficeState) => Promise<OfficeReply>;
  roleRunner?: RoleRunner;
  cycleRunner?: CycleRunner;
  indodaxClient?: IndodaxPublicClient;
  jevClient?: JevClient;
  env?: Record<string, string | undefined>;
  initialFinancial?: OfficeState['financial'];
  initialPositions?: Position[];
  venue?: OfficeState['venue'];
  venueAccount?: OfficeState['venueAccount'];
  runtimeIdentity?: OfficeState['runtimeIdentity'];
  accountState?: OfficeState['accountState'];
  reconfigureVenueMode?: (mode: TradingMode, venue?: VenueId) => Promise<{ ok: boolean; error?: string }>;
  syncVenueAccount?: () => Promise<void>;
  settings?: SettingsService;
  secrets?: SecretStore;
  chatService?: ChatService;
  reportsService?: ReportsService;
  initialKilled?: boolean;
}

export function ownerAllocationPerOrder(
  moneyTrade: number,
  n: number,
  orderSizePct?: number | null
): number {
  if (orderSizePct != null && Number.isFinite(orderSizePct) && orderSizePct > 0 && orderSizePct !== 1.5) {
    return Math.floor(((moneyTrade * orderSizePct) / 100) * 100) / 100;
  }
  const slots = Math.max(1, Math.min(4, Math.floor(n || 1)));
  if (slots > 0 && Number.isFinite(moneyTrade) && moneyTrade > 0) {
    return Math.floor((moneyTrade / slots) * 100) / 100;
  }
  return 0;
}

export function createReplacementRuntime(
  options: ReplacementRuntimeOptions = {}
): ReplacementRuntimeHandle {
  const hub = new OfficeEventHub();
  const env = options.env ?? process.env;
  let state = createInitialOfficeState({
    version: options.version,
    sessionId: options.sessionId,
    startedAt: options.startedAt
  });
  if (options.initialKilled) {
    state = { ...state, killed: true, auto: { ...state.auto, on: false } };
  }
  if (options.initialMode) {
    state = { ...state, mode: options.initialMode };
  }
  if (options.initialAppMode) {
    state = { ...state, appMode: options.initialAppMode };
  }
  if (options.initialFinancial) {
    state.financial = { ...state.financial, ...options.initialFinancial };
  }
  if (options.initialPositions) {
    state.paper.positions = options.initialPositions;
    const initialUpnl = options.initialPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    state.paper.unrealized = initialUpnl;
    state.paper.equity = state.paper.balance + initialUpnl;
  }
  if (options.venue) {
    state.venue = options.venue;
  }
  if (options.runtimeIdentity) {
    state.runtimeIdentity = options.runtimeIdentity;
  }
  if (options.venueAccount) {
    state.venueAccount = options.venueAccount;
  }
  if (options.accountState) {
    state.accountState = options.accountState;
  }

  const effectiveAgents = options.settings?.current().effective.agents;
  if (effectiveAgents) {
    for (const role of ROLE_IDS) {
      const conf = effectiveAgents[role];
      if (conf) {
        state.agents[role].provider = conf.provider;
        state.agents[role].model = conf.model;
        state.agents[role].configuredProvider = conf.provider;
        state.agents[role].configuredModel = conf.model;
        state.agents[role].invokedProvider = conf.provider;
        state.agents[role].invokedModel = conf.model;
        state.agents[role].executionStatus = 'IDLE';
        state.agents[role].lastLine = `Configured for ${conf.provider}/${conf.model}.`;
      }
    }
  }

  state.conversations = options.chatService?.listConversations() ?? [
    {
      id: 'office',
      title: 'Main Office',
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now(),
      messageCount: 0
    }
  ];

  const savedPaper = options.settings?.current().effective.paper;
  const savedTrading = options.settings?.current().effective.trading;

  const rawPaperBal = Number(savedPaper?.balance ?? env.PAPER_BALANCE ?? 1000);
  const finBal = options.initialFinancial?.balance?.value != null ? Number(options.initialFinancial.balance.value) : null;
  const initBal = state.mode !== 'PAPER' && finBal !== null && Number.isFinite(finBal) && finBal > 0
    ? finBal
    : (Number.isFinite(rawPaperBal) ? rawPaperBal : 1000);

  const resolvedSafety = resolveEffectiveSafetyNet(
    env,
    state.mode === 'LIVE' ? 'mainnet' : null,
    savedTrading?.safetyNet ?? savedPaper?.safetyNet
  );
  const initSafety = resolvedSafety.value >= 0 ? resolvedSafety.value : 200;

  const rawN = Math.trunc(Number(
    savedTrading?.maxPositions ??
    savedPaper?.n ??
    (state.mode === 'LIVE' ? env.MAINNET_DESK_OPEN_ORDERS_N : undefined) ??
    env.OPEN_ORDERS_N ??
    3
  ));
  const initN = Math.max(1, Number.isFinite(rawN) ? rawN : 3);

  const moneyTrade = Math.round(Math.max(0, initBal - initSafety) * 100) / 100;
  const orderSizePct = savedTrading?.orderSizePct === 1.5 ? null : (savedTrading?.orderSizePct ?? null);
  const perOrder = ownerAllocationPerOrder(moneyTrade, initN, orderSizePct);
  const canOpen = perOrder > 0 && (options.initialPositions ? options.initialPositions.length < initN : true);

  const rawLev = Math.trunc(Number(
    savedTrading?.maxLeverage ??
    (state.mode === 'LIVE' ? env.MAINNET_DESK_MAX_LEVERAGE : undefined) ??
    env.MAX_LEVERAGE ??
    5
  ));
  const initLev = Math.max(1, Math.min(100, Number.isFinite(rawLev) ? rawLev : 5));

  state.paper.balance = initBal;
  state.paper.safetyNet = initSafety;
  state.paper.n = initN;
  state.paper.maxLeverage = initLev;
  state.paper.moneyTrade = moneyTrade;
  state.paper.perOrder = perOrder;
  state.paper.orderSizePct = orderSizePct;
  state.paper.canOpen = canOpen;
  state.paper.equity = initBal;

  if (state.mode === 'PAPER') {
    state.accountState = {
      hasTradableCapital: canOpen,
      openPositionsCount: 0,
      maxPositions: initN,
      freeSlots: initN,
      occupiedSlots: 0,
      pendingOpenCount: 0,
      canOpenNewSlot: canOpen,
      mode: 'PAPER',
      source: 'simulated',
      status: 'AVAILABLE',
      observedAt: Date.now()
    };
  } else {
    const finAvail = state.venueAccount?.available ?? (options.initialFinancial?.availableBalance?.value != null
      ? Number(options.initialFinancial.availableBalance.value)
      : finBal);
    if (!state.venueAccount && finBal !== null) {
      state.venueAccount = {
        equity: finBal,
        available: finAvail ?? finBal,
        unrealized: 0,
        at: Date.now(),
        status: 'confirmed',
        positions: (options.initialPositions ?? []).map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty }))
      };
    }
    state.accountState = {
      hasTradableCapital: canOpen,
      openPositionsCount: options.initialPositions?.length ?? 0,
      maxPositions: initN,
      freeSlots: Math.max(0, initN - (options.initialPositions?.length ?? 0)),
      occupiedSlots: options.initialPositions?.length ?? 0,
      pendingOpenCount: 0,
      canOpenNewSlot: canOpen,
      mode: state.mode,
      source: state.venueAccount ? 'native_exchange' : 'reconciliation',
      status: 'AVAILABLE',
      observedAt: Date.now()
    };
  }

  const tvWidget = ['1', 'on', 'yes', 'true'].includes((env.TRADINGVIEW_WIDGET ?? '').trim().toLowerCase());
  const tvPass = (env.TRADINGVIEW_PASSPHRASE ?? '').trim();
  const tvWebhook = ['1', 'on', 'yes', 'true'].includes((env.TRADINGVIEW_WEBHOOK ?? '').trim().toLowerCase()) || Boolean(tvPass);
  const rawTvPrefix = (env.TRADINGVIEW_EXCHANGE_PREFIX ?? env.TRADINGVIEW_PREFIX ?? 'INDODAX').trim();
  const tvPrefix = rawTvPrefix.replace(/:+$/, '') || 'INDODAX';
  state.tradingview = {
    widget: tvWidget,
    prefix: tvPrefix,
    webhook: tvWebhook
  };

  const savedAuto = options.settings?.current().effective.auto;
  const savedWatchlist = options.settings?.current().effective.watchlist;
  if (savedAuto) {
    state.auto.on = savedAuto.on ?? state.auto.on;
    state.auto.intervalMin = savedAuto.intervalMin ?? state.auto.intervalMin;
    state.auto.maxHoldHours = savedAuto.maxHoldHours ?? state.auto.maxHoldHours;
    if (savedAuto.symbols && savedAuto.symbols.length > 0) {
      state.auto.symbols = [...savedAuto.symbols];
    }
    state.reportIntervalMin = savedAuto.reportIntervalMin ?? state.reportIntervalMin;
  }
  if (savedWatchlist && savedWatchlist.length > 0) {
    state.watchlist = [...savedWatchlist];
    if (!savedAuto?.symbols || savedAuto.symbols.length === 0) {
      state.auto.symbols = [...savedWatchlist];
    }
  }
  if (savedTrading && state.trading) {
    state.trading.profile = options.settings?.current().effective.tradingProfile ?? 'manual';
    state.trading.values = {
      ...state.trading.values,
      ...savedTrading,
      maxPositions: initN,
      safetyNet: initSafety,
      maxLeverage: initLev
    };
    state.paper.maxLeverage = state.trading.values.maxLeverage;
  }

  const snapshot = (): OfficeState => structuredClone(state);

  const updateState = (mutator: (draft: OfficeState) => OfficeState | void): OfficeState => {
    const next = structuredClone(state);
    const returned = mutator(next);
    state = returned ?? next;
    const currentSnap = structuredClone(state);
    hub.emit('state', currentSnap);
    return currentSnap;
  };

  const savedJev = options.settings?.current().effective.jev;
  const jevKey = (
    options.secrets?.getSecret('JEV_OPENROUTER_API_KEY') ??
    options.secrets?.getSecret('OPENROUTER_API_KEY') ??
    env.JEV_OPENROUTER_API_KEY ??
    env.OPENROUTER_API_KEY ??
    ''
  ).trim();
  const jevEnabled = savedJev?.enabled ?? (
    env.JEV_ENABLED !== undefined
      ? ['true', 'yes', '1', 'on'].includes((env.JEV_ENABLED ?? '').trim().toLowerCase())
      : true
  );
  const jevModel = (savedJev?.model && savedJev.model !== 'openai/gpt-5-mini' ? savedJev.model : null) || env.JEV_MODEL || 'typesafe/jev-1.14';
  const jevMode = savedJev?.mode || 'off';
  const jevAllowLive = savedJev?.allowLive ?? false;
  const hasJevKey = Boolean(options.secrets?.hasProviderKey('openrouter') || jevKey);

  state.jev = {
    ...state.jev,
    enabled: jevEnabled,
    provider: savedJev?.provider || 'openrouter',
    model: jevModel,
    mode: jevMode,
    configuredMode: jevMode,
    allowLive: jevAllowLive,
    health: !jevEnabled ? 'disabled' : (hasJevKey ? 'configured' : 'fallback_ready'),
    openrouterKeySet: Boolean(options.secrets?.hasProviderKey('openrouter') || env.OPENROUTER_API_KEY),
    dedicatedKeySet: Boolean(options.secrets?.getSecret('JEV_OPENROUTER_API_KEY') || env.JEV_OPENROUTER_API_KEY),
    configHealth: !jevEnabled ? 'off' : (hasJevKey ? 'configured' : 'fallback'),
    remoteHealth: 'unused'
  };

  const providerCaller = createOfficialProviderCaller();
  const jevClient =
    options.jevClient ??
    new JevClient({
      enabled: jevEnabled,
      apiKey: jevKey || null,
      model: jevModel,
      fallbackCaller: async (prompt, systemPrompt) => {
        try {
          const settingsSnap = options.settings?.current();
          const defaultAgent = settingsSnap?.effective?.agents?.lead;
          const upper = 'LEAD';
          const rawProv = (defaultAgent?.provider ?? env[`AGENT_${upper}_PROVIDER`] ?? env.DEFAULT_PROVIDER ?? '').trim().toLowerCase();
          const provider = rawProv || 'mock';
          const model = (defaultAgent?.model ?? env[`AGENT_${upper}_MODEL`] ?? env.DEFAULT_MODEL ?? 'default').trim();
          const envKey = PROVIDER_KEY_ENV[provider as keyof typeof PROVIDER_KEY_ENV];
          const secretKey = envKey ? (options.secrets?.getSecret(envKey) ?? env[envKey]) : undefined;
          const raw = await providerCaller({
            baseUrl: options.providerProfiles?.get(provider)?.baseUrl,
            apiProtocol: options.providerProfiles?.get(provider)?.protocol,
            cycleId: 'jev-fallback',
            role: 'lead',
            phase: 'final',
            taskAttempt: 1,
            turn: 1,
            provider,
            model,
            apiKey: secretKey ?? '',
            system: systemPrompt ?? 'You are Jev, market regime reviewer.',
            user: prompt,
            timeoutMs: 15_000
          });
          return raw;
        } catch {
          return null;
        }
      }
    });

  const resolveRoleAssignment = (role: RoleId, _version: number): ProviderAssignment => {
    const settingsSnap = options.settings?.current();
    const configuredAgent = settingsSnap?.effective?.agents?.[role];
    const defaultAgent = settingsSnap?.effective?.agents?.lead;

    const upper = role.toUpperCase();
    const rawProv = (configuredAgent?.provider ?? defaultAgent?.provider ?? env[`AGENT_${upper}_PROVIDER`] ?? env.DEFAULT_PROVIDER ?? '').trim().toLowerCase();
    const provider = rawProv && rawProv !== 'mock' ? rawProv : (rawProv === 'mock' ? 'mock' : 'unconfigured');
    const model = (configuredAgent?.model ?? defaultAgent?.model ?? env[`AGENT_${upper}_MODEL`] ?? env.DEFAULT_MODEL ?? 'unconfigured').trim();
    const reasoningEffort = configuredAgent?.reasoning ?? defaultAgent?.reasoning;

    const secretsMap = options.secrets?.readEnvMap() ?? env;
    const keyEnv = PROVIDER_KEY_ENV[provider as ApiProviderId] || `${provider.toUpperCase()}_API_KEY`;
    const apiKey = (secretsMap[keyEnv] ?? env[keyEnv] ?? '').trim();
    return {
      provider,
      model,
      apiKey: options.providerProfiles?.get(provider)?.apiKey || apiKey || null,
      baseUrl: options.providerProfiles?.get(provider)?.baseUrl,
      apiProtocol: options.providerProfiles?.get(provider)?.protocol,
      reasoningEffort: reasoningEffort ?? undefined,
      provenOsSandbox: true
    };
  };

  // Indodax cycles never reach host tools: those tools read other venues.
  const indodaxRoleRunner = options.roleRunner ?? new RoleRunner({ providerCaller, resolveAssignment: resolveRoleAssignment });

  const roleRunner =
    options.roleRunner ??
    new RoleRunner({
      providerCaller,
      resolveAssignment: resolveRoleAssignment
    });

  const cycleRunner =
    options.cycleRunner ??
    new CycleRunner({
      roleRunner,
      jevClient
    });

  const indodaxCycleRunner = options.cycleRunner ?? new CycleRunner({ roleRunner: indodaxRoleRunner, jevClient });

  const indodaxClient = options.indodaxClient ?? new IndodaxPublicClient();

  /** What an agent chat sees of the desk: Indodax spot only, plus fresh market data for the pair in question. */
  const buildIndodaxChatContext = async (symbolHint?: string) => {
    const snap = snapshot();
    const symbol = (symbolHint ?? snap.debate?.symbol)?.toUpperCase();
    let market: Record<string, unknown> | null = null;
    if (symbol) {
      try {
        const summary = indodaxPromptSummary(await buildIndodaxContext(indodaxClient, symbol, '4h'));
        market = { ...summary, candles: summary.candles.slice(-12) };
      } catch (error) {
        market = { unavailable: `Indodax data for ${symbol} is unavailable: ${error instanceof IndodaxDataError ? error.message : 'request failed'}` };
      }
    }
    const trading = options.settings?.current().effective.trading;
    const verdictView = (v: Verdict) => ({ symbol: v.symbol, action: v.action, reason: v.reason, at: v.at });
    return {
      venue: 'Indodax spot',
      note: 'Indodax spot is the only venue. Prices are in the pair quote currency (IDR or USDT), which are never converted.',
      mode: snap.mode,
      killSwitch: snap.killed ? 'ON' : 'OFF',
      activePair: symbol ?? null,
      market,
      profile: {
        defaultStopPct: trading?.defaultStopPct ?? null,
        takeProfitPct: trading?.takeProfitPct ?? null,
        dailyLossLimitPct: snap.trading?.values?.dailyLossLimitPct ?? null,
        minEntryConfidencePct: trading?.minEntryConfidencePct ?? null
      },
      lastVerdict: snap.lastVerdict ? verdictView(snap.lastVerdict) : null,
      recentVerdicts: (snap.verdicts ?? []).slice(0, 5).map(verdictView)
    };
  };

  const updateAutoSettings = (patch: { debateMode?: 'normal' | 'fast'; [key: string]: unknown }): OfficeState => {
    updateState((draft) => { if (patch.debateMode !== undefined) draft.debateMode = patch.debateMode as 'normal' | 'fast'; });
    hub.emit('state', snapshot());
    return snapshot();
  };

  const debateCallbacks = (targetSymbol: string, spokenRolesInCurrentCycle: Set<RoleId>) => ({
        onRoleStart: (task: RoleTask) => {
          const assignment = options.settings?.current().effective.agents[task.role as RoleId];
          updateState((draft) => {
            const agentView = draft.agents[task.role as RoleId];
            if (agentView) {
              agentView.status =
                task.phase === 'observe' ? 'reading' : task.phase === 'challenge' ? 'arguing' : 'thinking';
              if (assignment) {
                agentView.provider = assignment.provider;
                agentView.model = assignment.model;
                agentView.configuredProvider = assignment.provider;
                agentView.configuredModel = assignment.model;
                agentView.invokedProvider = assignment.provider;
                agentView.invokedModel = assignment.model;
              }
              agentView.lastAttemptAt = Date.now();
              agentView.executionStatus = task.phase === 'observe' ? 'OBSERVING' : 'THINKING';
            }
            if (draft.debate) {
              draft.debate.phase =
                task.phase === 'challenge'
                  ? 'round 1'
                  : task.phase === 'observe'
                  ? 'gathering'
                  : task.role === 'risk'
                  ? 'risk gate'
                  : task.role === 'execution'
                  ? 'execution review'
                  : task.role === 'lead'
                  ? 'verdict'
                  : task.phase;
              if (task.phase === 'challenge') {
                draft.debate.round = 1;
              }
            }
          });
          hub.emit('status', { agent: task.role, status: snapshot().agents[task.role as RoleId]?.status ?? 'thinking' });
          hub.emit('state', snapshot());
        },
        onRoleResult: (res: RoleResult) => {
          spokenRolesInCurrentCycle.add(res.role);
          const at = Date.now();
          const reasoning =
            res.reasoning ?? (res.errorReason ? `Failure: ${res.errorReason}` : `Completed with stance ${res.stance ?? 'HOLD'}`);
          const roomMsg = {
            id: `room-${at}-${res.role}`,
            conversationId: 'office',
            at,
            from: res.role,
            to: 'owner' as const,
            text: reasoning,
            symbol: targetSymbol
          };

          const fightHolder: {
            current?: {
              from: RoleId;
              to: RoleId;
              intensity: number;
              punches: number;
              at: number;
            };
          } = {};

          updateState((draft) => {
            draft.agents[res.role].status = 'idle';
            if (res.provider) {
              draft.agents[res.role].provider = res.provider;
              draft.agents[res.role].invokedProvider = res.provider;
            }
            if (res.model) {
              draft.agents[res.role].model = res.model;
              draft.agents[res.role].invokedModel = res.model;
            }
            if (res.status === 'completed') {
              draft.agents[res.role].lastSuccessAt = at;
              draft.agents[res.role].executionStatus = 'IDLE';
            } else {
              draft.agents[res.role].lastError = res.errorReason ?? res.status;
              draft.agents[res.role].executionStatus = 'ERROR';
            }
            if (res.stance) draft.agents[res.role].stance = res.stance as Stance;
            if (res.confidence?.value !== null && res.confidence?.value !== undefined) {
              draft.agents[res.role].confidence =
                res.confidence.scale === 'probability_0_1'
                  ? Math.round(res.confidence.value * 100)
                  : Math.round(res.confidence.value);
            }
            draft.agents[res.role].lastLine = reasoning.slice(0, 160);

            if (!draft.roomHistory) draft.roomHistory = [];
            draft.roomHistory.push(roomMsg);
            draft.roomHistory = draft.roomHistory.slice(-100);

            if (!draft.logs) draft.logs = [];
            draft.logs.push({
              id: `log-${at}-${res.role}`,
              conversationId: 'office',
              at,
              kind: 'speech',
              agent: res.role,
              text: `[${res.role.toUpperCase()}] ${res.stance ?? 'HOLD'} (${res.confidence?.value ?? '-'}): ${reasoning}`
            });
            draft.logs = draft.logs.slice(-500);

            const spokenAgents = Object.values(draft.agents).filter((a) => spokenRolesInCurrentCycle.has(a.id as RoleId));
            const bull = spokenAgents.filter((a) => (a.stance as string) === 'LONG').map((a) => a.id);
            const bear = spokenAgents.filter((a) => (a.stance as string) === 'SHORT').map((a) => a.id);
            const closers = spokenAgents.filter((a) => (a.stance as string) === 'CLOSE').map((a) => a.id);
            const neutral = spokenAgents.filter((a) => (a.stance as string) !== 'LONG' && (a.stance as string) !== 'SHORT' && (a.stance as string) !== 'CLOSE').map((a) => a.id);
            const activeDirectional = bull.length + bear.length;
            let disagreement = 0;
            let fightFrom: RoleId | null = null;
            let fightTo: RoleId | null = null;

            if (bull.length > 0 && bear.length > 0) {
              disagreement = Math.min(1, (Math.min(bull.length, bear.length) * 2) / Math.max(2, activeDirectional));
              fightFrom = bull[Math.floor(Math.random() * bull.length)]!;
              fightTo = bear[Math.floor(Math.random() * bear.length)]!;
            } else if (closers.length > 0 && activeDirectional > 0) {
              const directionalCamp = bull.length >= bear.length ? bull : bear;
              disagreement = Math.min(1, (Math.min(closers.length, directionalCamp.length) * 2) / Math.max(2, closers.length + directionalCamp.length));
              fightFrom = directionalCamp[Math.floor(Math.random() * directionalCamp.length)]!;
              fightTo = closers[Math.floor(Math.random() * closers.length)]!;
            }

            if (draft.debate) {
              draft.debate.camps = { bull, bear, neutral: [...closers, ...neutral] };
              draft.debate.disagreement = disagreement;
            }

            if (disagreement >= (draft.fightThreshold ?? 0.35) && fightFrom && fightTo) {
              const punches = 1 + Math.round(disagreement * 3);
              draft.agents[fightFrom].status = 'fighting';
              draft.agents[fightTo].status = 'fighting';
              fightHolder.current = {
                from: fightFrom,
                to: fightTo,
                intensity: Math.min(1, disagreement),
                punches,
                at
              };
              draft.logs.push({
                id: `fight-${at}-${fightFrom}`,
                conversationId: 'office',
                at,
                kind: 'fight',
                agent: fightFrom,
                text: `${fightFrom.toUpperCase()} clashes with ${fightTo.toUpperCase()} over ${targetSymbol} (heat ${Math.round(disagreement * 100)}%)`
              });
            }
          });

          if (fightHolder.current) {
            hub.emit('fight', fightHolder.current);
          }

          if (options.chatService) {
            void options.chatService.recordMessage({
              messageId: roomMsg.id,
              conversationId: 'office',
              role: res.role,
              text: reasoning
            }).catch(() => {});
          }

          hub.emit('speech', {
            id: `speech-${at}-${res.role}`,
            agent: res.role,
            text: reasoning,
            done: true,
            example: false,
            at
          });
          hub.emit('room', roomMsg);
          hub.emit('log', {
            at,
            kind: 'debate',
            agent: res.role,
            text: `[${res.role.toUpperCase()}] ${res.stance ?? 'HOLD'} (${res.confidence?.value ?? '-'}): ${reasoning}`
          });
          hub.emit('meter', { disagreement: snapshot().debate?.disagreement ?? 0 });
          hub.emit('state', snapshot());
        }
  });

  const triggerCycle = async (
    symbol?: string,
    reason: CycleReason = 'owner'
  ): Promise<{ ok: boolean; message: string; cycleId?: string }> => {
    if (!symbol) return { ok: false, message: 'Choose an Indodax pair, for example BTCIDR.' };
    return runIndodaxDebate(symbol, reason);
  };

  const extractCleanAgentReply = (raw: string): string => {
    if (!raw) return '';
    const trimmed = raw.trim();
    let candidate = trimmed;
    if (candidate.startsWith('```')) {
      candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.reply === 'string' && parsed.reply) return parsed.reply;
          if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
          if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
          if (typeof parsed.content === 'string' && parsed.content) return parsed.content;
        }
      } catch {
        const fieldMatch = candidate.match(/"(?:reply|text|message|content)"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"|\}\s*$)/i);
        if (fieldMatch && fieldMatch[1]) {
          return fieldMatch[1].replace(/\\"/g, '"');
        }
      }
    }
    return raw;
  };

  const handleCommand = async (input: {
    text: string;
    agent?: string;
    clientRequestId?: string;
    conversationId?: string;
    symbol?: string;
  }): Promise<{ ok: boolean; command?: string; reply?: string; error?: string }> => {
    let raw = input.text.trim();
    if (!raw) return { ok: false, error: 'empty command' };
    let cmd = raw.toLowerCase();
    let cleanCmd = cmd.replace(/^\//, '');

    if (/^(matikan|berhenti)\b/i.test(cleanCmd)) {
      cleanCmd = cleanCmd.replace(/^(matikan|berhenti)\b/i, 'kill');
      raw = raw.replace(/^(matikan|berhenti)\b/i, 'kill');
    }

    const isSlash = raw.startsWith('/');
    const isDirectOp = /^(kill|unkill|analyze|debate|status|report)\b/i.test(cleanCmd);
    const isOperational = isSlash || isDirectOp;

    const toAll = /^@all\s+/i.test(raw);
    const targetRole = input.agent ? resolveCanonicalRole(input.agent) : null;

    const isAsk = /^(?:ask|chat|tanya)\b/i.test(cleanCmd);
    let askPrompt = '';
    let askRole: RoleId | null = targetRole;
    let askToAll = toAll;

    if (isAsk) {
      const remainder = cleanCmd.replace(/^(?:ask|chat|tanya)\s*/i, '').trim();
      if (!remainder) {
        return {
          ok: false,
          command: 'ask',
          error: 'Usage: /ask <question> or /ask <agent> <question>'
        };
      }
      if (/^@?all\b/i.test(remainder)) {
        askToAll = true;
        askPrompt = remainder.replace(/^@?all\s*/i, '').trim();
      } else {
        const words = remainder.split(/\s+/);
        const twoWordRole = words.length >= 2 ? resolveCanonicalRole(`${words[0]} ${words[1]}`) : null;
        if (twoWordRole) {
          askRole = twoWordRole;
          askPrompt = words.slice(2).join(' ').trim();
        } else {
          const oneWordRole = resolveCanonicalRole(words[0]);
          if (oneWordRole) {
            askRole = oneWordRole;
            askPrompt = words.slice(1).join(' ').trim();
          } else {
            askRole = targetRole ?? 'lead';
            askPrompt = remainder;
          }
        }
      }
      if (!askPrompt) {
        return {
          ok: false,
          command: 'ask',
          error: 'Usage: /ask <question> or /ask <agent> <question>'
        };
      }
    } else if (!isOperational && (targetRole || toAll)) {
      askPrompt = toAll ? raw.replace(/^@all\s+/i, '') : raw;
      askRole = targetRole;
      askToAll = toAll;
    }

    if (askPrompt) {
      const roles: RoleId[] = askToAll ? [...ROLE_IDS] : [askRole ?? 'lead'];
      const prompt = askPrompt;
      const conversationId = input.conversationId || 'office';
      if (snapshot().mode !== 'PAPER' && options.syncVenueAccount) {
        try {
          await options.syncVenueAccount();
        } catch {}
      }
      const deskSnapshot = await buildIndodaxChatContext(input.symbol);
      const deskContext = `Live desk snapshot (informational only; not an execution command).\n${JSON.stringify(deskSnapshot, null, 2)}`;
      const ownerAt = Date.now();
      const ownerMessageId = randomUUID();

      updateState(draft => {
        if (!draft.roomHistory) draft.roomHistory = [];
        draft.roomHistory.push({
          id: ownerMessageId,
          conversationId,
          at: ownerAt,
          from: 'owner',
          to: askToAll ? 'all' : roles[0],
          text: prompt
        });
        for (const role of roles) {
          const chatList = draft.chats[role] ?? [];
          chatList.push({
            from: 'user',
            text: prompt,
            at: ownerAt,
            conversationId,
            clientRequestId: input.clientRequestId
          });
          draft.chats[role] = chatList.slice(-50);
        }
        draft.roomHistory = draft.roomHistory.slice(-100);
      });

      if (options.chatService) {
        void options.chatService.recordMessage({
          messageId: ownerMessageId,
          conversationId,
          clientRequestId: input.clientRequestId,
          role: 'owner',
          text: prompt
        });
      }

      const outcomes = await Promise.allSettled(roles.map(async role => {
        const answer = await indodaxRoleRunner.chat({
          cycleId: `chat-${randomUUID()}`,
          role,
          prompt,
          deskContext,
          configVersion: options.settings?.current().activeVersion ?? 1
        });
        return { role, answer: extractCleanAgentReply(String(answer)), rawAnswer: String(answer) };
      }));
      const results = outcomes.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
      const failures = outcomes.length - results.length;
      updateState(draft => {
        if (!draft.roomHistory) draft.roomHistory = [];
        for (const { role, answer } of results) {
          const chatList = draft.chats[role] ?? [];
          chatList.push(
            { from: role, text: answer, at: Date.now(), conversationId }
          );
          draft.chats[role] = chatList.slice(-50);
          draft.roomHistory.push({ id: randomUUID(), conversationId, at: Date.now(), from: role, to: 'owner', text: answer });
        }
        draft.roomHistory = draft.roomHistory.slice(-100);
      });
      if (options.chatService) {
        for (const { role, answer } of results) {
          void options.chatService.recordMessage({
            conversationId,
            role,
            text: answer
          });
        }
      }

      for (const { rawAnswer } of results) {
        if (!rawAnswer) continue;
        try {
          const parsed = JSON.parse(rawAnswer);
          if (parsed && typeof parsed === 'object' && typeof parsed.commandToExecute === 'string' && parsed.commandToExecute.trim()) {
            void handleCommand({ text: parsed.commandToExecute.trim(), conversationId }).catch(console.error);
          }
        } catch {
          const match = rawAnswer.match(/"commandToExecute"\s*:\s*"([^"]+)"/i);
          if (match && match[1]) {
            void handleCommand({ text: match[1].trim(), conversationId }).catch(console.error);
          }
        }
      }
      const replyFormatted = results
        .map(({ role, answer }) => (roles.length === 1 ? `[${role.toUpperCase()}]: ${answer}` : `${role}: ${answer}`))
        .join('\n\n');
      return {
        ok: failures === 0,
        command: isAsk ? 'ask' : 'chat',
        reply: replyFormatted + (failures ? `\n${failures} agent(s) failed to reply.` : ''),
        error: failures ? `${failures} agent(s) failed to reply.` : undefined
      };
    }

    if (cleanCmd.startsWith('analyze ') || cleanCmd.startsWith('debate ')) {
      const sym = raw.split(/\s+/)[1]?.toUpperCase();
      if (!sym) {
        return { ok: false, error: 'Symbol required for analyze command' };
      }
      const snap = snapshot();
      if (snap.killed) {
        return { ok: false, error: 'Kill switch is ON. Release it first.' };
      }
      if (snap.auto.running) {
        return { ok: false, error: `A debate is already in progress for ${snap.debate?.symbol ?? 'symbol'}` };
      }
      try {
        await resolveIndodaxSymbol(indodaxClient, sym);
      } catch (error) {
        return { ok: false, error: error instanceof IndodaxDataError ? error.message : 'Indodax data is unavailable.' };
      }
      void runIndodaxDebate(sym, 'owner')
        .then((res) => { if (!res.ok) hub.emit('log', { at: Date.now(), kind: 'system', text: `Debate for ${sym} did not run: ${res.message}` }); })
        .catch(console.error);
      return { ok: true, command: 'analyze', reply: `Starting debate for ${sym}...` };
    }

    if (cleanCmd === 'status') {
      const snap = snapshot();
      const open = deskOpenPnl({
        mode: snap.mode,
        paperUnrealized: snap.paper.unrealized,
        venueUnrealized: snap.venueAccount?.unrealized ?? null,
        venueStatus: snap.venueAccount?.status ?? null
      });
      const realized = snap.financial.realizedPnl.availability === 'AVAILABLE' ? snap.financial.realizedPnl.value : null;
      return {
        ok: true,
        command: 'status',
        reply: formatStatusCard({
          mode: snap.mode,
          venue: snap.venue?.name ?? null,
          killed: snap.killed,
          paused: snap.paused,
          autoOn: snap.auto.on,
          autoIntervalMin: snap.auto.intervalMin,
          equity: snap.financial.equity.value ?? snap.paper.equity,
          balance: snap.financial.balance.value ?? snap.paper.balance,
          safetyNet: snap.paper.safetyNet,
          moneyTrade: snap.paper.moneyTrade,
          perOrder: snap.paper.perOrder,
          openPnl: open.value,
          pnlSource: open.source,
          realized,
          positions: snap.paper.positions.length,
          slots: snap.paper.n,
          freeSlots: snap.accountState?.freeSlots ?? Math.max(0, snap.paper.n - snap.paper.positions.length),
          dailyLossHit: snap.dailyLoss?.hit ?? false,
          dailyLossLimitPct: snap.trading?.values?.dailyLossLimitPct ?? snap.dailyLoss?.limitPct ?? 10
        })
      };
    }

    if (cleanCmd === 'help') {
      return { ok: true, command: 'help', reply: HELP_TEXT };
    }

    if (cleanCmd === 'report' || cleanCmd === 'report now' || cleanCmd === 'desk report' || /^report\s+now\b/i.test(cleanCmd)) {
      const snap = snapshot();
      const open = deskOpenPnl({
        mode: snap.mode,
        paperUnrealized: snap.paper.unrealized,
        venueUnrealized: snap.venueAccount?.unrealized ?? null,
        venueStatus: snap.venueAccount?.status ?? null
      });
      const realized = snap.financial.realizedPnl.availability === 'AVAILABLE' ? snap.financial.realizedPnl.value : null;
      return {
        ok: true,
        command: 'report',
        reply: formatDeskReportText({
          at: Date.now(),
          mode: snap.mode,
          venue: snap.venue?.name ?? null,
          killed: snap.killed,
          equity: snap.financial.equity.value ?? snap.paper.equity,
          balance: snap.financial.balance.value ?? snap.paper.balance,
          safetyNet: snap.paper.safetyNet,
          moneyTrade: snap.paper.moneyTrade,
          dailyLossHit: snap.dailyLoss?.hit ?? false,
          dailyLossLimitPct: snap.trading?.values?.dailyLossLimitPct ?? snap.dailyLoss?.limitPct ?? 10,
          positions: snap.paper.positions ?? [],
          openPnl: open.value,
          pnlSource: open.source,
          realized,
          autoOn: snap.auto.on,
          autoIntervalMin: snap.auto.intervalMin
        })
      };
    }

    if (cleanCmd === 'scorecard' || cleanCmd === 'scores') {
      const snap = snapshot();
      const sc = snap.scorecard ?? [];
      return { ok: true, command: 'scorecard', reply: formatScorecardCard(sc) };
    }

    if (cleanCmd === 'lessons' || cleanCmd === 'learnings') {
      const snap = snapshot();
      const ls = snap.lessons ?? [];
      return { ok: true, command: 'lessons', reply: formatLessonsCard(ls.slice(-5)) };
    }

    if (cleanCmd === 'kill' || cleanCmd.startsWith('kill')) {
      const confirm = /confirm|yes/i.test(raw);
      if (!confirm) {
        return {
          ok: true,
          command: 'kill',
          reply: 'This flattens every position and stops the desk until the local Owner releases it with the Office OFF button or npm run unkill -- --yes. Send "/kill confirm" to do it.'
        };
      }
      const res = await dispatch({ kind: 'kill', actor: 'owner_channel' });
      return {
        ok: res.ok,
        command: 'kill',
        reply: safe(`KILL SWITCH ON. ${res.message}. Release only on the desk computer: the local Office OFF button or npm run unkill -- --yes.`)
      };
    }

    if (cleanCmd === 'unkill' || cleanCmd === 'release') {
      const res = await dispatch({ kind: 'unkill', actor: 'local_owner' });
      return {
        ok: res.ok,
        command: 'unkill',
        reply: res.ok
          ? 'Local halt latch released; Auto remains OFF. Send /resume or check Office to resume trading.'
          : res.message
      };
    }

    if (cleanCmd === 'mode') {
      const snap = snapshot();
      return {
        ok: true,
        command: 'mode',
        reply: [
          '🧭 DESK MODE & VENUE',
          '────────',
          `Mode: ${snap.mode}`,
          `Venue: ${snap.venue?.label ?? snap.venue?.name ?? 'indodax'}`,
          `Trading: ${snap.killed ? 'STOPPED (kill switch)' : snap.paused ? 'PAUSED' : 'ACTIVE'}`,
          `Auto: ${snap.auto.on ? `ON (every ${snap.auto.intervalMin}m)` : 'OFF'}`
        ].join('\n')
      };
    }

    if (cleanCmd === 'health') {
      const snap = snapshot();
      const venueStatus = snap.mode === 'PAPER' ? 'confirmed' : (snap.venueAccount?.status ?? 'pending');
      return {
        ok: true,
        command: 'health',
        reply: [
          '🩺 DESK HEALTH',
          '────────',
          `Backend: OK (mode ${snap.mode})`,
          `Venue Connection: ${venueStatus}`,
          `Auto Loop: ${snap.auto.running ? 'Running debate' : snap.auto.on ? 'Idle (scheduled)' : 'OFF'}`,
          `Kill Switch: ${snap.killed ? 'ENGAGED' : 'CLEAR'}`,
          `Daily Loss Stop: ${snap.dailyLoss?.hit ? 'HIT' : 'CLEAR'}`
        ].join('\n')
      };
    }

    if (cleanCmd === 'pause') {
      updateState((d) => { d.paused = true; });
      return { ok: true, command: 'pause', reply: 'Desk paused.' };
    }
    if (cleanCmd === 'resume') {
      updateState((d) => { d.paused = false; });
      return { ok: true, command: 'resume', reply: 'Desk resumed.' };
    }

    return {
      ok: false,
      command: cmd,
      error: `Unsupported command: "${safe(raw)}". Type "help" for available commands.`
    };
  };

  const stop = async (): Promise<void> => {
  };

  const dispatch = async (input: OfficeCommand): Promise<OfficeReply> => {
    if (options.dispatcher) {
      return options.dispatcher(input, snapshot());
    }
    if (input.kind === 'kill') {
      if (env.KILL_SWITCH_FILE) {
        try {
          writeKill(env.KILL_SWITCH_FILE, { at: Date.now(), reason: 'Owner kill switch', source: 'office' });
        } catch {}
      }
      updateState((draft) => {
        draft.killed = true;
        draft.auto.on = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch engaged.'
      };
    }
    if (input.kind === 'unkill') {
      if (input.actor !== 'local_owner') {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          message: 'Only local Owner may release the kill switch.'
        };
      }
      const killFile = env.KILL_SWITCH_FILE;
      if (killFile) {
        try { clearKill(killFile); } catch {}
        if (readKill(killFile)) {
          return {
            ok: false,
            code: 'REJECTED',
            message: 'Release failed: persisted halt latch remains active.'
          };
        }
      }
      updateState((draft) => {
        draft.killed = false;
      });
      return {
        ok: true,
        code: 'OK',
        message: 'Local halt latch released; Auto remains OFF.'
      };
    }
    if (input.kind === 'command') {
      const res = await handleCommand({
        text: input.text ?? '',
        agent: input.agent,
        clientRequestId: input.clientRequestId
      });
      return {
        ok: res.ok,
        code: res.ok ? 'OK' : 'REJECTED',
        message: res.reply ?? res.error ?? 'Command executed'
      };
    }

    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: `Runtime service for "${input.kind}" is not configured yet; refusing to fabricate results.`
    };
  };

  let indodaxPaperCycleActive = false;

  const indodaxPolicy = (current: number, hasPosition: boolean): CyclePolicy => {
    const trading = options.settings?.current().effective.trading;
    const stopPct = trading?.defaultStopPct ?? 5;
    const tpPct = trading?.takeProfitPct ?? stopPct * (trading?.takeProfitR ?? 2);
    return {
      minEntryConfidencePct: trading?.minEntryConfidencePct ?? 65,
      requireTwoOfThreeAnalysts: true,
      maxLeverage: 1,
      defaultStopPct: stopPct,
      takeProfitPct: tpPct,
      takeProfitR: trading?.takeProfitR ?? 2,
      maxPositions: 1,
      supportsLimitGtc: false,
      hasPosition,
      positionSide: hasPosition ? 'LONG' : undefined,
      profileBaselineStopPrice: { long: (current * (1 - stopPct / 100)).toFixed(8), short: null },
      profileBaselineTpPrice: { long: (current * (1 + tpPct / 100)).toFixed(8), short: null }
    };
  };

  /** The one place an Indodax agent cycle runs: Office debate, `analyze` and the PAPER session all end up here. */
  const runIndodaxCycle = async (input: {
    symbol: string;
    accountRef: string;
    marketSummary: Record<string, unknown>;
    hasPosition: boolean;
    signal: AbortSignal;
    reason: CycleReason;
    callbacks?: Pick<ReturnType<typeof debateCallbacks>, 'onRoleStart' | 'onRoleResult'>;
  }) => {
    const snap = snapshot();
    if (input.signal.aborted || snap.killed || snap.mode !== 'PAPER' || snap.auto.running || indodaxPaperCycleActive) return null;
    const current = Number(input.marketSummary.ask ?? input.marketSummary.last ?? 0);
    if (!Number.isFinite(current) || current <= 0) return { out: null, failures: undefined };
    const assignments = options.settings?.current().effective.agents;
    indodaxPaperCycleActive = true;
    updateState((draft) => { draft.auto.running = true; });
    try {
      const out = await indodaxCycleRunner.run({
        reason: input.reason,
        accountRef: input.accountRef,
        symbol: input.symbol,
        evidenceId: randomUUID(),
        configVersion: options.settings?.current().activeVersion ?? 1,
        policy: indodaxPolicy(current, input.hasPosition),
        marketSummary: input.marketSummary,
        signal: input.signal,
        routeForRole: (role) => assignments?.[role]?.route ?? 'LOCAL',
        ...input.callbacks
      });
      const failures = (out.roleResults ?? [])
        .filter((r) => r.status !== 'completed')
        .map((r) => `${r.role}: ${r.errorReason ?? r.status}`)
        .join('; ');
      return { out, failures: failures || undefined };
    } finally {
      indodaxPaperCycleActive = false;
      updateState((draft) => {
        draft.auto.running = false;
        draft.auto.lastCycleAt = Date.now();
      });
    }
  };

  const runIndodaxDebate = async (
    symbolInput: string,
    reason: CycleReason = 'owner',
    timeframe: IndodaxTimeframe = '4h'
  ): Promise<{ ok: boolean; message: string; cycleId?: string; verdict?: Verdict }> => {
    const snap = snapshot();
    if (snap.killed) return { ok: false, message: 'Kill switch is ON. Trading is halted.' };
    if (snap.mode !== 'PAPER') return { ok: false, message: 'Indodax debates run in PAPER mode.' };
    if (snap.auto.running || indodaxPaperCycleActive) return { ok: false, message: `A cycle is already running for ${snap.debate?.symbol ?? 'a pair'}` };
    let context: IndodaxContext;
    try {
      const pair = await resolveIndodaxSymbol(indodaxClient, symbolInput);
      context = await buildIndodaxContext(indodaxClient, pair.symbol, timeframe);
    } catch (error) {
      return { ok: false, message: error instanceof IndodaxDataError ? error.message : 'Indodax data is unavailable.' };
    }
    const symbol = context.symbol;
    const cycleId = `cycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const spoken = new Set<RoleId>();
    updateState((draft) => {
      draft.debate = {
        id: `debate-${Date.now()}`,
        symbol,
        phase: 'opening',
        mode: draft.debateMode ?? 'normal',
        round: 1,
        disagreement: 0,
        weighted: 0,
        camps: { bull: [], bear: [], neutral: [] }
      };
      for (const role of ROLE_IDS) {
        draft.agents[role].status = 'reading';
        draft.agents[role].stance = 'NEUTRAL';
        draft.agents[role].confidence = null;
        draft.agents[role].lastLine = '';
      }
    });
    hub.emit('debate', snapshot().debate);
    hub.emit('log', { at: Date.now(), kind: 'debate', text: `Started Indodax deliberation for ${symbol} (${timeframe}, reason: ${reason})` });

    try {
      const res = await runIndodaxCycle({
        symbol,
        accountRef: 'indodax-paper-local',
        marketSummary: { ...indodaxPromptSummary(context), mode: 'PAPER' },
        hasPosition: false,
        signal: new AbortController().signal,
        reason,
        callbacks: debateCallbacks(symbol, spoken)
      });
      if (!res?.out) return { ok: false, message: 'The debate could not start. Check the kill switch and any running cycle.', cycleId };
      const verdict = toIndodaxVerdict(res.out, symbol);
      const agents = Object.values(snapshot().agents);
      const bull = agents.filter((a) => (a.stance as string) === 'LONG').map((a) => a.id);
      const bear = agents.filter((a) => (a.stance as string) === 'CLOSE').map((a) => a.id);
      const neutral = agents.filter((a) => (a.stance as string) !== 'LONG' && (a.stance as string) !== 'CLOSE').map((a) => a.id);
      const disagreement = bull.length > 0 && bear.length > 0 ? Math.min(1, (Math.min(bull.length, bear.length) * 2) / Math.max(2, bull.length + bear.length)) : 0;
      const incomplete = res.out.status !== 'completed';
      const record: Verdict = {
        id: `verdict-${Date.now()}`,
        symbol,
        action: verdict.action,
        riskDecision: incomplete ? 'INCOMPLETE' : verdict.action === 'HOLD' ? 'HOLD' : 'APPROVE',
        executed: false,
        reason: incomplete
          ? (res.failures ? `Deliberation incomplete (${res.failures})` : 'Deliberation incomplete. No order placed.')
          : verdict.rejectionReason ?? (verdict.action === 'OPEN_LONG'
            ? `Advice only: buy with stop ${verdict.thesis?.stop}${verdict.thesis?.tp ? `, take profit ${verdict.thesis.tp}` : ''}. Start a PAPER session to simulate it.`
            : verdict.action === 'CLOSE' ? 'Advice only: sell the holding' : 'Consensus synthesis reached HOLD'),
        disagreement,
        camps: { bull, bear, neutral },
        example: false,
        at: Date.now()
      };
      updateState((draft) => {
        draft.verdicts = [record, ...draft.verdicts.slice(0, 49)];
        draft.lastVerdict = record;
        if (!draft.logs) draft.logs = [];
        draft.logs.push({ id: `log-${Date.now()}-verdict`, conversationId: 'office', at: Date.now(), kind: 'verdict', text: `[VERDICT] ${record.action} on ${symbol}: (${record.reason})` });
        draft.logs = draft.logs.slice(-500);
        draft.lastCycle = {
          symbol,
          durationMs: Date.now() - Number(cycleId.split('-')[1] || Date.now()),
          stage: res.out!.status,
          verdict: record.action,
          noTradeReason: record.reason,
          executionStatus: null,
          reasonCode: record.riskDecision,
          outcome: record.action
        };
      });
      hub.emit('verdict', record);
      hub.emit('state', snapshot());
      return { ok: true, message: `Cycle ${cycleId} finished with verdict ${record.action}`, cycleId, verdict: record };
    } catch (error) {
      return { ok: false, message: `Cycle failed: ${(error as Error).message}`, cycleId };
    }
  };

  return {
    hub,
    roleRunner,
    cycleRunner,
    indodaxClient,
    runIndodaxDebate,
    snapshot,
    updateState,
    triggerCycle,
    runIndodaxPaperCycle: async (input: {
      symbol: string;
      accountRef: string;
      marketSummary: Record<string, unknown>;
      hasPosition: boolean;
      signal: AbortSignal;
    }) => {
      const res = await runIndodaxCycle({ ...input, reason: 'schedule' });
      if (!res) return { status: 'cancelled' as const, verdict: null };
      if (!res.out) return { status: 'incomplete' as const, verdict: null };
      return { status: res.out.status, verdict: toIndodaxVerdict(res.out, input.symbol), failures: res.failures, providerCalls: res.out.providerCalls };
    },
    updateAutoSettings,
    handleCommand,
    reportsService: options.reportsService,
    stop,
    dispatch,
    reconfigureVenueMode: options.reconfigureVenueMode,
    syncVenueAccount: options.syncVenueAccount
  };
}

export async function startReplacementServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ server: HttpServer; runtime: ReplacementRuntimeHandle } | null> {
  registerDiagnosticSecrets(env);
  let startup: StartupEnvCheck;
  try {
    startup = validateStartupEnvironment(env);
  } catch (error) {
    console.error(`[trading-agent-mpu-gandring] ${safe((error as Error).message)}`);
    recordDiagnostic({
      source: 'startup',
      category: 'SESSION',
      eventName: 'startup.configuration_failed',
      level: 'ERROR',
      status: 'failed',
      message: 'Configuration validation failed',
      details: { error }
    });
    process.exitCode = error instanceof StartupValidationError ? error.exitCode : 1;
    return null;
  }

  const sessionLogger = getSessionLogger();
  sessionLogger?.updateContext({
    mode: startup.tradingMode,
    appMode: startup.appMode.toUpperCase(),
    exchange: startup.venue,
    providers: {},
    configFingerprint: configurationFingerprint(startup)
  });

  const dataDir = path.resolve('.mpu-gandring', 'rebirth');
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  const store = await RuntimeStore.openPostgres({ env });
  const secrets = new SecretStore({ envFile: '.env', allowWrite: true });
  const providerProfiles = await loadProviderProfiles(store, env.DATABASE_SCHEMA || 'desk', env);
  for (const profile of providerProfiles.values()) secrets.setRuntimeSecret(PROVIDER_KEY_ENV[profile.provider], profile.apiKey);
  const authority = new ExecutionAuthorityService(store);
  const accounts = await AccountRegistry.open(store, authority);
  const settings = await SettingsService.initialize(store, secrets);

  const killFile = env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE;
  const persistedHalt = Boolean(readKill(killFile));

  const snapSettings = settings.current();
  const initialIdentity = {
    savedVersion: snapSettings.savedVersion,
    activeVersion: snapSettings.activeVersion,
    appliedAt: snapSettings.appliedAt ? new Date(snapSettings.appliedAt).toISOString() : null,
    applyStatus: 'ACTIVE' as const,
    reason: 'Durable settings loaded',
    lastAcknowledgedConfigVersion: settings.lastAcknowledgedRemoteVersion()
  };

  const chatService = new ChatService(store);
  await chatService.hydrateFromStore();
  const reportsService = new ReportsService();

  const runtime = createReplacementRuntime({
    providerProfiles,
    sessionId: sessionLogger?.session.sessionId ?? null,
    initialMode: startup.tradingMode,
    initialAppMode: startup.appMode,
    venue: { name: 'indodax' as VenueId, label: 'INDODAX', kind: 'CEX', experimental: false },
    runtimeIdentity: initialIdentity,
    env,
    settings,
    secrets,
    chatService,
    reportsService,
    initialKilled: persistedHalt
  });

  if (store) {
    try {
      const msgRes = await store.execute(
        `SELECT message_id, conversation_id, role, text, created_at FROM chat_messages ORDER BY created_at DESC LIMIT 100`
      );
      if (msgRes.rows.length > 0) {
        const rows = [...msgRes.rows].reverse();
        runtime.updateState((draft) => {
          if (!draft.roomHistory) draft.roomHistory = [];
          for (const r of rows) {
            const role = String(r.role);
            const text = String(r.text);
            const at = new Date(String(r.created_at)).getTime() || Date.now();
            const id = String(r.message_id);
            const conversationId = String(r.conversation_id);
            const isOwner = role === 'owner';
            const isAgent = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'].includes(role);
            if (!isOwner && !isAgent) continue;

            const fromVal: AgentId | 'owner' = isOwner ? 'owner' : (role as AgentId);
            const toVal: AgentId | 'all' | 'owner' = isOwner ? 'all' : 'owner';

            const roomMsg: RoomMessage = {
              id,
              conversationId,
              at,
              from: fromVal,
              to: toVal,
              text
            };
            if (!draft.roomHistory.some((m) => m.id === id)) {
              draft.roomHistory.push(roomMsg);
            }
            if (!isOwner && isAgent && role in draft.chats) {
              const roleKey = role as keyof typeof draft.chats;
              if (!draft.chats[roleKey].some((c) => c.text === text && Math.abs(c.at - at) < 1000)) {
                draft.chats[roleKey].push({ from: role as AgentId, text, at, conversationId });
              }
            }
          }
          draft.roomHistory = draft.roomHistory.slice(-100);
          for (const k of Object.keys(draft.chats) as Array<keyof typeof draft.chats>) {
            draft.chats[k] = draft.chats[k].slice(-50);
          }
        });
      }

      const eventRes = await store.execute(
        `SELECT event_id, kind, created_at, payload_json FROM events ORDER BY seq DESC LIMIT 50`
      );
      if (eventRes.rows.length > 0) {
        const evtRows = [...eventRes.rows].reverse();
        runtime.updateState((draft) => {
          if (!draft.logs) draft.logs = [];
          for (const er of evtRows) {
            const at = new Date(String(er.created_at)).getTime() || Date.now();
            const id = String(er.event_id);
            const kind = String(er.kind);
            let text = `[EVENT] ${kind}`;
            try {
              const p = JSON.parse(String(er.payload_json));
              if (p.reason) text += `: ${p.reason}`;
              else if (p.message) text += `: ${p.message}`;
              else if (p.action && p.symbol) text += `: ${p.action} on ${p.symbol}`;
            } catch {}
            if (!draft.logs.some((l) => l.id === id)) {
              draft.logs.push({
                id,
                conversationId: 'office',
                at,
                kind,
                text
              });
            }
          }
          draft.logs = draft.logs.slice(-500);
        });
      }
    } catch {}
  }

  const app = createReplacementApp(runtime, {
    providerProfileDeps: { store, schema: env.DATABASE_SCHEMA || 'desk', env, profiles: providerProfiles, settings, onSaved: (profile) => secrets.setRuntimeSecret(PROVIDER_KEY_ENV[profile.provider], profile.apiKey) },
    sessionLogger,
    chatService,
    reportsService,
    setupDeps: { settings, secrets, accounts }
  });
  const server = createServer(app);
  server.once('close', () => {
    app.locals.indodaxPaperAgent?.stop();
    void app.locals.indodaxStopWorker?.stop().catch(() => {});
  });
  const wss = attachOfficeWebSocket(server, runtime, runtime.hub);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(startup.port, startup.host, () => resolve());
  });

  const boundPort = (server.address() as AddressInfo | null)?.port ?? startup.port;
  recordDiagnostic({
    source: 'server',
    category: 'SESSION',
    eventName: 'service.ready',
    status: 'ready',
    message: 'Indodax office services ready',
    details: { host: startup.host, port: boundPort, runtimeGeneration: 'v2' }
  });
  log(
    `Trading Agent Mpu Gandring backend on http://${startup.host}:${boundPort} (mode ${startup.tradingMode}, app ${startup.appMode}, generation v2)`
  );

  const commandsEnabled = /^on$/i.test((env.CHANNEL_COMMANDS ?? '').trim());
  // Start Telegram Poller and auto-sync commands if configured
  let telegramPoller: any = null;
  const tgToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const tgChatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  const tgAllowed = (env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);

  if (tgToken) {
    syncTelegramCommandsV2(tgToken, fetch).then((res) => {
      if (res.ok) log(`[channels:telegram] Bot commands auto-synced (${res.count ?? 0} commands)`);
    }).catch((err) => {
      log(`[channels:telegram] Bot commands sync deferred: ${(err as Error).message}`);
    });

    if (commandsEnabled && tgChatId) {
      try {
        telegramPoller = new TelegramPoller(
          tgToken,
          tgChatId,
          tgAllowed,
          async (commandText: string, _actor: string) => {
            const res = await runtime.handleCommand({
              text: commandText,
              conversationId: 'telegram'
            });
            return res.reply ?? res.error ?? 'Command executed.';
          },
          fetch
        );
        telegramPoller.start();
        log('[channels:telegram] Inbound poller started');
      } catch (err) {
        console.error(`[channels:telegram] Failed to start poller: ${(err as Error).message}`);
      }
    }
  }

  const shutdown = () => {
    if (telegramPoller) {
      try { telegramPoller.stop(); } catch {}
      telegramPoller = null;
    }
    wss.close();
    server.closeAllConnections();
    void runtime.stop().catch(() => {});
    server.close(() => {
      void (getSessionLogger()?.finish('INTERRUPTED', 'Server shutdown completed') ?? Promise.resolve()).finally(() => {
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, runtime };
}
