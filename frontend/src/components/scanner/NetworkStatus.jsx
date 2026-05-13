import React, { useState } from 'react';
import { Wifi, WifiOff, RefreshCw, X } from 'lucide-react';
import { listScans } from '../../utils/scanQueue';
import LicenceDisplay from './LicenceDisplay';
import './NetworkStatus.css';

/**
 * Compact connectivity + queue indicator for the scanner header.
 *
 * Props:
 *   online        bool
 *   pendingCount  int   — scans in localStorage waiting to flush
 *   failedCount   int   — scans the server rejected (terminal)
 *   onRetry       fn    — re-queue all failed
 *   onDropFailed  fn(id)— remove a single failed item
 *   onForceSync   fn    — force a drain attempt
 */
const NetworkStatus = ({
  online,
  pendingCount,
  failedCount,
  onRetry,
  onDropFailed,
  onForceSync,
}) => {
  const [open, setOpen] = useState(false);
  const totalQueued = pendingCount + failedCount;
  const showChip = !online || totalQueued > 0;
  if (!showChip) return null;

  const variant = !online ? 'offline' : (failedCount > 0 ? 'warn' : 'pending');
  const Icon = online ? Wifi : WifiOff;
  const label = !online
    ? 'Offline'
    : failedCount > 0
      ? `${failedCount} failed`
      : `${pendingCount} pending`;

  return (
    <div className={`network-status network-status--${variant}`}>
      <button
        type="button"
        className="network-status__chip"
        onClick={() => setOpen((v) => !v)}
        aria-label="Network status"
      >
        <Icon size={16} />
        <span>{label}</span>
        {totalQueued > 0 && <span className="network-status__count">{totalQueued}</span>}
      </button>

      {open && (
        <div className="network-status__panel" role="dialog">
          <div className="network-status__panel-row">
            <strong>{online ? 'Online' : 'Offline'}</strong>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="network-status__close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <div className="network-status__panel-row">
            <span>Pending sync</span>
            <strong>{pendingCount}</strong>
          </div>
          <div className="network-status__panel-row">
            <span>Failed</span>
            <strong>{failedCount}</strong>
          </div>
          <div className="network-status__panel-actions">
            <button
              type="button"
              className="network-status__btn"
              onClick={() => { onForceSync?.(); }}
              disabled={!online || pendingCount === 0}
            >
              <RefreshCw size={14} /> Sync now
            </button>
            <button
              type="button"
              className="network-status__btn network-status__btn--warn"
              onClick={() => { onRetry?.(); }}
              disabled={failedCount === 0}
            >
              Retry failed
            </button>
          </div>
          {failedCount > 0 && (
            <div className="network-status__failed-list">
              {listScans()
                .filter((s) => s.state === 'failed')
                .map((s) => (
                  <div key={s.id} className="network-status__failed">
                    <div>
                      <code><LicenceDisplay licence={s.payload?.licence_number} /></code>
                      <small>{s.lastError}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDropFailed?.(s.id)}
                      className="network-status__drop"
                      aria-label="Discard"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NetworkStatus;
