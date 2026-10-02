// Desk-screen fixes from the 2026-10-01 browser test (PART 1): F5, F10, F14,
// F15, F16, F17.
import { describe, it, expect } from 'vitest';
import {
  composeReceiptNote, hasSendBackTag, latestSendBack, parseReceiptNote, stripReviewTags,
} from '../utils/receiptNotes';
import {
  approvalBookingNotes, countOf, isAwaitingApproval, lotLookupKey, missingLineDetails,
  weightMismatchWarning,
} from '../utils/incomingLines';
import { formatContainers, summarizeContainers } from '../utils/inventoryContainers';

describe('F5 — send-back notes', () => {
  const note = 'Truck 2 paperwork\n[Sent Back by QA Supervisor]: QA test: please add PO number QA-PO-3';

  it('finds instructions whoever sent it back (not only "Supervisor")', () => {
    expect(latestSendBack(note)).toEqual({
      action: 'sent_back', by: 'QA Supervisor', text: 'QA test: please add PO number QA-PO-3',
    });
    expect(hasSendBackTag(note)).toBe(true);
  });

  it('still reads the legacy literal tag', () => {
    expect(latestSendBack('[Sent Back by Supervisor]: fix the lot').text).toBe('fix the lot');
  });

  it('keeps a multi-line reason together and returns the latest send-back', () => {
    const twice = '[Sent Back by A]: first\n[Sent Back by B]: second\nline two';
    expect(latestSendBack(twice)).toEqual({ action: 'sent_back', by: 'B', text: 'second\nline two' });
  });

  it('strips review tags from the worker note', () => {
    expect(stripReviewTags(note)).toBe('Truck 2 paperwork');
    expect(stripReviewTags('[Rejected by X]: no')).toBe('');
    expect(stripReviewTags('')).toBe('');
  });

  it('re-attaches the tags after the worker edits their note', () => {
    const out = composeReceiptNote('Added PO', note);
    expect(out).toBe('Added PO\n[Sent Back by QA Supervisor]: QA test: please add PO number QA-PO-3');
    expect(parseReceiptNote(out).reviews).toHaveLength(1);
  });

  it('a note with no tags is not a send-back', () => {
    expect(hasSendBackTag('just a note')).toBe(false);
    expect(latestSendBack(null)).toBeNull();
  });
});

describe('F14 — incomplete lines', () => {
  const full = { vendor_lot: 'A-0925', bbd: '2027-03-01', weight_per_unit: '502', unit_label: 'drum' };

  it('a complete line lacks nothing', () => {
    expect(missingLineDetails(full)).toEqual([]);
  });

  it('names each missing detail in the unit of the line', () => {
    expect(missingLineDetails({ ...full, vendor_lot: '  ' })).toEqual(['vendor lot']);
    expect(missingLineDetails({ ...full, bbd: '' })).toEqual(['best-by date']);
    expect(missingLineDetails({ ...full, weight_per_unit: '', unit_label: 'box' }))
      .toEqual(['weight per box']);
    expect(missingLineDetails({ unit_label: 'bag' }))
      .toEqual(['vendor lot', 'best-by date', 'weight per bag']);
  });
});

describe('F17 — different weight than an earlier delivery', () => {
  const known = { lots: [{ vendor_lot: 'A-0925', unit_label: 'drum', weights: [{ weight_per_unit: 502 }] }] };

  it('asks when this delivery weighs differently', () => {
    expect(weightMismatchWarning(known, '474', { vendorLot: 'A-0925', unit: 'drum' }))
      .toBe('Earlier delivery of A-0925 was 502 lb/drum — this one says 474. Correct?');
  });

  it('says nothing when it matches, when nothing is known, or nothing is typed', () => {
    expect(weightMismatchWarning(known, '502', { vendorLot: 'A-0925' })).toBeNull();
    expect(weightMismatchWarning({ lots: [] }, '474', {})).toBeNull();
    expect(weightMismatchWarning(undefined, '474', {})).toBeNull();
    expect(weightMismatchWarning(known, '', {})).toBeNull();
  });

  it('lists every earlier weight of a mixed lot', () => {
    const mixed = { lots: [{ weights: [{ weight_per_unit: 502 }, { weight_per_unit: 474 }] }] };
    expect(weightMismatchWarning(mixed, '450', { vendorLot: 'A-0925', unit: 'drums' }))
      .toBe('Earlier deliveries of A-0925 were 502 and 474 lb/drum — this one says 450. Correct?');
    expect(weightMismatchWarning(mixed, '474', { vendorLot: 'A-0925' })).toBeNull();
  });

  it('keys a lot the way the server does', () => {
    expect(lotLookupKey({ product_id: 'p', vendor_id: 'v', vendor_lot: ' a-09 25', bbd: '2027-03-01T00:00:00Z' }))
      .toBe('p|v|A-0925|2027-03-01');
    expect(lotLookupKey({ product_id: 'p', vendor_lot: '' })).toBeNull();
  });
});

