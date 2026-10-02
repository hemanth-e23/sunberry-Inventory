// Browser re-check of PART 2/3 (2026-10-02): N5 Close Out without the
// Production app, N7 Staging Overview's Return is the Production Requests
// dialog, N9 Mark as Used no longer blocks the tab with alert().
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn(() => Promise.resolve({ data: {} }));
const get = vi.fn(() => Promise.resolve({ data: {} }));
const addToast = vi.fn();
vi.mock('../../api/client', () => ({ default: { post: (...a) => post(...a), get: (...a) => get(...a) } }));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { role: 'supervisor' } }) }));
vi.mock('../../App', () => ({ getDashboardPath: () => '/' }));
vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => ({
    products: [{ id: 'p-mango', name: 'QA Mango Puree' }],
    receipts: [],
    locations: [{ id: 'barn', name: 'QA Barn' }],
    subLocationMap: {},
    locationsTree: [{ id: 'barn', name: 'QA Barn', subLocations: [
      { id: 'drums', name: 'QA Drum Room', rows: [{ id: 'd1', name: 'QA-D1' }, { id: 'd4', name: 'QA-D4' }] },
    ] }],
  }),
}));

import CloseOutModal from '../../components/staging/CloseOutModal';
import ReturnModal from '../../components/staging/ReturnModal';
import StagingOverview from '../../components/StagingOverview';

beforeEach(() => {
  post.mockReset();
  post.mockImplementation(() => Promise.resolve({ data: {} }));
  get.mockReset();
  addToast.mockReset();
});

const closeOutData = (leftover = 0) => ({
  request: { product_name: 'Nectar', production_date: '2026-10-02' },
  batches_completed: 0,
  total_batches: 2,
  items: [{
    ingredient_name: 'QA Mango Puree', unit: 'lbs', quantity_staged: 1422,
    quantity_used: 474, quantity_returned: 948 - leftover, leftover, staging_details: [],
  }],
});

describe('CloseOutModal — Production not reachable (N5)', () => {
  it('shows the local figures with a notice, and a supervisor closes after a confirm step', async () => {
    const onSuccess = vi.fn();
    render(<CloseOutModal requestId="sr1" data={closeOutData()} loading={false} error={null}
      productionError="Production app is not reachable. Please try again later."
      canCloseWithoutProduction onClose={() => {}} onSuccess={onSuccess} />);
    expect(screen.getByText('Production usage could not be fetched.')).toBeInTheDocument();
    expect(screen.getByText(/batches: not known/)).toBeInTheDocument();
    expect(screen.getByText(/474/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close out on these figures…' }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toContain('WITHOUT');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — close on these figures' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/service/staging-requests/sr1/close-out', { without_production: true },
    ));
    expect(onSuccess).toHaveBeenCalled();
  });

  it('Go back cancels the confirm', () => {
    render(<CloseOutModal requestId="sr1" data={closeOutData()} loading={false} error={null}
      productionError="down" canCloseWithoutProduction onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close out on these figures…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('a non-supervisor sees the figures but cannot close without Production', () => {
    render(<CloseOutModal requestId="sr1" data={closeOutData()} loading={false} error={null}
      productionError="down" canCloseWithoutProduction={false} onClose={() => {}} />);
    expect(screen.getByText(/Only a supervisor can close out/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close out on these figures…' })).toBeDisabled();
  });

  it('with Production reachable the close-out is the plain one', async () => {
    render(<CloseOutModal requestId="sr1" data={closeOutData()} loading={false} error={null}
      onClose={() => {}} />);
    expect(screen.queryByText('Production usage could not be fetched.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Complete Close Out' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/service/staging-requests/sr1/close-out', {}));
  });
});

describe('ReturnModal submitDetail (N7)', () => {
  it('posts each line through the given function with the full/weighed split', async () => {
    const submitDetail = vi.fn(() => Promise.resolve({}));
    const detail = {
      staging_item_id: 'si-1', lot_number: 'A-0925', available: 712, is_counted: true,
      weight_per_unit: 502, weight_unit: 'lbs', unit_label: 'drum',
      original_storage_row_id: 'd4', original_storage_row_name: 'QA-D4',
    };
    render(<ReturnModal requestId={null} item={{ id: 'si-1', ingredient_name: 'Mango' }}
      details={[detail]} submitDetail={submitDetail} onClose={() => {}} />);
    expect(screen.getByLabelText(/Return to Rack/)).toHaveValue('d4');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Return' }));
    await waitFor(() => expect(submitDetail).toHaveBeenCalled());
    const [d, body] = submitDetail.mock.calls[0];
    expect(d.staging_item_id).toBe('si-1');
    expect(body).toMatchObject({
      quantity: 712, full_units: 1, weighed_partial_qty: 210, to_storage_row_id: 'd4',
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('StagingOverview (N7, N9)', () => {
  const item = {
    id: 'si-1', product_id: 'p-mango', receipt_id: 'r1', status: 'staged',
    quantity_staged: 1422, quantity_used: 0, quantity_returned: 0,
    receipt: { lot_number: 'A-0925', unit: 'lbs' }, staged_at: null,
  };
  const renderOverview = () => render(<MemoryRouter><StagingOverview /></MemoryRouter>);

  it('Return opens the full dialog (rack choice, drums + weighed) and posts to the desk endpoint', async () => {
    get.mockImplementation((url) => {
      if (url === '/inventory/staging/items') return Promise.resolve({ data: [item] });
      if (url === '/inventory/staging/si-1/return-details') {
        return Promise.resolve({ data: {
          staging_item_id: 'si-1', lot_number: 'A-0925', available: 1422, is_counted: true,
          weight_per_unit: 474, weight_unit: 'lbs', unit_label: 'drum',
          original_storage_row_id: 'd4', original_storage_row_name: 'QA-D4',
        } });
      }
      return Promise.resolve({ data: {} });
    });
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'Return' }));
    const select = await screen.findByLabelText(/Return to Rack/);
    expect(select).toHaveValue('d4');
    expect(screen.queryByText(/Return Location \*\s*:/)).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'd1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Return' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/inventory/staging/si-1/return');
    expect(body).toMatchObject({ quantity: 1422, full_units: 3, to_storage_row_id: 'd1' });
  });

  it('Mark as Used confirms with a toast, never a blocking alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    get.mockImplementation(() => Promise.resolve({ data: [item] }));
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Used' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as Used' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Marked as used.', 'success'));
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
