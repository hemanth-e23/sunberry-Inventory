// Browser re-check of PART 2/3 (2026-10-02): N5 loader, N8 wording.
import { describe, it, expect, vi } from 'vitest';
import { effectiveRequestStatus, loadCloseOutData, stagedLinesSummary } from '../utils/stagingDesk';
import { requestStatusLabel } from '../utils/stagingPull';
import { addByUnit, formatByUnit, singleUnit, totalLabel } from '../components/reports/reportUtils';

vi.mock('../api/client', () => ({ default: {} }));

describe('loadCloseOutData (N5)', () => {
  it('syncs first and loads with Production when it answers', async () => {
    const client = {
      post: vi.fn(() => Promise.resolve({ data: {} })),
      get: vi.fn(() => Promise.resolve({ data: { items: [] } })),
    };
    const out = await loadCloseOutData(client, 'sr1');
    expect(out).toEqual({ data: { items: [] }, productionError: null });
    expect(client.get).toHaveBeenCalledWith('/service/staging-requests/sr1/close-out-data', undefined);
  });

  it('falls back to local figures when the sync fails', async () => {
    const client = {
      post: vi.fn(() => Promise.reject({ response: { data: { detail: 'Production app is not reachable.' } } })),
      get: vi.fn(() => Promise.resolve({ data: { items: [1] } })),
    };
    const out = await loadCloseOutData(client, 'sr1');
    expect(out.productionError).toBe('Production app is not reachable.');
    expect(out.data).toEqual({ items: [1] });
    expect(client.get).toHaveBeenCalledWith(
      '/service/staging-requests/sr1/close-out-data', { params: { skip_production: true } },
    );
  });

  it('throws only when the local figures cannot be loaded either', async () => {
    const client = {
      post: vi.fn(() => Promise.reject(new Error('Network Error'))),
      get: vi.fn(() => Promise.reject(new Error('boom'))),
    };
    await expect(loadCloseOutData(client, 'sr1')).rejects.toThrow('boom');
  });
});

describe('request card wording (N8)', () => {
  // QA-BATCH-2: Mango 474 of 1500 staged, Citric nothing, Ascorbic 55 of 110.
  const groups = [
    { quantity_fulfilled: 474, allFulfilled: false, anyStagingItems: true },
    { quantity_fulfilled: 0, allFulfilled: false, anyStagingItems: false },
    { quantity_fulfilled: 55, allFulfilled: false, anyStagingItems: true },
  ];

  it('counts lines with anything staged', () => {
    expect(stagedLinesSummary(groups).label).toBe('2/3 items staged (0 in full)');
    expect(stagedLinesSummary([{ allFulfilled: true, quantity_fulfilled: 5 }]).label).toBe('1/1 item staged');
    expect(stagedLinesSummary([]).label).toBe('0/0 items staged');
  });

  it('a pending request with stock staged is in progress', () => {
    expect(effectiveRequestStatus('pending', groups)).toBe('in_progress');
    expect(effectiveRequestStatus('pending', [groups[1]])).toBe('pending');
    expect(effectiveRequestStatus('closed', groups)).toBe('closed');
  });

  it('the gun list never says "Not started" with stock staged', () => {
    expect(requestStatusLabel({ status: 'pending', fulfilled_qty: 474, needed_qty: 1500 })).toBe('Partly staged');
    expect(requestStatusLabel({ status: 'pending', fulfilled_qty: 1500, needed_qty: 1500 })).toBe('All staged');
    expect(requestStatusLabel({ status: 'pending', fulfilled_qty: 0, needed_qty: 1500 })).toBe('Not started');
    expect(requestStatusLabel({ status: 'in_progress', fulfilled_qty: 10 })).toBe('In progress');
  });
});

describe('Shipments report units (N8)', () => {
  it('says the unit instead of "cases"', () => {
    expect(totalLabel(singleUnit([{ unit: 'lbs' }, { unit: 'lbs' }]))).toBe('Total Lbs');
    expect(totalLabel(singleUnit([{ unit: 'cases' }, {}]))).toBe('Total Cases');
    expect(totalLabel(singleUnit([{ unit: 'lbs' }, { unit: 'cases' }]))).toBe('Total');
  });

  it('mixed units are listed per unit, never added together', () => {
    const by = {};
    addByUnit(by, 'lbs', 474);
    addByUnit(by, 'lbs', 1000);
    addByUnit(by, 'cases', 40);
    expect(formatByUnit(by)).toBe('1,474 lbs + 40 cases');
  });
});
