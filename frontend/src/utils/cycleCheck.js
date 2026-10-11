// Gun cycle check helpers (FG pallet lifecycle §4.1).

// Same matching as ScannerReceiptFlow.handleRowScan: the row name with or
// without its "FG-" prefix, the row id, or the printed rack barcode.
const stripFg = (s) => s.replace(/^FG[- ]?/, '');

export const matchRow = (rows, raw) => {
  const scanned = String(raw || '').trim().toUpperCase();
  if (!scanned) return null;
  // The prefix may be on either side: a row stored as "FG-AJ11" scanned as
  // "AJ11", or a row stored as "AJ11" whose sticker reads "FG-AJ11".
  const scannedBare = stripFg(scanned);
  return rows.find((r) => {
    const rowName = (r.name || '').toUpperCase();
    const nameOnly = stripFg(rowName);
    return nameOnly === scanned || rowName === scanned || (scannedBare && nameOnly === scannedBare)
      || r.id === String(raw).trim()
      || (r.barcode && r.barcode.toUpperCase() === scanned);
  }) || null;
};

// Pallets the checker says are NOT in the row: every pallet of a group tapped
// "Not here", plus single pallets tapped, minus any pallet actually scanned.
export const notHereIds = (groups, groupNotHere, palletNotHere, scanned) => {
  const ids = new Set();
  for (const g of groups) {
    for (const p of g.pallets) {
      if (scanned.has(p.licence_number)) continue;
      if (groupNotHere.has(g.key) || palletNotHere.has(p.id)) ids.add(p.id);
    }
  }
  return [...ids];
};