describe('F15 — truck status and approval confirm', () => {
  it('a truck the gun finished is awaiting approval, not receiving', () => {
    expect(isAwaitingApproval({ status: 'receiving', forklift_submitted_at: '2026-10-01T20:00:00Z' })).toBe(true);
    expect(isAwaitingApproval({
      status: 'receiving',
      lines: [{ receipt_id: 'r1', forklift_submitted: true }, { receipt_id: 'r2', forklift_submitted: true }],
    })).toBe(true);
    expect(isAwaitingApproval({
      status: 'receiving',
      lines: [{ receipt_id: 'r1', forklift_submitted: true }, { receipt_id: null }],
    })).toBe(false);
    expect(isAwaitingApproval({ status: 'received', forklift_submitted_at: 'x' })).toBe(false);
  });

  it('says which lines will be booked short or over', () => {
    const truck = {
      short_reason: 'Damaged on arrival',
      flags: [{ kind: 'short', line_id: 'l2', detail: 'Damaged on arrival' }],
      lines: [
        { line_id: 'l1', vendor_lot: 'A-0925', scanned_count: 9, expected_count: 8 },
        { line_id: 'l2', vendor_lot: 'B-0910', scanned_count: 13, expected_count: 14 },
        { line_id: 'l3', vendor_lot: 'C-0901', scanned_count: 80, expected_count: 80 },
        { line_id: 'l4', vendor_lot: 'X-1', scanned_count: 2, expected_count: 0 },
      ],
    };
    expect(approvalBookingNotes(truck)).toEqual([
      'A-0925: 9 of 8 — will be booked over',
      'B-0910: 13 of 14 — will be booked short (Damaged on arrival)',
      'X-1: 2 not on the paperwork — will be booked as extra',
    ]);
    expect(approvalBookingNotes({ lines: [] })).toEqual([]);
  });
});

describe('F16 — counts read as English', () => {
  it('never says "1 stickers" or "boxs"', () => {
    expect(countOf(1, 'sticker')).toBe('1 sticker');
    expect(countOf(13, 'sticker')).toBe('13 stickers');
    expect(countOf(1, 'lot')).toBe('1 lot');
    expect(countOf(3, 'box')).toBe('3 boxes');
  });
});

describe('F10 — containers on hand', () => {
  // The browser-test truth: A-0925 is one lot, 10 + 9 drums on two racks at
  // two weights (projection on the carrier receipt, the other emptied), plus
  // lot A-0801 with 4 drums.
  const receipts = [
    {
      status: 'approved', materialLotId: 'lotA', quantity: 5020, containerUnit: 'drum',
      weightPerContainer: 502, weightUnit: 'lbs', rawMaterialRowAllocations: [],
    },
    {
      status: 'approved', materialLotId: 'lotA', quantity: 4266, containerUnit: 'drum',
      weightPerContainer: 474, weightUnit: 'lbs',
      rawMaterialRowAllocations: [
        { rowId: 'd1', cases: 5020, units: 10, fullUnits: 10, openUnits: 0, unitLabel: 'drum' },
        { rowId: 'd2', cases: 4266, units: 9, fullUnits: 9, openUnits: 0, unitLabel: 'drum' },
      ],
    },
    {
      status: 'approved', materialLotId: 'lotB', quantity: 2008, containerUnit: 'drum',
      weightPerContainer: 502, weightUnit: 'lbs',
      rawMaterialRowAllocations: [
        { rowId: 'd1', cases: 2008, units: 4, fullUnits: 4, openUnits: 0, unitLabel: 'drum' },
      ],
    },
    { status: 'recorded', quantity: 9999, containerUnit: 'drum', weightPerContainer: 1 },
  ];

  it('counts the drums on the racks, not pounds ÷ one weight', () => {
    const s = summarizeContainers(receipts);
    expect(s.count).toBe(23);
    expect(s.exact).toBe(true);
    expect(formatContainers(s)).toBe('23 drums @ 474–502 lbs ea.');
  });

  it('shows an open container as one container', () => {
    const s = summarizeContainers([{
      status: 'approved', materialLotId: 'l', quantity: 2000, containerUnit: 'drum', weightPerContainer: 500,
      rawMaterialRowAllocations: [{ rowId: 'r', units: 4, fullUnits: 3, openUnits: 1, unitLabel: 'drum' }],
    }]);
    expect(formatContainers(s)).toBe('4 drums (1 open) @ 500 lbs ea.');
  });

  it('falls back to each receipt’s own weight for receipts with no rack projection', () => {
    const s = summarizeContainers([
      { status: 'approved', quantity: 1004, containerUnit: 'drum', weightPerContainer: 502 },
      { status: 'approved', quantity: 948, containerUnit: 'drum', weightPerContainer: 474 },
    ]);
    expect(s.count).toBe(4);
    expect(s.exact).toBe(false);
    expect(formatContainers(s)).toBe('≈ 4 drums @ 474–502 lbs ea.');
  });

  it('says nothing when nothing is known', () => {
    expect(summarizeContainers([{ status: 'approved', quantity: 100 }])).toBeNull();
    expect(formatContainers(null)).toBeNull();
  });
});
