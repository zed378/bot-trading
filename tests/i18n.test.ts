import { describe, expect, it } from 'vitest';
import { en, id, DICTIONARIES } from '../web/src/i18n.js';

describe('Dual language i18n parity', () => {
  it('keeps strict 1:1 key parity between EN and ID with non-empty values and zero em dashes', () => {
    const enKeys = Object.keys(en).sort();
    const idKeys = Object.keys(id).sort();
    expect(idKeys).toEqual(enKeys);
    expect(DICTIONARIES.en).toBe(en);
    expect(DICTIONARIES.id).toBe(id);

    for (const k of enKeys) {
      const enVal = en[k as keyof typeof en];
      const idVal = id[k as keyof typeof en];
      expect(typeof enVal).toBe('string');
      expect(typeof idVal).toBe('string');
      expect(enVal.trim().length).toBeGreaterThan(0);
      expect(idVal.trim().length).toBeGreaterThan(0);
      expect(enVal.includes('\u2014')).toBe(false);
      expect(idVal.includes('\u2014')).toBe(false);
    }
  });



});
