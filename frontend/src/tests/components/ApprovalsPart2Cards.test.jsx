/**
 * Browser test 2026-10-01, PART 2 — approval cards.
 *
 * B4/B5  The hold card printed the named receipt's hold-time weight and the
 *        receipt's last-transfer room ("QA Quarantine") for a lot sitting on
 *        QA-D3/QA-D4. It now reads the lot's current status from the server.
 * B8     A mixed-weight lot's transfer read "1506 lbs" with no drum count.
 * G4     Shipped Out carries a reason, and the card shows it and the notes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HoldsTab from '../../components/approvals/HoldsTab';
import TransfersTab from '../../components/approvals/TransfersTab';

vi.mock('../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: () => Promise.resolve(true) }),
}));
vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'sup' } }),
}));
// One stable object: the card's effects depend on these functions, and a new
// identity every render re-runs them forever.
const appData = {
  approveHoldAction: vi.fn(), rejectHoldAction: vi.fn(),
  approveTransfer: vi.fn(), rejectTransfer: vi.fn(),
  fetchTransferScanProgress: vi.fn(), voidShipOutTransfer: vi.fn(),
};
vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => appData,
}));

const receipt = {
  id: 'r1', productId: 'p1', categoryId: 'c1', lotNo: 'B-0910',
  quantity: 5688, quantityUnits: 'lbs', heldQuantity: 5688,
  subLocationId: 'sub-quar', locationId: 'loc-barn',
  weightPerContainer: 474, containerUnit: 'drums',
};
const productLookup = { p1: { id: 'p1', name: 'Guava Concentrate' } };
const categoryLookup = { c1: { id: 'c1', name: 'Raw' } };
const locationLookupMap = { 'sub-quar': 'QA Quarantine', 'loc-barn': 'QA Barn' };

describe('hold approval card', () => {
  const hold = {
    id: 'h1', receiptId: 'r1', action: 'release', reason: 'swab retest clean',
    status: 'pending', submittedBy: 'u2', submittedAt: new Date().toISOString(),
    palletLicenceIds: [],
    lotStatus: {
      quantity: 6162, unit: 'lbs', units: 13, unit_label: 'drum',
      is_held: true, held_quantity: 6162, held_units: 13,
      location_label: 'QA Drum Room: QA-D3, QA-D4',
    },
  };

  it('shows the lot-wide held amount and the racks it is on', () => {
    render(
      <HoldsTab
        pendingHolds={[hold]} receiptLookup={{ r1: receipt }} productLookup={productLookup}
        categoryLookup={categoryLookup} locationLookupMap={locationLookupMap} userNameMap={{}}
      />
    );
    expect(screen.getAllByText('13 drums · 6,162 lbs').length).toBeGreaterThan(0);
    expect(screen.getByText('QA Drum Room: QA-D3, QA-D4')).toBeInTheDocument();
    expect(screen.queryByText('QA Quarantine')).not.toBeInTheDocument();
    expect(screen.queryByText(/5688/)).not.toBeInTheDocument();
  });
});

describe('transfer approval card', () => {
  const base = {
    id: 't1', receiptId: 'r1', status: 'pending', submittedBy: 'u2',
    submittedAt: new Date().toISOString(), palletLicenceIds: [],
    destinationBreakdown: [],
  };

  it('shows the drum count the server priced per rack', () => {
    const transfer = {
      ...base, transferType: 'warehouse-transfer', quantity: 1506, reason: '',
      sourceBreakdown: [{ id: 'row-d4', quantity: 1506 }],
      containerUnits: 3, containerUnit: 'drum',
      sourceUnits: [{ id: 'row-d4', quantity: 1506, units: 3 }],
    };
    render(
      <TransfersTab
        pendingTransfers={[transfer]} receiptLookup={{ r1: receipt }} productLookup={productLookup}
        rowLookup={{ d4: 'QA-D4' }} rowUnitLookup={{}} locationLookupMap={locationLookupMap}
        userNameMap={{}}
      />
    );
    expect(screen.getByText(/= 3 drums/, { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/QA-D4 — 1506 lbs = 3 drums/)).toBeInTheDocument();
  });

  it('shows why material is shipped out and the notes', () => {
    const transfer = {
      ...base, transferType: 'shipped-out', quantity: 948, orderNumber: 'RTV-QA-001',
      reason: 'positive swab — back to vendor', shipOutReason: 'return_to_vendor',
      shipOutReasonLabel: 'Return to vendor', sourceBreakdown: [],
    };
    render(
      <TransfersTab
        pendingTransfers={[transfer]} receiptLookup={{ r1: receipt }} productLookup={productLookup}
        rowLookup={{}} rowUnitLookup={{}} locationLookupMap={locationLookupMap} userNameMap={{}}
      />
    );
    expect(screen.getByText('Return to vendor')).toBeInTheDocument();
    expect(screen.getByText('positive swab — back to vendor')).toBeInTheDocument();
  });
});
