// Browser test PART 2 (2026-10-01) desk findings: By Location pounds and
// counts (B2, U7), transfer/adjustment wording and over-asks (U4, U5, U6),
// the Recount form (U8), held lots at check-in (U9), Hold History order (U11).
import { describe, it, expect } from 'vitest';
import { buildTree } from '../utils/locationTree';
import {
  buildEntriesForProduct, countWithUnit, freeContainers, overAskMessage, stockSummary,
} from '../utils/rowSources';
import { countRackOptions, countWording, describeCount, lotCountsByRow } from '../utils/countRacks';
import { heldLotWarning } from '../utils/incomingLines';
import { sortHoldsNewestFirst } from '../utils/holdHistory';

const drumRoom = {
  id: 'sub-d', name: 'QA Drum Room', storageUnit: 'drum', unitCapacity: 30,
  rows: [
    { id: 'D4', name: 'QA-D4', productId: 'mango', occupiedCases: 9564, occupiedPallets: 20 },
    { id: 'D1', name: 'QA-D1', productId: 'mango', occupiedCases: 2008, occupiedPallets: 4 },
  ],
};
const dryRoom = {
  id: 'sub-p', name: 'QA Dry Room',
  rows: [{ id: 'P1', name: 'QA-P1', productId: 'ascorbic', occupiedCases: 990, occupiedPallets: 1 }],
};
const locationsTree = [{ id: 'loc-barn', name: 'QA Barn', subLocations: [drumRoom, dryRoom] }];
const productsById = {
  mango: { id: 'mango', name: 'QA Mango Puree' },
  ascorbic: { id: 'ascorbic', name: 'Ascorbic' },
};
const mangoLot = (id, extra) => ({
  id, productId: 'mango', status: 'approved', quantityUnits: 'lbs',
  lotNo: 'A-0925', materialLotId: 'lot-a0925', weightPerContainer: 474, containerUnit: 'drum',
  location: 'loc-barn', subLocation: 'sub-d', ...extra,
});

describe('By Location never double-counts a lot-tracked receipt (B2)', () => {
  // The lot's rack picture rides on ONE receipt; the others are blank — some
  // with [] and some (IN-000029) with NULL.
  const carrier = mangoLot('r-carrier', {
    quantity: 13078,
    rawMaterialRowAllocations: [
      { rowId: 'D4', cases: 9564, units: 20, fullUnits: 20 },
      { rowId: 'D1', cases: 2008, units: 4, fullUnits: 4 },
    ],
  });
  const blankNull = mangoLot('r-in29', { quantity: 2844, rawMaterialRowAllocations: null, storageRowId: 'D4' });
  const blankEmpty = mangoLot('r-in30', { quantity: 948, rawMaterialRowAllocations: [] });

  const rowNode = (tree, id) => tree[0].children[0].children.find((r) => r.id === id);

  it('QA-D4 holds exactly what the allocations say', () => {
    const tree = buildTree({
      locationsTree, storageAreas: [], receipts: [carrier, blankNull, blankEmpty], productsById,
    });
    const d4 = rowNode(tree, 'D4');
    expect(d4.products).toHaveLength(1);
    expect(d4.products[0].qty).toBe(9564);
    expect(d4.products[0].fullUnits).toBe(20);
    // Nothing leaked into the room or barn buckets either.
    expect(tree[0].qty).toBe(0);
    expect(tree[0].children[0].qty).toBe(0);
  });

  it('a legacy receipt with no lot still uses its storage row', () => {
    const legacy = {
      id: 'r-old', productId: 'ascorbic', status: 'approved', quantity: 990, quantityUnits: 'lbs',
      lotNo: 'OLD-1', storageRowId: 'P1',
    };
    const tree = buildTree({ locationsTree, storageAreas: [], receipts: [legacy], productsById });
    expect(tree[0].children[1].children[0].products[0].qty).toBe(990);
  });

  it('headers count DISTINCT products and lots (U7)', () => {
    const ascorbic = {
      id: 'r-asc', productId: 'ascorbic', status: 'approved', quantity: 990, quantityUnits: 'lbs',
      lotNo: 'C-0901', materialLotId: 'lot-c', rawMaterialRowAllocations: [{ rowId: 'P1', cases: 990, units: 18 }],
    };
    const tree = buildTree({
      locationsTree, storageAreas: [], receipts: [carrier, blankNull, ascorbic], productsById,
    });
    // Mango sits on two racks; it is still one product and one lot.
    expect(tree[0].children[0].productCount).toBe(1);
    expect(tree[0].children[0].lotCount).toBe(1);
    expect(tree[0].productCount).toBe(2);
    expect(tree[0].lotCount).toBe(2);
  });
});

