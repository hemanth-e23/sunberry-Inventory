/**
 * Desk staging rules (browser test PART 3, 2026-10-02).
 *
 * Pure functions shared by QuickStageModal, MarkUsedModal, ReturnModal,
 * ProductionStagingRequests and StagingOverview, so the arithmetic is tested
 * once and the dialogs only render it.
 */

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const plural = (word, n) => {
  const w = String(word || 'unit');
  if (n === 1) return w;
  if (w.endsWith('s')) return w;
  return /(x|z|ch|sh)$/.test(w) ? `${w}es` : `${w}s`;
};

/**
 * Weight of the next `n` sealed containers off a rack, in the order a pull
 * takes them (oldest delivery first). `rack.unit_weights` is
 * `[{units, weight}]` from the server; a rack without it falls back to its
 * own average (`available_qty / available_units`, then `unit_weight`).
 *
 * A-0925's QA-D4 held 17 × 474 + 3 × 502: pricing every drum at one figure
 * is how the dialog showed 12,798 lbs for a 13,078 lb lot (B5).
 */
export const drumsWeight = (rack, n) => {
  let want = Math.max(0, Math.floor(Number(n) || 0));
  if (!rack || want === 0) return 0;
  let total = 0;
  for (const layer of rack.unit_weights || []) {
    if (want <= 0) break;
    const take = Math.min(want, Number(layer.units) || 0);
    total += take * (Number(layer.weight) || 0);
    want -= take;
  }
  if (want > 0) {
    const units = Number(rack.available_units) || 0;
    const avg = units > 0 && Number(rack.available_qty) > 0
      ? Number(rack.available_qty) / units
      : Number(rack.unit_weight) || 0;
    total += want * avg;
  }
  return round3(total);
};

/** Weighed content of the next `n` opened containers on a rack. */
export const openWeight = (rack, n) => {
  const count = Number(rack?.open_units) || 0;
  const take = Math.min(Math.max(0, Math.floor(Number(n) || 0)), count);
  if (!take || !count) return 0;
  return round3((Number(rack.open_remaining_qty) || 0) * (take / count));
};

/** Exact lbs of one rack allocation `{full, open}`. */
export const rackAllocationQty = (rack, alloc) =>
  round3(drumsWeight(rack, alloc?.full) + openWeight(rack, alloc?.open));

/** Exact lbs of one counted lot's allocation `{rowId: {full, open}}`. */
export const lotAllocationQty = (lot, allocByRow = {}) =>
  round3((lot?.racks || []).reduce(
    (sum, rack) => sum + rackAllocationQty(rack, allocByRow[rack.storage_row_id]),
    0,
  ));

/**
 * FEFO auto-allocation in WHOLE containers.
 *
 * Lots come FEFO-sorted from the server. A counted lot is filled rack by rack
 * (the server's order: fullest first), opened containers first — a part-used
 * drum is what a worker grabs before breaking a seal — then sealed drums one
 * at a time until the need is met. The last drum may overshoot: you cannot
 * carry 0.98 of a drum (the dialog used to allocate "992 lbs", B5). Legacy
 * lots keep their weight entry.
 *
 * Returns `{ counted: {receiptId: {rowId: {full, open}}}, legacy: {receiptId: qty} }`.
 */
export const autoAllocate = (lots, needed) => {
  const counted = {};
  const legacy = {};
  let remaining = Number(needed) || 0;
  for (const lot of lots || []) {
    if (remaining <= 0.001) break;
    if (!lot.is_counted) {
      const take = Math.min(Number(lot.available_quantity) || 0, remaining);
      if (take > 0) {
        legacy[lot.receipt_id] = round3(take);
        remaining -= take;
      }
      continue;
    }
    for (const rack of lot.racks || []) {
      if (remaining <= 0.001) break;
      const alloc = { full: 0, open: 0 };
      const opens = Number(rack.open_units) || 0;
      while (alloc.open < opens && remaining > 0.001) {
        const w = openWeight(rack, alloc.open + 1) - openWeight(rack, alloc.open);
        alloc.open += 1;
        remaining -= w;
      }
      const free = Number(rack.available_units) || 0;
      while (alloc.full < free && remaining > 0.001) {
        const w = drumsWeight(rack, alloc.full + 1) - drumsWeight(rack, alloc.full);
        alloc.full += 1;
        remaining -= w;
      }
      if (alloc.full || alloc.open) {
        counted[lot.receipt_id] = { ...(counted[lot.receipt_id] || {}), [rack.storage_row_id]: alloc };
      }
    }
  }
  return { counted, legacy };
};

/**
 * The `/inventory/staging/transfer` lots for one product: one entry per
 * counted (lot, rack) with the exact containers and their exact weight; one
 * per legacy lot with its typed weight.
 */
export const buildStageLots = (lots, counted = {}, legacy = {}) => {
  const out = [];
  for (const lot of lots || []) {
    if (lot.is_counted) {
      for (const rack of lot.racks || []) {
        const alloc = counted[lot.receipt_id]?.[rack.storage_row_id];
        const full = Math.max(0, Math.floor(Number(alloc?.full) || 0));
        const open = Math.max(0, Math.floor(Number(alloc?.open) || 0));
        if (!full && !open) continue;
        out.push({
          receipt_id: lot.receipt_id,
          quantity: rackAllocationQty(rack, { full, open }),
          source_row_id: rack.storage_row_id,
          full_units: full,
          open_units: open,
        });
      }
    } else {
      const qty = parseFloat(legacy[lot.receipt_id]);
      if (qty > 0) out.push({ receipt_id: lot.receipt_id, quantity: qty });
    }
  }
  return out;
};

