import React from 'react';
import './OutgoingDashboard.css';

// Shared lifecycle visuals for the ship-out flow: status chip, the mini
// pipeline on dashboard truck cards, and the big stepper on the order detail.

export const LIFECYCLE_STEPS = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'checked_in', label: 'Checked In' },
  { key: 'scanning', label: 'Loading' },
  { key: 'reconciled', label: 'Finalized' },
  { key: 'docs_generated', label: 'Docs' },
];

// Index of the CURRENT step for a status. docs_generated returns steps.length
// so every step renders as done.
export const stageIndex = (status) => {
  switch (status) {
    case 'scheduled': return 0;
    case 'checked_in': return 1;
    case 'scanning': return 2;
    case 'pending': return 2; // legacy ad-hoc orders go straight to the gun
    case 'reconciled': return 3;
    case 'complete': return 3;
    case 'docs_generated': return LIFECYCLE_STEPS.length;
    default: return -1; // cancelled / unknown
  }
};

const FALLBACK_LABELS = {
  scheduled: 'Scheduled',
  checked_in: 'Checked In',
  scanning: 'Loading',
  pending: 'On Gun',
  reconciled: 'Finalized',
  complete: 'Complete',
  docs_generated: 'Docs Ready',
  cancelled: 'Cancelled',
};

export const StatusChip = ({ status, label }) => (
  <span className={`og-chip og-chip-${status || 'scheduled'}`}>
    {['checked_in', 'scanning'].includes(status) && <span className="og-live-dot" />}
    {label || FALLBACK_LABELS[status] || status}
  </span>
);

export const MiniPipeline = ({ status }) => {
  const idx = stageIndex(status);
  if (idx < 0) return null;
  return (
    <div className="og-pipe">
      {LIFECYCLE_STEPS.map((s, i) => (
        <div key={s.key} className={`og-pipe-step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>
          <span className="dot">{i < idx ? '✓' : ''}</span>
          <span className="lbl">{s.label}</span>
        </div>
      ))}
    </div>
  );
};

export const BigStepper = ({ status, subs = {} }) => {
  const idx = stageIndex(status);
  if (idx < 0) return null;
  return (
    <div className="og-stepper">
      {LIFECYCLE_STEPS.map((s, i) => (
        <div key={s.key} className={`og-step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>
          <span className="dot">{i < idx ? '✓' : i + 1}</span>
          <span className="lbl">{s.label}</span>
          {subs[s.key] && <span className="sub">{subs[s.key]}</span>}
        </div>
      ))}
    </div>
  );
};
