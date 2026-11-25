import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PaperVenue, createPaperVenue } from '../../server/v2/sandbox/paper.js';
import { AdapterCapabilityError } from '../../server/v2/execution/adapters/types.js';

describe('T12 Sandbox Isolation: Paper', () => {
  it('paper_never_loads_signer: refuses live keys and labels all receipts as simulated', async () => {
    // 1. Refusal of live signing keys or credential ports
    expect(() => {
      new PaperVenue({
        initialBalance: '1000',
        liveCredential: {
          key: 'LIVE_KEY_ATTEMPT',
          secret: 'LIVE_SECRET_ATTEMPT'
        } as any
      });
    }).toThrow(AdapterCapabilityError);

    const paper = createPaperVenue({ initialBalance: '1000' });

    // 2. Verified paper permissions
    const permissions = await paper.permissions();
    expect(permissions.ok).toBe(true);
    expect(permissions.canTrade).toBe(true);
    expect(permissions.canWithdraw).toBe(false);
    expect(permissions.delegatedOnly).toBe(true);
    expect(permissions.detail).toContain('SIMULATED');

    // 3. Balance verification
    const bal = await paper.balance();
    expect(bal.equity).toBe('1000');
    expect(bal.available).toBe('1000');
    expect(bal.availability).toBe('AVAILABLE');

    // 4. Order submission receipts explicitly simulated
    const orderReceipt = await paper.submit({
      clientOrderId: 'paper-ord-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      positionMode: 'ONE_WAY',
      hedgeLeg: null,
      orderType: 'MARKET',
      quantity: '0.010',
      limitPrice: null,
      leverage: 3,
      expireAt: null
    });

    expect(orderReceipt.state).toBe('FILLED');
    expect(orderReceipt.venueOrderId).toContain('sim-');
    expect(orderReceipt.reason).toBe('SIMULATED');
    expect(orderReceipt.avgFillPrice).toBeDefined();

    // 5. Positions and Protection
    const positions = await paper.positions();
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe('BTCUSDT');
    expect(positions[0].side).toBe('LONG');
    expect(positions[0].qty).toBe('0.010');

    const prot = await paper.protect(positions[0], {
      clientOrderId: 'paper-prot-1',
      stopPrice: '60000',
      tpPrice: '70000',
      triggerBy: 'LAST_PRICE'
    });
    expect(prot.state).toBe('VERIFIED');
    expect(prot.reduceOnlyOrPositionBound).toBe(true);
    expect(prot.reason).toBe('SIMULATED');

    // 6. Close position receipt explicitly simulated
    const closeReceipt = await paper.close(positions[0], 'paper-close-1');
    expect(closeReceipt.state).toBe('FILLED');
    expect(closeReceipt.venueOrderId).toContain('sim-');
    expect(closeReceipt.reason).toBe('SIMULATED');

    const remainingPositions = await paper.positions();
    expect(remainingPositions.length).toBe(0);
  });
});
