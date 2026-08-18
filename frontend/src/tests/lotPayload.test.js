import { describe, expect, it } from 'vitest';
import {
  decodeContainerPayload,
  decodeLotPayload,
  encodeLotPayload,
  LOT_PAYLOAD_VERSION,
} from '../utils/labelPayload';

/**
 * The SB2 lot envelope.
 *
 * SB1 promised, in its own header, that fields would be ADDITIVE and positions
 * 1..3 would never move — and that `decodeContainerPayload` would recover
 * segment 2 from any unknown `SB<digits>` version rather than rejecting the
 * scan. SB2 is the first thing to test that promise, so the forward-compat
 * assertions below are as load-bearing as the round-trip ones: they are what
 * lets a gun still running old code read a new sticker.
 */

describe('encodeLotPayload', () => {
  it('builds the fixed four-segment envelope', () => {
    expect(encodeLotPayload({
      lot_code: 'L0000042',
      vendor_lot: 'MG-2411',
      bbd: '2027-02-15T00:00:00Z',
    })).toBe('SB2|L0000042|MG-2411|20270215');
  });

  it('accepts camelCase, the way an API row arrives', () => {
    expect(encodeLotPayload({ lotCode: 'L0000042', vendorLot: 'MG-1', bbd: '2027-02-15' }))
      .toBe('SB2|L0000042|MG-1|20270215');
  });

  it('keeps empty trailing segments so positions stay fixed', () => {
    expect(encodeLotPayload({ lot_code: 'L0000042' })).toBe('SB2|L0000042||');
  });

  it('reads the BBD lexically, with no timezone math', () => {
    // dateUtils.toDateKey would shift this to 2027-02-14 in any US warehouse
    // timezone and print the wrong best-by date on a food-safety label.
    expect(encodeLotPayload({ lot_code: 'L1', bbd: '2027-02-15T00:00:00Z' }))
      .toBe('SB2|L1||20270215');
  });

  it('refuses to print a sticker with no lot code', () => {
    expect(() => encodeLotPayload({ vendor_lot: 'MG-1' })).toThrow(/lot_code is required/);
  });

  it('rejects a delimiter inside a field rather than escaping it', () => {
    // Escaping would need an unescaper in every future reader, including
    // non-JS ones (thermal firmware, a handheld's built-in parser).
    expect(() => encodeLotPayload({ lot_code: 'L1|2' })).toThrow(/may not contain/);
    expect(() => encodeLotPayload({ lot_code: 'L1', vendor_lot: 'MG|1' })).toThrow(/may not contain/);
  });

  it('does NOT throw on a missing BBD', () => {
    // One lot with an unreadable date must not abort an 80-sticker print run,
    // and the date is printed as text anyway.
    expect(encodeLotPayload({ lot_code: 'L1', vendor_lot: 'MG-1', bbd: 'nonsense' }))
      .toBe('SB2|L1|MG-1|');
  });
});

describe('decodeLotPayload', () => {
  it('round-trips', () => {
    const raw = encodeLotPayload({ lot_code: 'L0000042', vendor_lot: 'MG-1', bbd: '2027-02-15' });
    expect(decodeLotPayload(raw)).toEqual({
      version: 'SB2',
      lotCode: 'L0000042',
      vendorLot: 'MG-1',
      bbd: '2027-02-15',
      bare: false,
      unknownVersion: false,
    });
  });

  it('accepts a bare lot code hand-keyed off a scuffed drum', () => {
    // The only recovery available when a sticker is unreadable and there is no
    // second copy to compare against.
    const decoded = decodeLotPayload('L0000042');
    expect(decoded.lotCode).toBe('L0000042');
    expect(decoded.bare).toBe(true);
  });

  it('returns null for something that is not one of our labels', () => {
    expect(decodeLotPayload('')).toBeNull();
    expect(decodeLotPayload(null)).toBeNull();
    expect(decodeLotPayload('XX|abc|def|ghi')).toBeNull();
  });

  it('flags an older SB1 sticker as an unknown version but still reads it', () => {
    const decoded = decodeLotPayload('SB1|B-260803-0042-017|MG-1|20270215');
    expect(decoded.lotCode).toBe('B-260803-0042-017');
    expect(decoded.unknownVersion).toBe(true);
  });
});

describe('SB1 and SB2 interoperate by position', () => {
  it('an SB1-era reader recovers segment 2 from an SB2 sticker', () => {
    // THE MIGRATION PATH, and the reason SB1 was not redefined in place: a gun
    // still running old code reads a new sticker and gets the lot code where it
    // expected a serial, instead of rejecting the scan outright.
    const sb2 = encodeLotPayload({ lot_code: 'L0000042', vendor_lot: 'MG-1', bbd: '2027-02-15' });
    const asOldReader = decodeContainerPayload(sb2);
    expect(asOldReader.serial).toBe('L0000042');
    expect(asOldReader.unknownVersion).toBe(true);
    expect(asOldReader.vendorLot).toBe('MG-1');
    expect(asOldReader.bbd).toBe('2027-02-15');
  });

  it('the version constant is what the encoder emits', () => {
    expect(encodeLotPayload({ lot_code: 'L1' }).split('|')[0]).toBe(LOT_PAYLOAD_VERSION);
  });
});
