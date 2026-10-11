import React, { useEffect, useState } from 'react';
import { Scan } from 'lucide-react';
import { CLOSING_SCAN_SKIP_SECONDS } from '../../constants';

// "Scan the last pallet at the wrapper" (FG pallet lifecycle §3.3). Asked on
// Submit and when the first pallet of a new lot arrives (midnight rollover —
// for the OLD lot). The scan box stays live the whole time; Skip only appears
// after a short countdown so it isn't the reflex answer. Deliberately does NOT
// show the last scanned number.
const ClosingPrompt = ({ reason, onSkip, busy }) => {
  const [left, setLeft] = useState(CLOSING_SCAN_SKIP_SECONDS);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return (
    <div className="scanner-receipt-closing" role="alert">
      <Scan size={22} color="#1d4ed8" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <strong>Scan the last pallet at the wrapper</strong>
        <div className="scanner-receipt-overfill-detail">
          {reason === 'rollover'
            ? 'A new lot started — scan the last pallet of the old lot.'
            : 'Before submitting, scan the last pallet the wrapper made.'}
        </div>
      </div>
      <button
        type="button"
        className="scanner-receipt-try-scan-btn"
        disabled={left > 0 || busy}
        onClick={onSkip}
      >
        {left > 0 ? `Skip (${left})` : 'Skip'}
      </button>
    </div>
  );
};

export default ClosingPrompt;
