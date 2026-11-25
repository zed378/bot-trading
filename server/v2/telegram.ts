import { safe } from '../redact.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Telegram is the only chat channel. It sends alerts and, when enabled, accepts Indodax desk commands from allowlisted users. */
export interface TelegramChannelConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  ownerUserIds?: string[];
}

const TIMEOUT_MS = 8000;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

export async function telegramSend(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!token || !chatId) return false;
  try {
    const res = await postJson(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: safe(text).slice(0, 4000), disable_web_page_preview: true },
      {},
      fetchImpl
    );
    return res.ok;
  } catch (err) {
    console.error('[channels:telegram] delivery failed:', (err as Error).message);
    return false;
  }
}

export async function broadcastChannelMessage(
  env: NodeJS.ProcessEnv,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (token && chatId) results.telegram = await telegramSend(token, chatId, text, fetchImpl);
  return results;
}

export const V2_CHANNELS = ['telegram'] as const;
export type V2ChannelName = (typeof V2_CHANNELS)[number];

export function isChannelV2(v: unknown): v is V2ChannelName {
  return typeof v === 'string' && (V2_CHANNELS as readonly string[]).includes(v);
}

export const CHANNEL_LINKS_CHECKED_ON = '2026-11-01';

export const SUPERVISOR_ENV = [
  { env: 'CHANNEL_COMMANDS', text: 'on lets allowlisted users send status, report and kill commands. Default off.' }
];

export const V2_CHANNEL_GUIDES: Record<V2ChannelName, {
  label: string;
  official: string;
  outbound: string;
  inbound: string;
  publicUrl: boolean;
  fields: Array<{ env: string; label: string; secret: boolean; required: boolean; hint: string }>;
  steps: Array<{ title: string; text: string; links: Array<{ label: string; url: string; login?: boolean }> }>;
  notes: string[];
  docs: Array<{ label: string; url: string }>;
}> = {
  telegram: {
    label: 'Telegram',
    official: 'Official Telegram Bot API (no third party bot frameworks, no Telegram user account libraries)',
    outbound: 'sendMessage to your chat ID',
    inbound: 'getUpdates long polling from this computer: no public URL, port forward, tunnel or webhook needed',
    publicUrl: false,
    fields: [
      { env: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from @BotFather', secret: true, required: true, hint: 'format: 123456:ABC-DEF...' },
      { env: 'TELEGRAM_CHAT_ID', label: 'Your chat ID (start a chat with your bot first)', secret: false, required: true, hint: 'numbers only, negative for groups' },
      { env: 'TELEGRAM_ALLOWED_USER_IDS', label: 'User IDs allowed to send commands (empty = alerts only, no commands)', secret: false, required: false, hint: 'space or comma separated' }
    ],
    steps: [
      { title: 'Create your bot with @BotFather', text: 'Open Telegram, start a chat with @BotFather, type /newbot and follow the prompts. It will give you a bot token.', links: [{ label: 'Open @BotFather', url: 'https://t.me/BotFather' }] },
      { title: 'Start your bot and get your chat ID', text: 'Send /start to your new bot. Then click Find my chat below to discover your chat ID and user ID.', links: [] }
    ],
    notes: ['Telegram commands use long polling directly from this computer.'],
    docs: [{ label: 'Telegram Bot API', url: 'https://core.telegram.org/bots/api' }]
  }
};

export function channelStatusV2(env: NodeJS.ProcessEnv) {
  const tgToken = !!(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const tgChat = !!(env.TELEGRAM_CHAT_ID ?? '').trim();
  const tgAllowed = (env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  const tgEnabled = tgToken && tgChat;
  return {
    commands: /^on$/i.test((env.CHANNEL_COMMANDS ?? '').trim()),
    channels: [
      {
        channel: 'telegram',
        label: 'Telegram',
        enabled: tgEnabled,
        commandsReady: tgEnabled && tgAllowed.length > 0,
        fields: [
          { env: 'TELEGRAM_BOT_TOKEN', set: tgToken, shown: null },
          { env: 'TELEGRAM_CHAT_ID', set: tgChat, shown: env.TELEGRAM_CHAT_ID ?? null },
          { env: 'TELEGRAM_ALLOWED_USER_IDS', set: tgAllowed.length > 0, shown: env.TELEGRAM_ALLOWED_USER_IDS ?? null }
        ]
      }
    ]
  };
}

export async function testChannelV2(
  env: NodeJS.ProcessEnv,
  channel: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string }> {
  if (channel !== 'telegram') return { ok: false, detail: `Unknown channel: ${channel}` };
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!token || !chatId) return { ok: false, detail: 'Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required).' };
  const ok = await telegramSend(token, chatId, `Test message from Trading Agent Mpu Gandring (${(env.TRADING_MODE || 'PAPER').toUpperCase()}). If you can read this, alerts reach you here.`, fetchImpl);
  return ok ? { ok: true, detail: 'Test message sent to Telegram.' } : { ok: false, detail: 'Telegram did not accept the message.' };
}

export function saveChannelV2(
  envFile: string,
  channel: string,
  input: Record<string, string | undefined>,
  options: { commands?: boolean } = {}
): { ok: boolean; detail: string } {
  const updates: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) updates[k] = v.trim();
  }
  if (options.commands !== undefined) updates.CHANNEL_COMMANDS = options.commands ? 'on' : 'off';

  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
    const regex = new RegExp(`^${k}=.*$`, 'm');
    if (regex.test(text)) text = text.replace(regex, `${k}=${v}`);
    else text += `\n${k}=${v}`;
  }
  writeFileSync(envFile, text, 'utf8');
  return { ok: true, detail: `${channel} saved to .env.` };
}