/** "3 drums + 1 open · 1,632 lbs" for a counted allocation. */
export const describeAllocation = (lot, allocByRow = {}, unit = 'lbs') => {
  let full = 0;
  let open = 0;
  for (const rack of lot?.racks || []) {
    const a = allocByRow[rack.storage_row_id];
    full += Number(a?.full) || 0;
    open += Number(a?.open) || 0;
  }
  if (!full && !open) return '';
  const word = lot?.unit_label || 'unit';
  const parts = [];
  if (full) parts.push(`${full} ${plural(word, full)}`);
  if (open) parts.push(`${open} open`);
  return `${parts.join(' + ')} · ${lotAllocationQty(lot, allocByRow).toLocaleString()} ${unit}`;
};

/**
 * Close Out opens ON the production day (G1 decision), in the warehouse's
 * local day: `todayKey` is `getTodayDateKey()` (YYYY-MM-DD).
 */
export const closeOutAvailable = (productionDate, todayKey) =>
  Boolean(productionDate && todayKey && String(productionDate).slice(0, 10) <= todayKey);

/**
 * Load the Close Out reconciliation (N5). The Production app is synced first
 * so "used" includes what the floor scanned; when it cannot be reached the
 * dialog still opens, on this system's own staged / used / returned figures
 * (`skip_production=true`), with `productionError` saying why — instead of
 * a dead end that only said "Production app is not reachable".
 *
 * `client` is the axios instance. Resolves `{ data, productionError }`; throws
 * only when this system's own figures cannot be loaded either.
 */
export const loadCloseOutData = async (client, requestId) => {
  let productionError = null;
  try {
    await client.post(`/service/staging-requests/${requestId}/sync`, {});
  } catch (err) {
    productionError = err?.response?.data?.detail
      || 'The Production app could not be reached.';
  }
  const resp = await client.get(
    `/service/staging-requests/${requestId}/close-out-data`,
    productionError ? { params: { skip_production: true } } : undefined,
  );
  return { data: resp.data, productionError };
};

/**
 * The request card header count (N8): lines with ANYTHING staged, not only
 * the ones staged in full — QA-BATCH-2 read "0/3 items staged" with 474 and
 * 55 lbs staged. `groups` are the tracked, SID-consolidated lines
 * (`quantity_fulfilled`, `allFulfilled`, `anyStagingItems`).
 */
export const stagedLinesSummary = (groups = []) => {
  const total = groups.length;
  const staged = groups.filter(
    (g) => g.allFulfilled || g.anyStagingItems || (Number(g.quantity_fulfilled) || 0) > 0.001,
  ).length;
  const full = groups.filter((g) => g.allFulfilled).length;
  const label = `${staged}/${total} ${total === 1 ? 'item' : 'items'} staged`
    + (staged > full ? ` (${full} in full)` : '');
  return { staged, full, total, label };
};

/**
 * The status a request card shows (N8). A request still stored as "pending"
 * with stock staged reads "in_progress", never "Pending"/"Not started".
 */
export const effectiveRequestStatus = (status, groups = []) => {
  if (status !== 'pending') return status;
  const anyStaged = groups.some(
    (g) => g.anyStagingItems || (Number(g.quantity_fulfilled) || 0) > 0.001,
  );
  return anyStaged ? 'in_progress' : status;
};

/** A request past its production day (the red "OVERDUE" banner). */
export const isOverdue = (productionDate, todayKey) =>
  Boolean(productionDate && todayKey && String(productionDate).slice(0, 10) < todayKey);

/** "≈ 1.4 drums" for a staged weight, from the containers actually staged. */
export const unitsText = (qty, detail) => {
  const per = Number(detail?.staged_unit_weight) || 0;
  if (!(per > 0)) return '';
  const n = (Number(qty) || 0) / per;
  const shown = Math.abs(n - Math.round(n)) < 0.01 ? String(Math.round(n)) : n.toFixed(2);
  const word = detail?.unit_label || 'unit';
  return `${shown} ${plural(word, shown === '1' ? 1 : 2)}`;
};

/** Staging item statuses, in the order the Staging Overview filter lists them. */
export const STAGING_ITEM_STATUS_LABELS = {
  staged: 'Staged',
  partially_used: 'Partially used',
  partially_returned: 'Partially returned',
  used: 'Used',
  returned: 'Returned',
  completed: 'Closed (used + returned)',
};

export const ACTIVE_STAGING_STATUSES = ['staged', 'partially_used', 'partially_returned'];

/**
 * Staging Overview filter. `filter` is 'active', 'all', or one status.
 * "All" is every staged item, whatever became of it (B8).
 */
export const stagingItemMatchesFilter = (item, filter) => {
  const available = (Number(item.quantity_staged) || 0)
    - (Number(item.quantity_used) || 0) - (Number(item.quantity_returned) || 0);
  if (filter === 'all') return true;
  if (filter === 'active') {
    return available > 0.001 && ACTIVE_STAGING_STATUSES.includes(item.status);
  }
  return item.status === filter;
};

/**
 * Every active rack of the warehouse for the Return dialog (G2), from the
 * location tree (`locationsTree`, NOT the flat `locations` options).
 * `[{id, label, locationId, subLocationId}]`, sorted by label.
 */
export const activeRacks = (locationsTree = []) => {
  const out = [];
  for (const loc of locationsTree || []) {
    if (loc.active === false) continue;
    for (const sub of loc.subLocations || []) {
      if (sub.active === false) continue;
      for (const row of sub.rows || []) {
        if (!row.id || row.active === false) continue;
        out.push({
          id: row.id,
          label: `${loc.name} › ${sub.name} › ${row.name}`,
          locationId: loc.id,
          subLocationId: sub.id,
        });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
};
