/**
 * Regression guard for the request storm that took production down twice
 * (2026-08-10 and 2026-08-12).
 *
 * PalletTagPrintPage prefetches pallet licences for every finished-goods
 * receipt on screen. The effect depended on `availableReceipts`, a useMemo
 * derived from `palletsByReceipt` — the very state each fetch writes. So every
 * completed request produced a new array identity, re-ran the effect, and
 * started another pool of workers on top of those already running. Nothing
 * cancelled the previous pools, the concurrency cap applied per run rather than
 * globally, and the in-flight guard read stale state so it never deduplicated.
 *
 * A single browser tab issued roughly 800 requests in four minutes, which
 * exhausted the server's connection pool and took the whole API down with it.
 *
 * The invariant this test protects: N finished-goods receipts must produce at
 * most N requests. Not N per render, and not an unbounded number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const fetchPalletLicences = vi.fn()

const RECEIPT_COUNT = 12

// productId, lotNo AND quantity are all required by the component's filter —
// a receipt missing any of them never reaches the prefetch stage.
const receipts = Array.from({ length: RECEIPT_COUNT }, (_, i) => ({
  id: `rcpt-${i}`,
  status: 'approved',
  productId: 'prod-fg',
  lotNo: `LOT-${i}`,
  quantity: 100,
  companyId: 'co-1',
}))

// Every receipt is finished goods, so every one is eligible for prefetch.
const products = [{ id: 'prod-fg', name: 'FG Product', categoryId: 'cat-fg', fcc: 'FCC1' }]
const categories = [{ id: 'cat-fg', name: 'Finished', type: 'finished' }]

vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => ({
    receipts,
    products,
    categories,
    companies: [{ id: 'co-1', name: 'Sunberry' }],
    locations: [],
    storageAreas: [],
    storageRows: [],
    vendors: [],
    fetchPalletLicences,
  }),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role: 'admin', name: 'Tester' } }),
}))

vi.mock('../../App', () => ({ getDashboardPath: () => '/' }))

// jsPDF and JsBarcode touch canvas APIs jsdom does not implement; this test
// never exercises printing, only the prefetch effect.
vi.mock('jspdf', () => ({ default: vi.fn(() => ({})) }))
vi.mock('jsbarcode', () => ({ default: vi.fn() }))

const importPage = async () => (await import('../../components/PalletTagPrintPage')).default

describe('PalletTagPrintPage background prefetch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Each receipt resolves with one in-building pallet, so the receipt stays
    // in the filtered list — the case where the feedback loop used to run
    // forever rather than settling.
    //
    // The latency is essential, not incidental. It is what leaves requests in
    // flight while the effect re-runs, which is how the old code stacked
    // worker pools. With an instantly-resolving mock React settles between
    // renders and even the buggy version looks well-behaved — a test without
    // this delay passes against the bug and proves nothing.
    fetchPalletLicences.mockImplementation(async ({ receipt_id }) => {
      await new Promise((r) => setTimeout(r, 40))
      return [
        { id: `${receipt_id}-pl-0`, licence_number: `${receipt_id}-LIC`, status: 'in_stock' },
      ]
    })
  })

  it('issues at most one request per receipt, not one per re-render', async () => {
    const PalletTagPrintPage = await importPage()
    render(<PalletTagPrintPage />)

    await waitFor(() => {
      expect(fetchPalletLicences).toHaveBeenCalledTimes(RECEIPT_COUNT)
    }, { timeout: 4000 })

    // Let any runaway re-trigger have time to fire. Before the fix, request
    // count kept climbing here because each state write re-ran the effect.
    const settled = fetchPalletLicences.mock.calls.length
    await new Promise((r) => setTimeout(r, 400))

    expect(fetchPalletLicences.mock.calls.length).toBe(settled)
    expect(settled).toBeLessThanOrEqual(RECEIPT_COUNT)

    // And each receipt was fetched exactly once — no duplicates from workers
    // racing on a stale in-flight guard.
    const ids = fetchPalletLicences.mock.calls.map(([args]) => args.receipt_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not retry forever when the API keeps failing', async () => {
    // A failed fetch used to cache [], which put the receipt straight back in
    // the fetch list — an unbounded retry loop against an already-struggling
    // server, which is the worst possible moment to hammer it.
    fetchPalletLicences.mockRejectedValue(new Error('boom'))

    const PalletTagPrintPage = await importPage()
    render(<PalletTagPrintPage />)

    await waitFor(() => {
      expect(fetchPalletLicences).toHaveBeenCalled()
    }, { timeout: 4000 })

    await new Promise((r) => setTimeout(r, 500))
    expect(fetchPalletLicences.mock.calls.length).toBeLessThanOrEqual(RECEIPT_COUNT)
  })
})
