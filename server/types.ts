export type AgentId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Action = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';
export type AgentStatus = 'idle' | 'reading' | 'thinking' | 'typing' | 'arguing' | 'fighting' | 'executing' | 'journaling';

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface MeasurementEvidence {
  source: string;
  observedAt: number;
  status: 'live' | 'unavailable';
  sampleAt?: number;
  baselineAt?: number;
  basis?: string;
  reason?: string;
}

export interface RoomMessage {
  operationalSessionId?: string;
  conversationId?: string;
  id: string;
  seq?: number;
  at: number;
  from: AgentId | 'owner';
  to?: AgentId | 'all' | 'owner';
  text: string;
  symbol?: string;
  example?: boolean;
}

export interface ConversationSummary {
  operationalSessionId?: string;
  accountScope?: string;
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage?: string;
  symbol?: string;
}

export interface OrderbookSummary {
  bidObservedCoveragePct?: number;
  askObservedCoveragePct?: number;
  maxObservedCoveragePct?: number;
  requestedVenue?: string;
  actualDataVenue?: string;
  dataType?: string;
  sourceEndpoint?: string;
  levelsReturned?: { bids: number; asks: number };
  evidence?: MeasurementEvidence;
  bidAskImbalance05Pct: number;
  bidAskImbalance1Pct: number;
  spreadBps: number;
  microPrice: number;
  topBidWall: { price: number; size: number } | null;
  topAskWall: { price: number; size: number } | null;
  bids?: [number, number][];
  asks?: [number, number][];
}

export interface MarketSnapshot {
  collectorStartedAt?: number;
  collectorEndedAt?: number;
  dataProvenance?: { requestedVenue: string; actualVenue: string; dataType: 'native' | 'reference'; symbolMapping: { requested: string; actual: string; transformed: boolean }; executionCompatible: boolean; fetchedAt: number };
  snapshotId?: string;
  evidence?: Record<string, MeasurementEvidence>;
  symbol: string;
  source: 'indodax' | 'sample';
  example: boolean;
  last: number;
  change24hPct: number;
  bid: number | null;
  ask: number | null;
  candles: Candle[];
  fetchedAt: number;
}

export interface Position {
  /** Structural thesis boundary, independent of the Owner's margin-based SL/TP. */
  invalidationLevel?: number;
  entryZone?: { low: number; high: number; basis: string };
  entryScenarioId?: string;
  decisionEvidence?: Record<string, unknown>;
  ownership?: 'managed' | 'recovered' | 'external';
  protectionStatus?: 'confirmed' | 'missing' | 'unknown';
  entryStatus?: 'confirmed' | 'estimated';
  isHedge?: boolean;
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entry: number;
  stop: number;
  tp: number | null;
  margin: number;
  leverage: number;
  openedAt: number;
  mark: number;
  unrealizedPnl: number;
}

export type ExitCause = 'EXCHANGE_SL' | 'EXCHANGE_TP' | 'AI_DEBATE' | 'OWNER_MANUAL' | 'OWNER_KILL' | 'RECONCILIATION' | 'EXTERNAL' | 'UNKNOWN';
export interface ClosedTrade extends Omit<Position, 'unrealizedPnl'> {
  exitCause?: ExitCause;
  positionId?: string;
  remainingQty?: number;
  pnlStatus?: 'confirmed' | 'estimated' | 'unknown';
  exitStatus?: 'confirmed' | 'estimated';
  executionId?: string;
  exit: number;
  closedAt: number;
  realizedPnl: number;
  reason: string;
}

export interface Opinion {
  agent: AgentId;
  stance: Stance;
  confidence: number;
  text: string;
}

export interface Verdict {
  entryPolicy?: 'RISK_AND_OWNER_CONFIDENCE';
  aiDecision?: Action;
  exitCause?: ExitCause;
  executionOutcome?: string;
  finalOperationalStatus?: string;
  operationalStatus?: 'FILLED' | 'PARTIAL' | 'PENDING' | 'REJECTED';
  ownerMinConfidencePct?: number;
  riskAssessment?: { decision: string; reason: string; fallback: boolean };
  nativeQuote?: Record<string, unknown>;
  executionStatus?: 'partial' | 'filled' | 'closed';
  id: string;
  symbol: string;
  action: Action;
  riskDecision: 'APPROVE' | 'REDUCE' | 'REJECT' | 'N/A';
  executed: boolean;
  reason: string;
  reasonCode?: string;
  outcome?: 'HOLD' | 'BLOCKED' | 'FAILED' | 'SUBMITTED' | 'PARTIAL' | 'FILLED' | 'CLOSED';
  timing?: {
    marketData: number; marketAnalyst: number; researchAnalyst: number; strategist: number;
    jevPreAnalysis: number; rebuttals: number; deskLead: number; jevReview: number;
    riskManager: number; orderSubmission: number; fillConfirmation: number; total: number;
  };
  disagreement: number;
  camps: { bull: AgentId[]; bear: AgentId[]; neutral: AgentId[] };
  order?: { positionId?: string; status?: 'partial' | 'filled'; side: 'LONG' | 'SHORT'; qty: number; entry: number; stop: number; tp: number | null; margin: number; leverage: number };
  example: boolean;
  at: number;
}

export interface ChatLine { operationalSessionId?: string; clientRequestId?: string; status?: 'pending' | 'model_working' | 'waiting_on_venue' | 'consulting' | 'completed' | 'failed' | 'cancelled';
  id?: string;
  seq?: number;
  conversationId?: string;
  from: 'user' | AgentId | 'system';
  text: string;
  at: number;
}
