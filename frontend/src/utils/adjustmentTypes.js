/**
 * Human labels for adjustment types (browser test PART 3, U6).
 *
 * The forms only offer the types a person may submit; the lists also show
 * system-written ones ("production-consumption" from staging and the
 * production sync), which printed raw. One table for every list and report.
 */
export const ADJUSTMENT_TYPE_LABELS = {
  'stock-correction': 'Stock Correction',
  'damage-reduction': 'Damage Reduction',
  donation: 'Donation',
  'trash-disposal': 'Trash Disposal',
  'quality-rejection': 'Quality Rejection',
  'used-in-production': 'Used in Production',
  'production-consumption': 'Production Consumption',
  'shipped-out': 'Shipped Out',
};

export const adjustmentTypeLabel = (type) => {
  if (!type) return '—';
  if (ADJUSTMENT_TYPE_LABELS[type]) return ADJUSTMENT_TYPE_LABELS[type];
  return String(type)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};