describe('form wording (U4, U5, U6)', () => {
  it('pluralises by count', () => {
    expect(countWithUnit(12, 'bag')).toBe('12 bags');
    expect(countWithUnit(3, 'drum')).toBe('3 drums');
    expect(countWithUnit(1, 'drums')).toBe('1 drum');
    expect(countWithUnit(2, 'box')).toBe('2 boxes');
  });

  const rack = {
    locationLabel: 'QA Barn / QA Drum Room / QA-D1',
    displayFactor: 502, displayUnit: 'drum', unit: 'lbs',
    fullUnits: 7, openUnits: 0, grossWeight: 7 * 502,
    available: 4 * 502, reservedWeight: 3 * 502, heldUnits: 0,
  };

  it('counts free containers net of pending transfers', () => {
    expect(freeContainers(rack)).toBe(4);
  });

  it('explains an over-ask in drums, pounds and why', () => {
    expect(overAskMessage(rack, 4)).toBeNull();
    expect(overAskMessage(rack, 5)).toBe(
      'QA-D1 has only 4 drums free (2,008 lbs); you asked for 5 drums. Not free: 3 drums on pending requests.',
    );
  });

  it('names a hold as the reason', () => {
    const held = { ...rack, available: 0, reservedWeight: 0, heldUnits: 7 };
    expect(overAskMessage(held, 1)).toContain('Not free: 7 drums on hold');
  });

  it('header separates on hand from available', () => {
    const s = stockSummary([rack]);
    expect(s.onHand).toBe(7 * 502);
    expect(s.available).toBe(4 * 502);
    expect(s.text).toBe('On hand 7 drums (3,514 lbs) · available 4 drums (2,008 lbs)');
  });

  it('a held lot reads as on hand, none available', () => {
    const s = stockSummary([{ ...rack, available: 0, reservedWeight: 0, heldUnits: 7 }]);
    expect(s.text).toBe('On hand 7 drums (3,514 lbs) · available 0 drums (0 lbs)');
  });

  it('bag entries carry units per pallet from any receipt of the lot (U4)', () => {
    const carrier = {
      id: 'r2', productId: 'asc', status: 'approved', quantity: 3850, quantityUnits: 'lbs',
      lotNo: 'C-0901', materialLotId: 'lot-c', weightPerContainer: 55, containerUnit: 'bag',
      rawMaterialRowAllocations: [{ rowId: 'P1', cases: 3850, units: 70, fullUnits: 70 }],
    };
    const first = { ...carrier, id: 'r1', quantity: 0, unitsPerPallet: 40, rawMaterialRowAllocations: [] };
    const entries = buildEntriesForProduct({
      productId: 'asc', approvedReceipts: [carrier], allReceipts: [first, carrier],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].unitsPerPallet).toBe(40);
  });
});

describe('Recount form (U8)', () => {
  const rows = [
    { id: 'D1', name: 'QA-D1', storage_unit: 'drum' },
    { id: 'P1', name: 'QA-P1', storage_unit: null },
    { id: 'P2', name: 'QA-P2', storage_unit: null },
    { id: 'FG-7', name: 'Row 7', storage_area_id: 'area-fg' },
    { id: 'Q1', name: 'QA-Q1', storage_unit: 'drum' },
  ];

  it('offers no finished-goods racks and no drum rooms for bags', () => {
    const opts = countRackOptions(rows, { unitLabel: 'bag', currentRowIds: [] });
    expect(opts.map((r) => r.id)).toEqual(['P1', 'P2']);
  });

  it('puts the racks the lot is on first, even in another kind of room', () => {
    const opts = countRackOptions(rows, { unitLabel: 'bag', currentRowIds: ['P2', 'Q1'] });
    expect(opts.map((r) => r.id)).toEqual(['P2', 'Q1', 'P1']);
  });

  it('drum lots get drum rooms first', () => {
    const opts = countRackOptions(rows, { unitLabel: 'drum' });
    expect(opts.map((r) => r.id)).toEqual(['D1', 'Q1', 'P1', 'P2']);
  });

  it('reads the system count per rack from the lot projection', () => {
    const receipts = [
      { id: 'a', materialLotId: 'lot-c', rawMaterialRowAllocations: [{ rowId: 'P1', units: 18, fullUnits: 18 }] },
      { id: 'b', materialLotId: 'lot-c', rawMaterialRowAllocations: [] },
      { id: 'c', materialLotId: 'other', rawMaterialRowAllocations: [{ rowId: 'P1', units: 5 }] },
    ];
    expect(lotCountsByRow(receipts, 'lot-c')).toEqual({ P1: { full: 18, open: 0, openQty: 0 } });
    expect(describeCount({ full: 18 }, 'bag')).toBe('18 bags');
    expect(describeCount({ full: 4, open: 1, openQty: 224 }, 'drum')).toBe('4 drums + 1 open (224 lbs)');
  });

  it('uses the lot unit, not drum wording', () => {
    const bag = countWording('bag');
    expect(bag.openedLabel).toBe('Opened bags');
    expect(bag.openedHint).not.toMatch(/cooler/);
    expect(countWording('box').many).toBe('boxes');
    expect(countWording('drum').openedHint).toMatch(/cooler/);
  });
});

describe('held lot at walk-in / check-in (U9)', () => {
  it('warns when the looked-up lot is held', () => {
    const known = { lots: [{ vendor_lot: 'B-0910', unit_label: 'drum', weights: [], is_held: true, hold_reason: 'positive swab' }] };
    expect(heldLotWarning(known, { vendorLot: 'B-0910', unit: 'drum' }))
      .toBe('B-0910 is on hold (positive swab) — drums received will be held.');
  });

  it('says nothing for a lot that is not held, or unknown', () => {
    expect(heldLotWarning({ lots: [{ is_held: false, weights: [] }] }, {})).toBeNull();
    expect(heldLotWarning(undefined, {})).toBeNull();
  });
});

describe('Hold History order (U11)', () => {
  it('shows the newest first however the list was assembled', () => {
    // Server order (newest first) with a fresh submission appended at the end.
    const list = [
      { id: 'release', submittedAt: '2026-10-01T21:53:00Z', approvedAt: '2026-10-01T21:55:00Z' },
      { id: 'hold', submittedAt: '2026-10-01T21:45:00Z', approvedAt: '2026-10-01T21:47:00Z' },
      { id: 'old', submittedAt: '2026-09-01T15:15:00Z' },
      { id: 'fresh', submittedAt: '2026-10-01T22:10:00Z' },
    ];
    expect(sortHoldsNewestFirst(list).map((h) => h.id)).toEqual(['fresh', 'release', 'hold', 'old']);
  });
});
