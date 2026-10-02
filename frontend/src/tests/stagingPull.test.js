// Words and numbers for the gun's staging pull (browser test PART 3, U1 / B9).
import { describe, expect, it } from 'vitest';
import {
  cartSummary, formatQty, isDrumLike, itemForLot, lotDisplayName, openPullUnit,
  perScanUnit, progressLine, pullStatusLabel, queuedByItem, rackFillText,
  rackFillUnitsMap, submitBlockReason, unitsWords,
} from '../utils/stagingPull';

describe('staging pull words', () => {
  it('formats the list progress with separators and the unit', () => {
    expect(progressLine({ fulfilled_qty: 22776, needed_qty: 89754.66, unit: 'lbs' }))
      .toBe('22,776 of 89,754.66 lbs staged');
    expect(progressLine({ fulfilled_qty: 0, needed_qty: 1000.123456 })).toBe('0 of 1,000.12 staged');
    expect(formatQty(104.99988205000001)).toBe('105');
  });

  it('says statuses in plain words, never IN_PROGRESS', () => {
    expect(pullStatusLabel('in_progress')).toBe('In progress');
    expect(pullStatusLabel('pending')).toBe('Not started');
    expect(pullStatusLabel('partially_fulfilled')).toBe('Partly staged');
    expect(pullStatusLabel('something_new')).toBe('Something new');
  });

  it('counts containers per word, never "boxs"', () => {
    expect(unitsWords([{ unit_label: 'drum', units: 2, open_units: 1 }])).toBe('2 drums + 1 open drum');
    expect(unitsWords([{ unit_label: 'box', units: 6 }, { unit_label: 'bag', units: 1 }]))
      .toBe('6 boxes + 1 bag');
    expect(unitsWords([])).toBe('');
    expect(perScanUnit(1, 'bag')).toBe('bag');
    expect(perScanUnit(9, 'bag')).toBe('bags');
    expect(perScanUnit(2, null)).toBe('units');
  });

  it('offers "Pull open …" only for drum-type material', () => {
    expect(isDrumLike('drum')).toBe(true);
    expect(isDrumLike('Drums')).toBe(true);
    expect(isDrumLike('bag')).toBe(false);
    expect(openPullUnit([{ unit_label: 'bag', unit_labels: ['bag'] }])).toBe(null);
    expect(openPullUnit([{ unit_label: 'bag' }, { unit_label: 'drum' }])).toBe('drum');
  });

  it('maps a queued sticker to its line from the lot list, offline', () => {
    const items = [
      { id: 'mango', unit_label: 'drum', lots: [{ lot_code: 'LOT-A', vendor_lot: 'A-0801', unit_label: 'drum' }] },
      { id: 'citric', unit_label: 'box', lots: [{ lot_code: 'LOT-D', vendor_lot: 'D-0801', unit_label: 'box' }] },
    ];
    expect(itemForLot(items, { lotCode: 'lot-a' }).id).toBe('mango');
    expect(itemForLot(items, { vendorLot: 'D-0801' }).id).toBe('citric');
    expect(itemForLot(items, { lotCode: 'nope' })).toBe(null);

    const q = queuedByItem(items, [
      { payload: { lot_code_hint: 'LOT-A', units: 1 } },
      { payload: { lot_code_hint: 'LOT-A', units: 1 } },
      { payload: { lot_code_hint: 'LOT-D', units: 6 } },
      { payload: { lot_code_hint: 'LOT-?', units: 3 } },
    ]);
    expect(q.byItem.mango).toEqual([{ unit_label: 'drum', units: 2, open_units: 0 }]);
    expect(q.byItem.citric).toEqual([{ unit_label: 'box', units: 6, open_units: 0 }]);
    expect(q.unmatched).toBe(3);
  });

  it('summarises the cart per product, never pounds summed across products', () => {
    const lines = cartSummary([
      { id: 'a', ingredient_name: 'Mango', pending_qty: 2510, unit: 'lbs',
        pending_units: [{ unit_label: 'drum', units: 5 }] },
      { id: 'b', ingredient_name: 'Ascorbic', pending_qty: 550, unit: 'lbs',
        pending_units: [{ unit_label: 'bag', units: 10 }] },
      { id: 'c', ingredient_name: 'Citric', pending_qty: 0, pending_units: [] },
    ]);
    expect(lines.map((l) => `${l.name}: ${l.text}`)).toEqual([
      'Mango: 5 drums (2,510 lbs)', 'Ascorbic: 10 bags (550 lbs)',
    ]);
  });

  it('rack fill names drums and bags separately and subtracts queued pulls', () => {
    const fill = { rows: [{ storage_row_id: 'stg', units: 15, by_unit: [
      { unit_label: 'drum', units: 5 }, { unit_label: 'bag', units: 10 }] }] };
    const byUnit = rackFillUnitsMap(fill);
    expect(rackFillText({ name: 'QA Staging' }, byUnit.stg, 15).text).toBe('5 drums · 10 bags');
    const d1 = { storage_unit: 'drum', unit_capacity: 12 };
    expect(rackFillText(d1, [{ unit_label: 'drum', units: 6 }], 6, 2).text).toBe('4/12 drums');
    // An older cached fill without by_unit still reads sensibly.
    expect(rackFillText(d1, undefined, 6).text).toBe('6/12 drums');
  });

  it('explains why Submit is greyed', () => {
    expect(submitBlockReason({ online: false, queuedCount: 2 })).toMatch(/Offline — 2 scans are saved on this gun/);
    expect(submitBlockReason({ online: true, queuedCount: 1 })).toMatch(/Sending 1 scan/);
    expect(submitBlockReason({ attentionCount: 1 })).toMatch(/1 scan needs attention/);
    expect(submitBlockReason({ panelOpen: true, locationId: '' })).toMatch(/Pick where the cart is staged/);
    expect(submitBlockReason({ panelOpen: true, locationId: 'loc' })).toBe(null);
  });

  it('names a lot by the vendor lot, never the internal code', () => {
    expect(lotDisplayName({ vendorLot: 'A-0925', lotCode: 'QAING-A.VENDOR-X.A-0925.20270301' })).toBe('Lot A-0925');
    expect(lotDisplayName({ lotCode: 'LOT-1' })).toBe('Lot LOT-1');
  });
});
