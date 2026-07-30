import React, { useEffect } from 'react';
import { CheckCircle2, XCircle, Info } from 'lucide-react';
import './ScanFeedback.css';

const DEFAULT_MS = { success: 900, error: 1800, info: 1500 };

const ScanFeedback = ({ kind, message, onDismiss, duration }) => {
  const ms = duration ?? DEFAULT_MS[kind] ?? 600;

  useEffect(() => {
    if (!kind) return undefined;
    const t = setTimeout(() => onDismiss?.(), ms);
    return () => clearTimeout(t);
  }, [kind, message, ms, onDismiss]);

  if (!kind) return null;

  return (
    <div
      className={`scan-feedback scan-feedback--${kind}`}
      onClick={onDismiss}
      role="alert"
      aria-live="assertive"
    >
      <div className="scan-feedback-icon">
        {kind === 'success' && <CheckCircle2 size={160} strokeWidth={2.5} />}
        {kind === 'info' && <Info size={160} strokeWidth={2.5} />}
        {kind !== 'success' && kind !== 'info' && <XCircle size={160} strokeWidth={2.5} />}
      </div>
      {message && <div className="scan-feedback-msg">{message}</div>}
    </div>
  );
};

export default ScanFeedback;
