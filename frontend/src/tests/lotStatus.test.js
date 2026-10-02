/**
 * Browser test 2026-10-01, PART 2:
 *   B4 — hold screens printed one receipt's hold-time weight ("5,688 lbs")
 *        instead of the lot's current held amount (13 drums, 6,162 lb);
 *   B5 — the hold card's Location came from the receipt's last transfer;
 *   B6 — the RM dashboard card said "0 on hold" while a lot was held.
 */
import { describe, it, expect } from 'vitest'
import {
  describeLotQty, lotTotalText, lotHeldText, lotLocationText, rowHeldShare, countHeldLots,
} from '../utils/lotStatus'

const b0910 = {
  quantity: 6162, unit: 'lbs', units: 13, unit_label: 'drum',
  is_held: true, held_quantity: 6162, held_units: 13,
  location_label: 'QA Drum Room: QA-D3, QA-D4',
}

describe('lot status text', () => {
  it('shows the lot-wide held amount in drums and pounds', () => {
    expect(lotHeldText(b0910)).toBe('13 drums · 6,162 lbs')
    expect(lotTotalText(b0910)).toBe('13 drums · 6,162 lbs')
  })

  it('names the racks the lot is on, not the receipt room', () => {
    expect(lotLocationText(b0910)).toBe('QA Drum Room: QA-D3, QA-D4')
  })

  it('says nothing held for a released lot', () => {
    expect(lotHeldText({ ...b0910, is_held: false, held_quantity: 0, held_units: 0 })).toBeNull()
  })

  it('pluralises bags and boxes and leaves fractional counts out', () => {
    expect(describeLotQty(55, 'lbs', 1, 'bag')).toBe('1 bag · 55 lbs')
    expect(describeLotQty(2900, 'lbs', 58, 'box')).toBe('58 boxes · 2,900 lbs')
    expect(describeLotQty(100, 'lbs', 2.5, 'drum')).toBe('100 lbs')
  })
})

describe('RM dashboard hold count', () => {
  const tree = [{
    subLocations: [{
      rows: [
        { id: 'd3', liveLots: [{ materialLotId: 'lot-b', units: 9, isHeld: true }] },
        { id: 'd4', liveLots: [
          { materialLotId: 'lot-b', units: 4, isHeld: true },
          { materialLotId: 'lot-a', units: 20, isHeld: false },
        ] },
        { id: 'p1', hold: true, liveLots: [] },
        { id: 'p2', liveLots: [{ materialLotId: 'lot-c', units: 40, isHeld: false }] },
      ],
    }],
  }]

  it('counts a lot-level hold on its racks', () => {
    const rows = tree[0].subLocations[0].rows
    expect(rowHeldShare(rows[0])).toBe(1)
    expect(rowHeldShare(rows[1])).toBeCloseTo(4 / 24)
    expect(rowHeldShare(rows[2])).toBe(1)   // legacy rack flag
    expect(rowHeldShare(rows[3])).toBe(0)
  })

  it('counts distinct held lots, including a legacy held receipt', () => {
    const receipts = [
      { id: 'r1', materialLotId: null, hold: true, heldQuantity: 10 },
      // A pending transfer's review lock is not a hold.
      { id: 'r2', materialLotId: null, hold: true, heldQuantity: 0 },
      { id: 'r3', materialLotId: 'lot-b', hold: true, heldQuantity: 5688 },
    ]
    expect(countHeldLots(tree, receipts)).toBe(2)
  })
})
