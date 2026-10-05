/**
 * The receipt review showed only "Quantity 5775 lbs" for 105 boxes of ascorbic
 * on 3 pallets (production, 2026-10-05). The approver needs what was entered:
 * how many, the weight of each, full pallets and the partial one.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReceiptsTab from '../../components/approvals/ReceiptsTab';

vi.mock('../../context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: () => Promise.resolve(true) }) }));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast: () => {} }) }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', username: 'sup' } }) }));
vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => ({
    productCategories: [], vendors: [], locations: [], subLocationMap: {},
    productionShifts: [], productionLines: [], approveReceipt: vi.fn(),
    rejectReceipt: vi.fn(), sendBackReceipt: vi.fn(), updateReceipt: vi.fn(), refreshReceipts: vi.fn(),
  }),
}));

const receipt = {
  id: 'r-asc', productId: 'p-asc', categoryId: 'c-raw', status: 'recorded',
  quantity: 5775, quantityUnits: 'lbs', containerCount: 105, containerUnit: 'cases',
  weightPerContainer: 55, weightUnit: 'lbs', unitsPerPallet: 35, lotNo: '1250113067',
  submittedAt: new Date().toISOString(), receiptDate: '2026-10-05', submittedBy: 'u-brad',
};

const renderTab = () => render(
  <ReceiptsTab
    productLookup={{ 'p-asc': { id: 'p-asc', name: 'ASCORBIC ACID (SB)', sid: 'S525109' } }}
    categoryLookup={{ 'c-raw': { id: 'c-raw', name: 'Raw Materials', type: 'raw' } }}
    vendorLookup={{}} locationLookupMap={{}} receiptLookup={{ 'r-asc': receipt }}
    rowLookup={{}} shiftLookup={{}} lineLookup={{}} userNameMap={{ 'u-brad': 'BradA' }}
    getFinishedGoodsLocation={() => null}
    todaysPending={[receipt]} backlogPending={[]} approvedHistory={[]}
    searchQuery="" setSearchQuery={() => {}} categoryFilter="" setCategoryFilter={() => {}}
    dateRangeFilter="all" setDateRangeFilter={() => {}}
  />,
);

describe('receipt review shows the count', () => {
  it('card and review say how many, weight each, and pallets', () => {
    renderTab();
    expect(screen.getAllByText(/3 full pallets of 35/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText(/Review & Approve/)[0]);
    expect(screen.getByText(/Count \(cases\)/)).toBeTruthy();
    expect(screen.getByText(/Weight each/)).toBeTruthy();
    expect(screen.getByText(/105 × 55 = 5,775/)).toBeTruthy();
  });
});
