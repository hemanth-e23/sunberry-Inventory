import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { formatDate, formatDateKey, formatTime } from '../utils/dateUtils';
import { ROLES, CATEGORY_TYPES, CYCLE_CHECK_SESSION_IDLE_MINUTES, isWeighedMaterialType } from '../constants';
import { groupCountHistory } from '../utils/cycleCheck';
import CountSheetPanel from './CountSheetPanel';
import './Shared.css';
import './CycleCountingPage.css';

// Category types that can be on a count sheet (clients without any are not
// offered in the Client filter).
const isCountableType = (type) =>
  type === CATEGORY_TYPES.FINISHED || type === CATEGORY_TYPES.PACKAGING || isWeighedMaterialType(type);

// ─────────────────────────────────────────────────────────────────────────────

const CycleCountingPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    productCategories,
    categoryGroups,
    locations,
    storageAreas,
    cycleCounts,
    refreshCycleCounts,
    locationLookup,
  } = useAppData();

  const [selectedCycleCount, setSelectedCycleCount] = useState(null);
  const [openSession, setOpenSession] = useState(null);

  // Category groups = clients (Sunberry, Arizona, etc.) — only groups that
  // have at least one category of a countable type.
  const clientGroups = useMemo(() => {
    const groupsWithInventory = new Set(
      productCategories
        .filter(c => isCountableType(c.type) && c.parentId)
        .map(c => c.parentId)
    );
    return categoryGroups.filter(g => groupsWithInventory.has(g.id));
  }, [categoryGroups, productCategories]);

  // Sheet scope: a room (sub-location — its racks and its default rows like
  // Cage or staging) or a rack area.
  const roomOptions = useMemo(() => (locations || [])
    .flatMap(l => (l.subLocations || []).map(s => ({ id: s.id, label: `${l.name} / ${s.name}` })))
    .sort((a, b) => a.label.localeCompare(b.label)), [locations]);
  const areaOptions = useMemo(() => (storageAreas || [])
    .map(a => ({ id: a.id, label: `${locationLookup?.[a.locationId]?.name || '—'} / ${a.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label)), [storageAreas, locationLookup]);

  // ─── History filter ────────────────────────────────────────────────────────

  const filteredCycleCounts = useMemo(() => {
    const isAdmin = [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SUPERADMIN, ROLES.CORPORATE_ADMIN]
      .includes(user?.role);
    if (isAdmin) return cycleCounts;
    // Use ID-based filter — performedById is always set and doesn't depend on display name format
    return cycleCounts.filter(c => c.performedById === user?.id);
  }, [cycleCounts, user]);

  // One line per gun count session (a walk of rows), one per count sheet.
  const historyEntries = useMemo(
    () => groupCountHistory(filteredCycleCounts, CYCLE_CHECK_SESSION_IDLE_MINUTES),
    [filteredCycleCounts],
  );

  // A count's "where": a submitted sheet's scope, else its location.
  const countWhere = (count) => (count.summary?.scope
    || locationLookup?.[count.location]?.name
    || count.location
    || 'All Locations');

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="cycle-counting-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <h1>Cycle Counting / Physical Inventory</h1>
        <p className="page-description">
          Make a count sheet by rack row, walk it (on screen or printed), and submit — changes apply immediately, like the gun.
        </p>

        <CountSheetPanel
          clientGroups={clientGroups}
          roomOptions={roomOptions}
          areaOptions={areaOptions}
          onSubmitted={refreshCycleCounts}
        />

        {/* ── Count history ────────────────────────────────────────────────── */}
        <div className="count-history-panel">
          <h2>Count History</h2>
          {historyEntries.length > 0 ? (
            <div className="table-wrapper">
              <table className="history-table cc-history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Count</th>
                    <th>Performed By</th>
                    <th>Time</th>
                    <th className="text-right">Checked</th>
                    <th className="text-right">OK</th>
                    <th className="text-right">Differences</th>
                    <th className="text-right" title="Pallets not here (marked missing)">Not here</th>
                    <th className="text-right" title="Missing / not-produced pallets found again">Found</th>
                    <th className="text-right" title="Pallets the system had in another row">Moved</th>
                    <th className="text-right" title="Pallets created from their sticker">Created</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {historyEntries.map(entry => {
                    if (entry.type === 'session') {
                      const open = openSession === entry.key;
                      const diff = entry.rowsWithDifferences;
                      return (
                        <React.Fragment key={entry.key}>
                          <tr
                            className={`cc-session-line${open ? ' open' : ''}`}
                            onClick={() => setOpenSession(open ? null : entry.key)}
                            style={{ cursor: 'pointer' }}
                            aria-expanded={open}
                          >
                            <td>{formatDate(entry.countDate)}</td>
                            <td>
                              <span className="cc-caret">{open ? '▾' : '▸'}</span> Gun row checks
                            </td>
                            <td>{entry.performedBy || '—'}</td>
                            <td>{formatTime(entry.startedAt)}–{formatTime(entry.endedAt)}</td>
                            <td className="text-right">{entry.rowsChecked} row{entry.rowsChecked === 1 ? '' : 's'}</td>
                            <td className="text-right">{entry.rowsOk}</td>
                            <td className={`text-right ${diff ? 'variance-shortage' : 'variance-ok'}`}>{diff}</td>
                            <td className="text-right">{entry.notHere}</td>
                            <td className="text-right">{entry.found}</td>
                            <td className="text-right">{entry.movedIn}</td>
                            <td className="text-right">{entry.created}</td>
                            <td>
                              <span className={diff === 0 ? 'status-ok' : 'status-warning'}>
                                {diff === 0 ? '✓ OK' : '⚠ Differences'}
                              </span>
                            </td>
                          </tr>
                          {open && (
                            <tr className="cc-session-detail">
                              <td colSpan={12}>
                                {entry.inferred && (
                                  <p className="cc-session-note">
                                    Grouped from separate checks (same person, same day, no gap over {CYCLE_CHECK_SESSION_IDLE_MINUTES} min).
                                  </p>
                                )}
                                <table className="detail-table cc-session-rows">
                                  <thead>
                                    <tr>
                                      <th>Row</th>
                                      <th>Time</th>
                                      <th>Product</th>
                                      <th>Lot #</th>
                                      <th className="text-right">Expected</th>
                                      <th className="text-right">Counted</th>
                                      <th>Pallets</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {entry.rows.map(r => {
                                      const items = r.items.length ? r.items : [null];
                                      return items.map((item, i) => (
                                        <tr key={`${r.id}-${i}`} className={r.ok ? '' : 'cc-row-diff'}>
                                          {i === 0 && (
                                            <>
                                              <td rowSpan={items.length} className="cc-rowname">
                                                {r.rowName}
                                                <div className={r.ok ? 'variance-ok' : 'variance-shortage'} style={{ fontSize: '12px' }}>
                                                  {r.ok ? '✓ OK' : '⚠ Difference'}
                                                </div>
                                              </td>
                                              <td rowSpan={items.length}>{formatTime(r.checkedAt)}</td>
                                            </>
                                          )}
                                          {item ? (
                                            <>
                                              <td>{item.productName}</td>
                                              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.lotNo}</td>
                                              <td className="text-right">{item.expectedQuantity ?? 0}</td>
                                              <td className={`text-right variance-${item.status}`}>{item.actualQuantity ?? 0}</td>
                                              <td className="cc-pallet-notes">
                                                {item.notHere?.length > 0 && <div>Not here (now missing): {[...item.notHere].sort().join(', ')}</div>}
                                                {item.arrived?.length > 0 && <div>Arrived: {[...item.arrived].sort((a, b) => String(a.licence_number).localeCompare(String(b.licence_number))).map(a => `${a.licence_number} (${a.result})`).join(', ')}</div>}
                                                {!item.notHere?.length && !item.arrived?.length && '—'}
                                              </td>
                                            </>
                                          ) : (
                                            <td colSpan={5} style={{ color: '#6b7280' }}>System said empty; nothing scanned.</td>
                                          )}
                                        </tr>
                                      ));
                                    })}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    }
                    const count = entry.count;
                    const variances = count.summary?.variancesCount ?? 0;
                    const total = count.summary?.totalItems ?? 0;
                    return (
                      <tr
                        key={entry.key}
                        onClick={() => setSelectedCycleCount(count)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>{formatDate(count.countDate)}</td>
                        <td>{entry.sheetNo ? <>Count sheet <span className="cs-sheet-no">{entry.sheetNo}</span></> : 'Count sheet'} · {countWhere(count)}</td>
                        <td>{count.performedBy || '—'}</td>
                        <td>{count.createdAt ? formatTime(count.createdAt) : '—'}</td>
                        <td className="text-right">{total} item{total === 1 ? '' : 's'}</td>
                        <td className="text-right">{Math.max(0, total - variances)}</td>
                        <td className={`text-right ${variances !== 0 ? 'variance-shortage' : 'variance-ok'}`}>{variances}</td>
                        <td className="text-right">—</td>
                        <td className="text-right">—</td>
                        <td className="text-right">—</td>
                        <td className="text-right">—</td>
                        <td>
                          <span className={variances === 0 ? 'status-ok' : 'status-warning'}>
                            {variances === 0 ? '✓ OK' : '⚠ Variance'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">No cycle count history yet.</div>
          )}
        </div>

        {/* ── History detail modal ─────────────────────────────────────────── */}
        {selectedCycleCount && (
          <div className="modal-overlay" onClick={() => setSelectedCycleCount(null)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>
                  {selectedCycleCount.summary?.sheet_no ? `${selectedCycleCount.summary.sheet_no} — ` : 'Count Details — '}
                  {formatDate(selectedCycleCount.countDate)}
                </h2>
                <button className="close-button" onClick={() => setSelectedCycleCount(null)}>×</button>
              </div>
              <div className="modal-body">
                <div className="detail-section">
                  <h3>Summary</h3>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <span className="detail-label">Date</span>
                      <span className="detail-value">{formatDate(selectedCycleCount.countDate)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Location</span>
                      <span className="detail-value">{countWhere(selectedCycleCount)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Performed By</span>
                      <span className="detail-value">{selectedCycleCount.performedBy || '—'}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Items Counted</span>
                      <span className="detail-value">{selectedCycleCount.summary?.totalItems ?? 0}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Items with Variance</span>
                      <span className={`detail-value ${(selectedCycleCount.summary?.variancesCount ?? 0) !== 0 ? 'variance-shortage' : 'variance-ok'}`}>
                        {selectedCycleCount.summary?.variancesCount ?? 0}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Shortages</span>
                      <span className="detail-value">{selectedCycleCount.summary?.shortages ?? 0}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Overages</span>
                      <span className="detail-value">{selectedCycleCount.summary?.overages ?? 0}</span>
                    </div>
                  </div>
                </div>

                {selectedCycleCount.summary?.skipped?.some(s => s.licence_number) && (
                  <div className="detail-section">
                    <h3>Pallets not applied</h3>
                    <p className="cs-muted">
                      {selectedCycleCount.summary.skipped.filter(s => s.licence_number)
                        .map(s => `${s.licence_number} (${s.row_name}): ${s.reason}`).join(' · ')}
                    </p>
                  </div>
                )}

                {selectedCycleCount.items?.length > 0 && (
                  <div className="detail-section">
                    <h3>Item Details</h3>
                    <div className="table-wrapper">
                      <table className="detail-table">
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Lot #</th>
                            <th>Expires</th>
                            <th>Location</th>
                            <th className="text-right">System</th>
                            <th className="text-right">Physical</th>
                            <th className="text-right">Variance</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedCycleCount.items.map((item, idx) => (
                            <React.Fragment key={idx}>
                            <tr>
                              <td>{item.productName}</td>
                              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.lotNo}</td>
                              <td>{item.expiryDate ? formatDateKey(item.expiryDate) : '—'}</td>
                              <td>{item.location || '—'}</td>
                              <td className="text-right">{(item.expectedQuantity ?? 0).toLocaleString()}</td>
                              <td className="text-right">{(item.actualQuantity ?? 0).toLocaleString()}</td>
                              <td className={`text-right variance-${item.status}`}>
                                {item.variance > 0 ? '+' : ''}{(item.variance ?? 0).toLocaleString()}
                              </td>
                              <td>
                                <span className={`status-badge-${item.status}`}>
                                  {item.status === 'ok' ? '✓' : item.status === 'skipped' ? 'Skipped' : item.status === 'recorded' ? 'Recorded only' : '⚠'}
                                </span>
                              </td>
                            </tr>
                            {/* Gun row check: the pallet numbers behind the difference.
                                Count sheet: why a line was not applied. */}
                            {(item.notHere?.length > 0 || item.arrived?.length > 0 || item.skipReason) && (
                              <tr>
                                <td colSpan={8} style={{ fontSize: '12px', color: '#6b7280' }}>
                                  {item.skipReason && <>Not applied: {item.skipReason}. </>}
                                  {item.notHere?.length > 0 && <>Not here (now missing): {item.notHere.join(', ')}. </>}
                                  {item.arrived?.length > 0 && <>Found here: {item.arrived.map((a) => `${a.licence_number} (${a.result})`).join(', ')}.</>}
                                </td>
                              </tr>
                            )}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CycleCountingPage;
