/**
 * One mapper owns the receipt shape.
 *
 * InventoryContext used to keep a private near-copy of ReceiptContext's
 * `mapReceipt`, and both wrote to the SAME receipts state. The copy drifted: it
 * omitted `materialLotId`, so approving a hold or an adjustment re-fetched
 * receipts through the lesser mapper and stripped that field from every receipt
 * in the store.
 *
 * Nothing errored. The approvals card reads `materialLotId` to decide whether a
 * receipt has scanned counts worth checking, so every "paperwork vs scanned"
 * panel silently vanished until the next full reload — and an absent panel reads
 * as "this receipt had no scanning", which is a very different and much more
 * comfortable claim than "we lost the field".
 *
 * This pins the fields that the approvals path depends on.
 */
import { describe, it, expect } from 'vitest'
import { mapReceipt } from '../context/domains/ReceiptContext'

const products = [{ id: 'prod-1', name: 'Orange Juice Concentrate', sid: 'S528572' }]
const categories = [{ id: 'cat-raw', type: 'raw' }]

const apiReceipt = {
  id: 'rcpt-ee3ca1fcb29d',
  product_id: 'prod-1',
  category_id: 'cat-raw',
  quantity: 7410,
  unit: 'lbs',
  lot_number: 'M019116',
  status: 'recorded',
  material_lot_id: 'mlot-c5b9e79c53f6',
  container_count: 13,
  container_unit: 'drum',
  units_per_pallet: 4,
  note: 'Received against incoming order IN-000010',
}

describe('mapReceipt', () => {
  it('carries material_lot_id through — the approvals panel depends on it', () => {
    const mapped = mapReceipt(apiReceipt, products, categories)
    expect(mapped.materialLotId).toBe('mlot-c5b9e79c53f6')
  })

  it('leaves materialLotId null rather than undefined when absent', () => {
    // A legacy receipt was never counted in, so there is nothing to check. The
    // card tests this field for truthiness, so null and undefined behave the
    // same — but null says "asked and answered" rather than "never mapped".
    const { material_lot_id, ...legacy } = apiReceipt
    const mapped = mapReceipt(legacy, products, categories)
    expect(mapped.materialLotId).toBeNull()
  })

  it('keeps the other fields the approvals list reads', () => {
    const mapped = mapReceipt(apiReceipt, products, categories)
    expect(mapped.id).toBe('rcpt-ee3ca1fcb29d')
    expect(mapped.status).toBe('recorded')
    expect(mapped.lotNo).toBe('M019116')
    expect(mapped.quantity).toBe(7410)
    expect(mapped.productId).toBe('prod-1')
  })
})
