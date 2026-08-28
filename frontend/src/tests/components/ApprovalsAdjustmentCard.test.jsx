/**
 * Pending Adjustments cards were blank for Finished Goods.
 *
 * Reported from production: 20 cards all reading "Unknown Product", lot number
 * "—", and no quantity anywhere on the card. A supervisor was being asked to
 * approve stock removals without being told the product, the lot, or how many
 * cases would disappear.
 *
 * Same root cause as the lot-trace bug: a Finished Goods adjustment is
 * pallet-based and carries no receiptId (the form sends pallet_licence_ids
 * instead), and this card resolved the product, the lot and the whole quantity
 * panel through `receiptLookup[adjustment.receiptId]`. With no receipt, all
 * three came out empty and the panel was hidden entirely.
 *
 * The adjustment itself has always carried productId, quantity and
 * palletLicenceIds — the card just never looked at them.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdjustmentsTab from '../../components/approvals/AdjustmentsTab';

vi.mock('../../context/ConfirmContext', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'sup' } }),
}));
vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => ({ approveAdjustment: vi.fn(), rejectAdjustment: vi.fn() }),
}));

const productLookup = { 'prod-gt': { id: 'prod-gt', name: '128 OZ GREEN TEA' } };
const categoryLookup = { 'cat-fg': { id: 'cat-fg', name: 'Finished Goods' } };
const userNameMap = { 'u-teja': 'Teja' };

/** Exactly the shape that produced the blank cards: no receiptId. */
const fgAdjustment = {
  id: 'adj-1',
  receiptId: null,
  productId: 'prod-gt',
  categoryId: 'cat-fg',
  adjustmentType: 'stock-correction',
  quantity: 700,
  reason: 'Shipped',
  palletLicenceIds: ['pl-1', 'pl-2', 'pl-3', 'pl-4', 'pl-5'],
  status: 'pending',
  submittedBy: 'u-teja',
  submittedAt: new Date().toISOString(),
};

const renderTab = (adjustments, receiptLookup = {}) =>
  render(
    <AdjustmentsTab
      pendingAdjustments={adjustments}
      receiptLookup={receiptLookup}
      productLookup={productLookup}
      categoryLookup={categoryLookup}
      userNameMap={userNameMap}
    />
  );

describe('Pending Adjustments card — pallet-based (Finished Goods)', () => {
  it('names the product instead of "Unknown Product"', () => {
    renderTab([fgAdjustment]);

    expect(screen.getByText('128 OZ GREEN TEA')).toBeInTheDocument();
    expect(screen.queryByText('Unknown Product')).not.toBeInTheDocument();
  });

  it('shows how many cases the approval removes', () => {
    // The panel used to be hidden outright, so the card carried no quantity.
    renderTab([fgAdjustment]);

    expect(screen.getByText('Quantity Impact')).toBeInTheDocument();
    expect(screen.getByText('−700')).toBeInTheDocument();
    expect(screen.getByText(/from 5 pallets/)).toBeInTheDocument();
  });

  it('labels the pallet count rather than showing an empty lot', () => {
    renderTab([fgAdjustment]);

    expect(screen.getByText('Pallets')).toBeInTheDocument();
    expect(screen.queryByText('Lot Number')).not.toBeInTheDocument();
  });

  it('says "pallet" singular for one', () => {
    renderTab([{ ...fgAdjustment, palletLicenceIds: ['pl-1'], quantity: 140 }]);
    expect(screen.getByText(/from 1 pallet$/)).toBeInTheDocument();
  });

  it('still carries the category and reason through', () => {
    renderTab([fgAdjustment]);

    expect(screen.getByText('Finished Goods')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
  });
});

describe('Pending Adjustments card — lot-based (raw material) is unchanged', () => {
  const rmAdjustment = {
    ...fgAdjustment,
    id: 'adj-2',
    receiptId: 'rec-1',
    palletLicenceIds: [],
    quantity: 50,
  };
  const receiptLookup = {
    'rec-1': {
      id: 'rec-1',
      productId: 'prod-gt',
      categoryId: 'cat-fg',
      lotNo: 'MP22026L1',
      quantity: 500,
      quantityUnits: 'lbs',
    },
  };

  it('keeps the lot number and the before/after panel', () => {
    renderTab([rmAdjustment], receiptLookup);

    expect(screen.getByText('Lot Number')).toBeInTheDocument();
    expect(screen.getByText('MP22026L1')).toBeInTheDocument();
    expect(screen.queryByText('Pallets')).not.toBeInTheDocument();

    // Current 500, removing 50, after 450 — and in the receipt's own unit.
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('450')).toBeInTheDocument();
    expect(screen.getAllByText('lbs').length).toBeGreaterThan(0);
  });
});
