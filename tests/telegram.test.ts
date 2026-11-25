import { describe, expect, it, vi } from 'vitest';
import { TELEGRAM_BOT_COMMANDS, TelegramPoller, broadcastChannelMessage, channelStatusV2, syncTelegramCommandsV2, telegramSend } from '../server/v2/telegram.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_ABCDEFGHIJKLMNOPQ';

describe('Telegram channel', () => {
  it('sends a message to the configured chat and reports failure without throwing', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await telegramSend(TOKEN, '42', 'hello', fetcher as never)).toBe(true);
    expect(String(fetcher.mock.calls[0][0])).toContain(`/bot${TOKEN}/sendMessage`);
    const failing = vi.fn(async () => { throw new Error('offline'); });
    expect(await telegramSend(TOKEN, '42', 'hello', failing as never)).toBe(false);
    expect(await telegramSend('', '42', 'hello', fetcher as never)).toBe(false);
  });

  it('broadcasts to Telegram only and ignores other channel settings', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', DISCORD_BOT_TOKEN: 'x', SLACK_WEBHOOK_URL: 'https://hooks.example/x' } as NodeJS.ProcessEnv;
    expect(await broadcastChannelMessage(env, 'alert', fetcher as never)).toEqual({ telegram: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows no secret values in the channel status', () => {
    const status = channelStatusV2({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', TELEGRAM_ALLOWED_USER_IDS: '7' } as NodeJS.ProcessEnv);
    expect(status.channels.map((c) => c.channel)).toEqual(['telegram']);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(status.channels[0]).toMatchObject({ enabled: true, commandsReady: true });
  });

  it('registers only Indodax desk commands', async () => {
    const names = TELEGRAM_BOT_COMMANDS.map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['status', 'analyze', 'kill', 'unkill', 'help']));
    for (const gone of ['balance', 'positions', 'scan', 'watchlist', 'sync', 'cycle', 'pause', 'resume']) expect(names).not.toContain(gone);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await syncTelegramCommandsV2(TOKEN, fetcher as never)).toMatchObject({ ok: true, count: names.length });
    expect(await syncTelegramCommandsV2('bad-token', fetcher as never)).toMatchObject({ ok: false });
  });

  it('runs commands only for the configured chat and allowlisted users', async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 42 }, from: { id: 7 }, text: '/status' } },
      { update_id: 2, message: { chat: { id: 42 }, from: { id: 99 }, text: '/kill' } },
      { update_id: 3, message: { chat: { id: 555 }, from: { id: 7 }, text: '/kill' } }
    ];
    let polled = 0;
    const sent: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/sendMessage')) { sent.push(url); return new Response('{}', { status: 200 }); }
      polled += 1;
      return new Response(JSON.stringify({ ok: true, result: polled === 1 ? updates : [] }), { status: 200 });
    });
    const executed: string[] = [];
    const poller = new TelegramPoller(TOKEN, '42', ['7'], async (text) => { executed.push(text); return 'ok'; }, fetcher as never);
    poller.start();
    for (let i = 0; i < 100 && executed.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    expect(executed).toEqual(['/status']);
    expect(sent.length).toBe(1);
  });
});
