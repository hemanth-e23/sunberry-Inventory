// `unitsPerPallet` answers one question: how many units share one sticker and
// one scan? Bags do; drums do not.
//
// The distinction matters because that single number drives THREE things — the
// print run, the gun's multiplier, and the rack footprint — and getting it
// wrong for drums is silent at entry and visible only on a printed label. A
// 69-drum delivery printed "PALLET OF DRUMS" and the gun offered to book two
// drums per scan, because the field had been widened to every container to fix
// an unrelated rack-count bug.
//
// Drums ride pallets, two or four to a pallet. They do not SHARE a sticker.
// Those two facts agree for bags and diverge for drums, and conflating them is
// the whole defect. These tests pin the rule at the only place it can be
// enforced: whether the form asks at all.

import { describe, it, expect } from 'vitest';
import { asksPerPallet, isPalletisedUnit, unitOptions } from
  '../components/receipt/useReceiptForm';

// The corporate/walk-in screen keeps its own copy of this rule because it is
// driven by `unit_label` (singular: 'drum') rather than the receipt form's
// plural `quantityUnits`. Duplicated on purpose, so it is duplicated in the
// test too — the point is that BOTH answer the same way.
const INCOMING_PALLETISED = new Set(['bag', 'box', 'bottle', 'case', 'pail']);
const incomingAsksPerPallet = (unit) =>
  INCOMING_PALLETISED.has(String(unit || '').toLowerCase().replace(/s$/, ''));

describe('who gets asked "how many per pallet"', () => {
  // The regression. Every one of these is labelled and pulled individually.
  it.each(['drums', 'barrels', 'totes'])('never asks for %s', (unit) => {
    expect(asksPerPallet(unit)).toBe(false);
    expect(isPalletisedUnit(unit)).toBe(false);
  });

  it.each(['bags', 'bottles', 'cases', 'pails'])('always asks for %s', (unit) => {
    expect(asksPerPallet(unit)).toBe(true);
  });

  // A field that is required must be on screen, or it cannot be answered.
  it('asks exactly when it requires', () => {
    for (const { value } of unitOptions) {
      expect(asksPerPallet(value)).toBe(isPalletisedUnit(value));
    }
  });

  // Measures, and the pallet itself — nothing to count per pallet.
  it.each(['gallons', 'liters', 'pallets', '', null, undefined])(
    'stays quiet for %s', (unit) => {
      expect(asksPerPallet(unit)).toBe(false);
    },
  );
});

describe('the incoming screen agrees with the receipt form', () => {
  // Singular there, plural here — same verdict either way, or a drum logged
  // through one door behaves differently from the same drum through the other.
  it.each([
    ['drum', 'drums'],
    ['barrel', 'barrels'],
    ['tote', 'totes'],
    ['bag', 'bags'],
    ['bottle', 'bottles'],
    ['pail', 'pails'],
    ['case', 'cases'],
  ])('%s / %s', (singular, plural) => {
    expect(incomingAsksPerPallet(singular)).toBe(asksPerPallet(plural));
  });
});

// Hiding an input does not empty it. The first attempt at this fix only stopped
// the form ASKING, which left every line raised beforehand still carrying its
// figure: the modal prefilled from `line.units_per_pallet`, sent it to the
// server, wrote it to the freshly minted lot and printed 19 pallet stickers for
// 76 drums — with nothing on screen to explain where the number came from.
describe('a figure stored before the rule existed', () => {
  // Mirrors the prefill at IncomingTab.jsx:377.
  const prefill = (line) =>
    line.units_per_pallet == null || !incomingAsksPerPallet(line.unit_label)
      ? ''
      : String(line.units_per_pallet);

  // Mirrors submitStart: what actually reaches the server.
  const sent = (line, typed) =>
    (incomingAsksPerPallet(line.unit_label) ? Number(typed) || 0 : 0) || null;

  it('is not loaded into the hidden field for drums', () => {
    expect(prefill({ unit_label: 'drum', units_per_pallet: 4 })).toBe('');
  });

  it('is still loaded for bags, where the field is visible', () => {
    expect(prefill({ unit_label: 'bag', units_per_pallet: 50 })).toBe('50');
  });

  it('is never sent to the server for drums', () => {
    expect(sent({ unit_label: 'drum' }, '4')).toBeNull();
  });

  it('is sent for bags', () => {
    expect(sent({ unit_label: 'bag' }, '50')).toBe(50);
  });

  // 76 drums at a stored 4 printed "19 pallet stickers" on the button.
  it('prints one sticker per drum, not per pallet', () => {
    const per = sent({ unit_label: 'drum' }, '4') || 0;
    expect(per > 1 ? Math.ceil(76 / per) : 76).toBe(76);
    expect(per > 1 ? 'pallet' : 'unit').toBe('unit');
  });
});

describe('switching the container type drops the figure', () => {
  // Both forms hide the input on switch; neither used to clear it, so a value
  // typed under "bags" survived into a drum line invisibly.
  const onUnitChange = (unit, prev) =>
    incomingAsksPerPallet(unit)
      ? { ...prev, unit_label: unit }
      : { ...prev, unit_label: unit, units_per_pallet: '' };

  it('bags 50 then switch to drum leaves nothing behind', () => {
    const after = onUnitChange('drum', { unit_label: 'bag', units_per_pallet: '50' });
    expect(after.units_per_pallet).toBe('');
  });

  it('bag to bottle keeps it — both are wrapped', () => {
    const after = onUnitChange('bottle', { unit_label: 'bag', units_per_pallet: '50' });
    expect(after.units_per_pallet).toBe('50');
  });
});

describe('what a blank per-pallet means downstream', () => {
  // Mirrors IncomingTab's print decision and PrintStickersDialog's default:
  // `per > 1` is the only test, so a blank collapses every consumer to
  // one-sticker-one-scan without any of them knowing about drums.
  const scopeFor = (per) => (Number(per) > 1 ? 'pallet' : 'unit');
  const printCount = (units, per) =>
    Number(per) > 1 ? Math.ceil(units / per) : units;

  it('69 drums print 69 unit stickers', () => {
    const per = null;                       // never collected for drums
    expect(scopeFor(per)).toBe('unit');
    expect(printCount(69, per)).toBe(69);
  });

  it('500 bags at 50 print 10 pallet stickers', () => {
    expect(scopeFor(50)).toBe('pallet');
    expect(printCount(500, 50)).toBe(10);
  });

  // One drum, one scan. The multiplier is what would have doubled stock.
  it('offers no multiplier without a per-pallet figure', () => {
    const perScan = (unitsPerPallet) =>
      unitsPerPallet && unitsPerPallet > 1 ? unitsPerPallet : 1;
    expect(perScan(null)).toBe(1);
    expect(perScan(50)).toBe(50);
  });
});
