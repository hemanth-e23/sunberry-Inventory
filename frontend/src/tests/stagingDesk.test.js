// Browser test PART 3 (2026-10-02): desk staging rules.
import { describe, it, expect } from 'vitest';
import {
  activeRacks,
  autoAllocate,
  buildStageLots,
  closeOutAvailable,
  describeAllocation,
  drumsWeight,
  isOverdue,
  lotAllocationQty,
  openWeight,
  stagingItemMatchesFilter,
  unitsText,
} from '../utils/stagingDesk';
import { onePerLot, offRackText } from '../utils/holdLots';
import { adjustmentTypeLabel } from '../utils/adjustmentTypes';

// A-0925 as the browser test found it: D1 4 × 502, D3 3 × 502,
// D4 17 × 474 then 3 × 502 (oldest delivery first), one open drum of 210.
const d1 = { storage_row_id: 'd1', storage_row_name: 'QA-D1', available_units: 4,
  available_qty: 2008, unit_weights: [{ units: 4, weight: 502 }], open_units: 0 };
const d4 = { storage_row_id: 'd4', storage_row_name: 'QA-D4', available_units: 20,
  available_qty: 17 * 474 + 3 * 502,
  unit_weights: [{ units: 17, weight: 474 }, { units: 3, weight: 502 }],
  open_units: 1, open_remaining_qty: 210 };
const a0925 = { receipt_id: 'r-a0925', is_counted: true, unit_label: 'drum',
  available_quantity: 2008 + 17 * 474 + 3 * 502 + 210, racks: [d4, d1] };
const a0801 = { receipt_id: 'r-a0801', is_counted: true, unit_label: 'drum',
  available_quantity: 2008, racks: [{ ...d1, storage_row_id: 'd1b' }] };

describe('B5: whole drums at their own weights', () => {
  it('prices drums in pull order across deliveries', () => {
    expect(drumsWeight(d4, 1)).toBe(474);
    expect(drumsWeight(d4, 18)).toBe(17 * 474 + 502);
    expect(drumsWeight(d4, 20)).toBe(17 * 474 + 3 * 502);
    expect(openWeight(d4, 1)).toBe(210);
  });

  it('falls back to the rack average without per-drum weights', () => {
    expect(drumsWeight({ available_units: 2, available_qty: 1000 }, 1)).toBe(500);
  });

  it('auto-allocates FEFO in whole drums, open drum first, never "992 lbs"', () => {
    const { counted } = autoAllocate([a0801, a0925], 3000);
    expect(counted['r-a0801']).toEqual({ d1b: { full: 4, open: 0 } });
    // 992 more: the open 210, then 474 + 474 → over by a part drum, whole.
    expect(counted['r-a0925']).toEqual({ d4: { full: 2, open: 1 } });
    const total = lotAllocationQty(a0801, counted['r-a0801'])
      + lotAllocationQty(a0925, counted['r-a0925']);
    expect(total).toBe(2008 + 210 + 948);
  });

  it('sends one entry per rack with exact lbs and container counts', () => {
    const counted = { 'r-a0925': { d4: { full: 3, open: 0 }, d1: { full: 1, open: 0 } } };
    expect(buildStageLots([a0925], counted, {})).toEqual([
      { receipt_id: 'r-a0925', quantity: 3 * 474, source_row_id: 'd4', full_units: 3, open_units: 0 },
      { receipt_id: 'r-a0925', quantity: 502, source_row_id: 'd1', full_units: 1, open_units: 0 },
    ]);
    expect(describeAllocation(a0925, counted['r-a0925'])).toBe('4 drums · 1,924 lbs');
  });

  it('keeps legacy lots on a typed weight', () => {
    const legacy = { receipt_id: 'r-old', is_counted: false, available_quantity: 300 };
    const { legacy: l } = autoAllocate([legacy], 200);
    expect(l).toEqual({ 'r-old': 200 });
    expect(buildStageLots([legacy], {}, l)).toEqual([{ receipt_id: 'r-old', quantity: 200 }]);
  });
});

