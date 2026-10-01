// 2026-10-01 browser test: what the Transfer / Adjustment forms offer, and how
// dates and open drums read on screen.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildEntriesForProduct,
  describeContainers,
} from '../utils/rowSources';
import { formatDate, toDateKey, setAppTimezone } from '../utils/dateUtils';

const W = 502;
const lotReceipt = (id, allocs, extra = {}) => ({
  id,
  productId: 'p1',
  status: 'approved',
  quantity: 20 * W,
  quantityUnits: 'lbs',
  lotNo: 'QA-LOT-A',
  materialLotId: 'lot-a',
  weightPerContainer: W,
  containerUnit: 'drum',
  rawMaterialRowAllocations: allocs,
  ...extra,
});

describe('best-by dates are calendar days', () => {
  beforeAll(() => setAppTimezone('America/Chicago'));

  it('shows the day that was typed, not the evening before', () => {
    expect(formatDate('2027-03-01')).toBe('3/1/2027');
    expect(toDateKey('2027-03-01')).toBe('2027-03-01');
  });

  it('still converts real timestamps into the warehouse timezone', () => {
    expect(formatDate('2026-10-02T03:00:00Z')).toBe('10/1/2026');
  });
});

describe('forms subtract drums already on pending transfers', () => {
  const carrier = lotReceipt('r2', [{ rowId: 'row1', cases: 20 * W, units: 20, fullUnits: 20 }]);
  const sibling = lotReceipt('r1', [], { quantity: 0, status: 'depleted' });

  it('takes pending transfers of ANY receipt of the lot off the rack they leave', () => {
    const entries = buildEntriesForProduct({
      productId: 'p1',
      approvedReceipts: [carrier],
      allReceipts: [carrier, sibling],
      pendingTransfers: [
        { status: 'pending', receiptId: 'r2', sourceBreakdown: [{ id: 'row-row1', quantity: 2 * W }] },
        { status: 'forklift_submitted', receiptId: 'r1', sourceBreakdown: [{ id: 'row-row1', quantity: 12 * W }] },
        { status: 'approved', receiptId: 'r2', sourceBreakdown: [{ id: 'row-row1', quantity: 5 * W }] },
        { status: 'pending', receiptId: 'r2', sourceBreakdown: [{ id: 'row-other', quantity: W }] },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].available).toBe(6 * W);
    expect(entries[0].reservedWeight).toBe(14 * W);
  });
});

describe('an open drum is one container, not a fraction', () => {
  const entry = {
    displayFactor: W, displayUnit: 'drum', unit: 'lbs',
    fullUnits: 6, openUnits: 1, openQty: 224, available: 6 * W + 224,
  };

  it('says full + open instead of 6.45 drums', () => {
    expect(describeContainers(entry)).toBe('6 full + 1 open (224 lbs)');
  });

  it('counts whole drums when nothing is open', () => {
    expect(describeContainers({ ...entry, openUnits: 0, openQty: 0, available: 6 * W }))
      .toBe('6 drums');
  });

  it('keeps legacy wording when there is no container split', () => {
    expect(describeContainers({ displayFactor: W, displayUnit: 'drum', available: W })).toBeNull();
  });
});
