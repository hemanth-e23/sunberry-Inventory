/**
 * The pallet picker showed a raw database id where the rack name belongs.
 *
 * Reported from production: the Finished Goods Adjustment picker listed
 * "Row: fg-row-1768398053661" under every pallet. Nobody in the warehouse can
 * match that against anything — the racks are labelled AA11, AI171, Dock 2.
 *
 * The API had the name all along: pallet_licences.py:67 resolves
 * `storage_row_name` from the joined row and the schema exposes it
 * (schemas/scanner.py:51). The component simply read `storage_row_id`.
 *
 * The search box had the same bug, so its "Search licence, lot, row..."
 * placeholder was a promise it could not keep — typing a real rack name
 * matched nothing.
 *
 * PalletPicker is shared by the Adjustments, Holds and Transfers tabs, so this
 * covers all three.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PalletPicker from '../../components/inventory/PalletPicker';

const pallets = [
  {
    id: 'pl-1',
    licence_number: 'MP23026L2-GVN16C-001',
    lot_number: 'MP23026L2',
    storage_row_id: 'fg-row-1768398053661',
    storage_row_name: 'AI171',
    cases: 140,
  },
  {
    id: 'pl-2',
    licence_number: 'MP23026L2-GVN16C-002',
    lot_number: 'MP23026L2',
    storage_row_id: 'fg-row-9999999999999',
    storage_row_name: 'AA11',
    cases: 140,
  },
];

const renderPicker = (props = {}) =>
  render(
    <PalletPicker
      pallets={pallets}
      selectedIds={[]}
      onChange={() => {}}
      {...props}
    />
  );

describe('PalletPicker row labelling', () => {
  it('shows the rack name, never the internal row id', () => {
    renderPicker();

    expect(screen.getByText(/Row:\s*AI171/)).toBeInTheDocument();
    expect(screen.getByText(/Row:\s*AA11/)).toBeInTheDocument();
    expect(screen.queryByText(/fg-row-/)).not.toBeInTheDocument();
  });

  it('falls back to the id if the row name did not resolve', () => {
    // Better to surface an unresolved id than to silently drop the row.
    render(
      <PalletPicker
        pallets={[{ ...pallets[0], storage_row_name: null }]}
        selectedIds={[]}
        onChange={() => {}}
      />
    );
    expect(screen.getByText(/Row:\s*fg-row-1768398053661/)).toBeInTheDocument();
  });

  it('omits the row entirely when the pallet has no location', () => {
    render(
      <PalletPicker
        pallets={[{ ...pallets[0], storage_row_name: null, storage_row_id: null }]}
        selectedIds={[]}
        onChange={() => {}}
      />
    );
    expect(screen.queryByText(/Row:/)).not.toBeInTheDocument();
  });

  it('searches by rack name, which is what the placeholder promises', async () => {
    const user = userEvent.setup();
    renderPicker();

    const box = screen.getByPlaceholderText(/search/i);
    await user.type(box, 'AI171');

    expect(screen.getByText('MP23026L2-GVN16C-001')).toBeInTheDocument();
    // AA11's pallet must drop out of the list.
    expect(screen.queryByText('MP23026L2-GVN16C-002')).not.toBeInTheDocument();
  });

  it('still matches licence and lot', async () => {
    const user = userEvent.setup();
    renderPicker();

    const box = screen.getByPlaceholderText(/search/i);
    await user.type(box, 'GVN16C-002');

    expect(screen.getByText('MP23026L2-GVN16C-002')).toBeInTheDocument();
    expect(screen.queryByText('MP23026L2-GVN16C-001')).not.toBeInTheDocument();
  });
});
