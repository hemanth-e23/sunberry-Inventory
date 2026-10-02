import React from 'react';
import { WifiOff } from 'lucide-react';
import { formatTime } from '../../utils/dateUtils';

/**
 * The loud "you are offline" bar for the gun (browser test U1).
 *
 * The word "offline" never appeared during the test outage: the header chip
 * said "3 failed — gave up after 8 tries" while the rows said "Queued". A
 * worker needs one plain sentence: what is wrong, and that their scans are safe.
 *
 *   online      measured reachability from the scan queue
 *   queued      scans on this gun not yet on the server
 *   staleSince  epoch ms of the cached copy being shown, if any
 *   what        what the cached copy is ("truck", "line"…)
 */
const OfflineBanner = ({ online, queued = 0, staleSince = null, what = 'screen' }) => {
  if (online && !staleSince) return null;
  return (
    <div className="sir-offline" role="status" aria-live="polite">
      <WifiOff size={22} />
      <div>
        {!online ? (
          <>
            <strong>OFFLINE — the gun cannot reach the server</strong>
            <span>
              Scans are saved on this gun and send by themselves when it is back.
              {queued > 0 ? ` ${queued} waiting.` : ''}
            </span>
          </>
        ) : (
          <strong>Reconnecting…</strong>
        )}
        {staleSince && (
          <span className="sir-offline-stale">
            Showing this {what} as saved on the gun at {formatTime(new Date(staleSince).toISOString())}.
          </span>
        )}
      </div>
    </div>
  );
};

export default OfflineBanner;