export function resetChannelV2(envFile: string, channel: string): { ok: boolean; detail: string } {
  const keys = channel === 'telegram' ? ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ALLOWED_USER_IDS'] : [];
  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  for (const k of keys) {
    delete process.env[k];
    const regex = new RegExp(`^${k}=.*$`, 'm');
    if (regex.test(text)) text = text.replace(regex, `${k}=`);
  }
  writeFileSync(envFile, text, 'utf8');
  return { ok: true, detail: `${channel} configuration has been reset.` };
}

export async function telegramChatsV2(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string; chats: Array<{ chatId: string; chat: string; userId: string; user: string }> }> {
  if (!token) return { ok: false, detail: 'Bot token required.', chats: [] };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?allowed_updates=["message"]`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, detail: `Telegram HTTP ${res.status}`, chats: [] };
    const data = (await res.json()) as any;
    if (!data?.ok) return { ok: false, detail: data?.description ?? 'Telegram error', chats: [] };
    const chats = (data.result ?? [])
      .map((u: any) => ({
        chatId: String(u.message?.chat?.id ?? ''),
        chat: String(u.message?.chat?.title ?? u.message?.chat?.username ?? u.message?.chat?.first_name ?? ''),
        userId: String(u.message?.from?.id ?? ''),
        user: String(u.message?.from?.username ?? u.message?.from?.first_name ?? '')
      }))
      .filter((c: any) => c.chatId);
    return { ok: true, detail: chats.length ? 'Chats found.' : 'No messages yet.', chats };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, chats: [] };
  }
}

export const TELEGRAM_BOT_COMMANDS = [
  { command: 'status', description: 'Mode, kill switch and the last verdict' },
  { command: 'analyze', description: 'Start an agent debate for an Indodax pair, for example BTCIDR' },
  { command: 'ask', description: 'Chat with the Desk Lead or an agent' },
  { command: 'report', description: 'Latest desk report' },
  { command: 'mode', description: 'Current mode' },
  { command: 'health', description: 'Desk health' },
  { command: 'lessons', description: 'Recent lessons' },
  { command: 'kill', description: 'Emergency stop for agent cycles and the SL monitor' },
  { command: 'unkill', description: 'Release the kill switch' },
  { command: 'help', description: 'Show available commands' }
];

export async function syncTelegramCommandsV2(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string; count?: number }> {
  if (!token || !/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) {
    return { ok: false, detail: 'TELEGRAM_BOT_TOKEN is missing or invalid.' };
  }
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: TELEGRAM_BOT_COMMANDS }),
      signal: AbortSignal.timeout(10_000)
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      return { ok: false, detail: `Telegram error: ${safe(String(data.description ?? res.status))}` };
    }
    return {
      ok: true,
      detail: `Telegram commands registered with BotFather (${TELEGRAM_BOT_COMMANDS.length} commands).`,
      count: TELEGRAM_BOT_COMMANDS.length
    };
  } catch (err) {
    return { ok: false, detail: `Could not reach Telegram: ${safe((err as Error).message)}` };
  }
}

export class TelegramPoller {
  private abortController: AbortController | null = null;
  private offset = 0;
  private running = false;

  constructor(
    private token: string,
    private chatId: string,
    private allowedUsers: string[],
    private executeCommand: (cmdText: string, actor: string) => Promise<string>,
    private fetchImpl: typeof fetch = fetch
  ) {}

  public start(): void {
    if (this.running || !this.token || !this.chatId) return;
    this.running = true;
    this.abortController = new AbortController();
    void this.pollLoop(this.abortController.signal);
  }

  public stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted && this.running) {
      try {
        const url = `https://api.telegram.org/bot${this.token}/getUpdates?timeout=25&offset=${this.offset}&allowed_updates=["message"]`;
        const res = await this.fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          ok?: boolean;
          result?: Array<{
            update_id: number;
            message?: { chat?: { id: number | string }; from?: { id: number | string }; text?: string };
          }>;
        };
        if (data.ok && Array.isArray(data.result)) {
          failures = 0;
          for (const u of data.result) {
            if (signal.aborted) break;
            if (typeof u.update_id === 'number') {
              this.offset = Math.max(this.offset, u.update_id + 1);
            }
            const m = u.message;
            if (!m || typeof m.text !== 'string') continue;
            const fromChat = String(m.chat?.id ?? '');
            const fromUser = String(m.from?.id ?? '');
            if (fromChat !== this.chatId || (this.allowedUsers.length > 0 && !this.allowedUsers.includes(fromUser))) {
              continue;
            }
            const reply = await this.executeCommand(m.text, `telegram:${fromChat}:${fromUser}`);
            await telegramSend(this.token, fromChat, reply, this.fetchImpl);
          }
        }
        if (!data.result?.length && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        const backoff = Math.min(60_000, 5000 * Math.min(failures, 6));
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}

export const HELP_TEXT = [
  'MPU GANDRING (Indodax spot)',
  '/status  mode, kill switch, last verdict',
  '/analyze <pair>  start a debate, for example /analyze BTCIDR',
  '/ask <question>  Desk Lead or role chat',
  '/report  latest desk report',
  '/mode  current mode',
  '/health  desk health',
  '/lessons  recent notes',
  '/kill  emergency stop (then /kill confirm)',
  '/unkill  release the kill switch'
].join('\n');
