// The "scan the last pallet at the wrapper" answer, per lot, for the forklift
// review card (FG-PALLET-LIFECYCLE-SPEC §3.3). The card used to show it only
// when something was wrong, so a clean close looked the same as no close.

const NOT_COUNTED = new Set(['cancelled', 'not_produced']);

const pad = (n) => String(n).padStart(3, '0');

/**
 * One entry per lot on the request:
 *   { lot, kind: 'match' | 'after' | 'skipped' | 'not_closed' | 'none',
 *     sequence, highest, from, to, at }
 * - match:      closing number is at or below the highest scanned number
 * - after:      closing number is above it — from..to were never scanned
 * - skipped:    the driver skipped the closing scan
 * - not_closed: auto-submitted without one
 * - none:       no answer (e.g. a session from before the closing scan existed)
 */
export const closingSummary = (fr, licences) => {
  const highestByLot = {};
  for (const pl of licences || []) {
    if (NOT_COUNTED.has(pl.status) || pl.sequence == null) continue;
    const lot = pl.lot_number || fr.lot_number;
    if (!lot) continue;
    highestByLot[lot] = Math.max(highestByLot[lot] || 0, pl.sequence);
  }
  const scans = fr.closing_scans || {};
  // closing_status is the server's own per-lot verdict; read it too, so a
  // response carrying only that still shows the right badge.
  const status = fr.closing_status || {};
  const lots = new Set([...Object.keys(highestByLot), ...Object.keys(scans), ...Object.keys(status)]);
  if (!lots.size && fr.lot_number) lots.add(fr.lot_number);

  return [...lots].sort().map((lot) => {
    const entry = scans[lot];
    const highest = highestByLot[lot] || 0;
    if (entry && entry.sequence != null) {
      const sequence = Number(entry.sequence);
      if (sequence > highest) {
        return { lot, kind: 'after', sequence, highest, from: highest + 1, to: sequence, at: entry.at };
      }
      return { lot, kind: 'match', sequence, highest, at: entry.at };
    }
    if ((entry && entry.skipped) || status[lot] === 'skipped') {
      return { lot, kind: 'skipped', highest, at: entry?.at };
    }
    if (fr.auto_submitted_at) return { lot, kind: 'not_closed', highest };
    return { lot, kind: 'none', highest };
  });
};

export const closingLabel = (c) => {
  switch (c.kind) {
    case 'match':
      return `Last pallet at wrapper: #${pad(c.sequence)} — matches`;
    case 'after':
      return c.from === c.to
        ? `Last pallet at wrapper: #${pad(c.sequence)} — #${pad(c.from)} not scanned`
        : `Last pallet at wrapper: #${pad(c.sequence)} — #${pad(c.from)}–${pad(c.to)} not scanned`;
    case 'skipped':
      return 'Closing scan skipped — last pallet unknown';
    case 'not_closed':
      return 'Not closed — last pallet unknown';
    default:
      return 'No closing scan';
  }
};

export const CLOSING_COLORS = {
  match: { background: '#dcfce7', color: '#166534' },
  after: { background: '#fef3c7', color: '#92400e' },
  skipped: { background: '#fee2e2', color: '#991b1b' },
  not_closed: { background: '#fee2e2', color: '#991b1b' },
  none: { background: '#f3f4f6', color: '#4b5563' },
};