describe('G1: Close Out on the production day', () => {
  it('opens on the day and after, not before', () => {
    expect(closeOutAvailable('2026-10-03', '2026-10-02')).toBe(false);
    expect(closeOutAvailable('2026-10-03', '2026-10-03')).toBe(true);
    expect(closeOutAvailable('2026-10-03', '2026-10-04')).toBe(true);
    expect(closeOutAvailable(null, '2026-10-04')).toBe(false);
  });
  it('is overdue only once the day has passed', () => {
    expect(isOverdue('2026-10-03', '2026-10-03')).toBe(false);
    expect(isOverdue('2026-10-03', '2026-10-04')).toBe(true);
  });
});

describe('B8: Staging Overview filters', () => {
  const items = [
    { id: 'a', status: 'staged', quantity_staged: 5, quantity_used: 0, quantity_returned: 0 },
    { id: 'b', status: 'used', quantity_staged: 5, quantity_used: 5, quantity_returned: 0 },
    { id: 'c', status: 'returned', quantity_staged: 5, quantity_used: 0, quantity_returned: 5 },
    { id: 'd', status: 'completed', quantity_staged: 502, quantity_used: 292, quantity_returned: 210 },
    { id: 'e', status: 'partially_returned', quantity_staged: 5, quantity_used: 1, quantity_returned: 1 },
  ];
  const pick = (f) => items.filter((i) => stagingItemMatchesFilter(i, f)).map((i) => i.id);
  it('"All" is every item', () => expect(pick('all')).toEqual(['a', 'b', 'c', 'd', 'e']));
  it('"Active" is what is still in staging', () => expect(pick('active')).toEqual(['a', 'e']));
  it('one status at a time', () => {
    expect(pick('used')).toEqual(['b']);
    expect(pick('completed')).toEqual(['d']);
  });
});

describe('G2: any active rack', () => {
  const tree = [
    { id: 'barn', name: 'QA Barn', subLocations: [
      { id: 'drums', name: 'QA Drum Room', rows: [
        { id: 'd4', name: 'QA-D4' }, { id: 'd1', name: 'QA-D1' },
        { id: 'dead', name: 'OLD', active: false },
      ] },
      { id: 'closed', name: 'Closed Room', active: false, rows: [{ id: 'x', name: 'X' }] },
    ] },
  ];
  it('lists every active rack with its room, sorted', () => {
    expect(activeRacks(tree)).toEqual([
      { id: 'd1', label: 'QA Barn › QA Drum Room › QA-D1', locationId: 'barn', subLocationId: 'drums' },
      { id: 'd4', label: 'QA Barn › QA Drum Room › QA-D4', locationId: 'barn', subLocationId: 'drums' },
    ]);
  });
  it('ignores the flat dropdown list', () => {
    expect(activeRacks([{ id: 'barn', name: 'QA Barn' }])).toEqual([]);
  });
});

describe('U5: drums as well as lbs', () => {
  it('converts by the staged drums\' own weight', () => {
    expect(unitsText(502, { staged_unit_weight: 502, unit_label: 'drum' })).toBe('1 drum');
    expect(unitsText(210, { staged_unit_weight: 502, unit_label: 'drum' })).toBe('0.42 drums');
    expect(unitsText(210, {})).toBe('');
  });
});

describe('U4 / B3: hold form', () => {
  it('lists a lot once, by its newest delivery', () => {
    const rs = [
      { id: 'r1', materialLotId: 'L', receiptDate: '2026-09-01' },
      { id: 'r2', materialLotId: 'L', receiptDate: '2026-09-25' },
      { id: 'legacy', materialLotId: null },
      { id: 'r3', materialLotId: 'L', receiptDate: '2026-09-10' },
    ];
    expect(onePerLot(rs).map((r) => r.id)).toEqual(['r2', 'legacy']);
  });
  it('names containers on a cart and in staging', () => {
    expect(offRackText({ unit: 'lbs', unit_label: 'drum', on_cart_units: 1, on_cart_qty: 502,
      in_staging_qty: 502, in_staging_units: 1 }))
      .toBe('1 drum on a gun cart (502 lbs); 502 lbs in staging (≈ 1 drum)');
    expect(offRackText({ on_cart_units: 0, in_staging_qty: 0 })).toBeNull();
  });
});

describe('U6: adjustment type labels', () => {
  it('humanises system types', () => {
    expect(adjustmentTypeLabel('production-consumption')).toBe('Production Consumption');
    expect(adjustmentTypeLabel('something-new')).toBe('Something New');
  });
});
