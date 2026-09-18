import React, { useState } from 'react';
import { Wifi, WifiOff, RefreshCw, X, AlertTriangle } from 'lucide-react';
import { listScans } from '../../utils/scanQueue';
import { formatTime } from '../../utils/dateUtils';
import LicenceDisplay from './LicenceDisplay';
import './NetworkStatus.css';

/**
 * Compact connectivity + queue indicator for the scanner header.
 *
 * Props:
 *   online        bool   — measured reachability (NOT raw navigator.onLine)
 *   pendingCount  int    — scans in localStorage waiting to flush
 *   failedCount   int    — scans the server rejected (terminal)
 *   syncing       bool   — a drain pass is running right now
 *   lastSyncError string — why the last attempt failed, for the operator
 *   lastSyncAt    string — ISO timestamp of the last attempt
 *   onRetry       fn     — re-queue all failed
 *   onDropFailed  fn(id) — remove a single failed item
 *   onForceSync   fn     — force a drain attempt
 *
 * "Sync now" is deliberately NOT disabled when we believe we are offline. It is
 * the operator's override for exactly the case where that belief is wrong, and
 * gating it on the belief is what left a gun holding 26 unsendable scans with
 * no way to push them.
 */
const NetworkStatus = ({
  online,
  pendingCount,
  failedCount,
  syncing = false,
  lastSyncError = null,
  lastSyncAt = null,
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
    ? (pendingCount > 0 ? `Offline · ${pendingCount}` : 'Offline')
    : failedCount > 0
      ? `${failedCount} failed`
      : `${pendingCount} pending`;

  // Pending items already tried and pushed back. The driver should be able to
  // read WHY their scans are not going through without a laptop and a console.
  const stuck = listScans().filter((s) => s.state === 'pending' && (s.attempts || 0) > 1);

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
            <strong>{syncing ? 'Syncing…' : (online ? 'Online' : 'Offline')}</strong>
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
          {lastSyncAt && (
            <div className="network-status__panel-row network-status__muted">
              <span>Last try</span>
              <span>{formatTime(lastSyncAt)}</span>
            </div>
          )}
          {lastSyncError && (
            <div className="network-status__reason">
              <AlertTriangle size={13} /> <span>{lastSyncError}</span>
            </div>
          )}
          <div className="network-status__panel-actions">
            <button
              type="button"
              className="network-status__btn"
              onClick={() => { onForceSync?.(); }}
              disabled={syncing || pendingCount === 0}
            >
              <RefreshCw size={14} /> {syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              className="network-status__btn network-status__btn--warn"
              onClick={() => { onRetry?.(); }}
              disabled={syncing || failedCount === 0}
            >
              Retry failed
            </button>
          </div>

          {stuck.length > 0 && (
            <div className="network-status__failed-list">
              <div className="network-status__list-title">
                Not going through ({stuck.length})
              </div>
              {stuck.slice(0, 20).map((s) => (
                <div key={s.id} className="network-status__failed">
                  <div>
                    <code>{s.payload?.licence_number
                      ? <LicenceDisplay licence={s.payload.licence_number} />
                      : (s.payload?.serial || s.requestId)}</code>
                    <small>{s.lastError || 'Waiting to send'} · {s.attempts} tries</small>
                  </div>
                </div>
              ))}
            </div>
          )}

          {failedCount > 0 && (
            <div className="network-status__failed-list">
              <div className="network-status__list-title">Failed ({failedCount})</div>
              {listScans()
                .filter((s) => s.state === 'failed')
                .map((s) => (
                  <div key={s.id} className="network-status__failed">
                    <div>
                      <code>{s.payload?.licence_number
                    ? <LicenceDisplay licence={s.payload.licence_number} />
                    /* Ingredient container scans identify the drum by `serial`
                       (ContainerScanRequest has no licence_number), so without
                       this fallback a failed drum scan renders as a blank code
                       and the driver cannot tell WHICH drum failed. */
                    : (s.payload?.serial || s.requestId)}</code>
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
