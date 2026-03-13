import React, { useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import { useConfirm } from "../../context/ConfirmContext";
import { formatDateTime, formatDate, toDateKey } from "../../utils/dateUtils";
import { FORKLIFT_REQUEST_STATUS, PALLET_STATUS } from '../../constants';

const ForkliftTab = ({ pendingForkliftRequests, productLookup, rowLookup, lineLookup, userNameMap }) => {
  const { user } = useAuth();
  const {
    productionShifts,
    productionLines,
    storageAreas,
    approveForkliftRequest,
    rejectForkliftRequest,
    updateForkliftRequest,
    removePalletLicence,
    updatePalletLicence,
    addPalletToForkliftRequest,
    fetchForkliftRequests,
  } = useAppData();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [editingForkliftId, setEditingForkliftId] = useState(null);
  const [forkliftProcessingId, setForkliftProcessingId] = useState(null);
  const [forkliftRejectingId, setForkliftRejectingId] = useState(null);
  const [editingPalletId, setEditingPalletId] = useState(null);
  const [editPalletCases, setEditPalletCases] = useState('');
  const [addPalletForm, setAddPalletForm] = useState({ licence_number: '', storage_row_id: '', is_partial: false, partial_cases: '' });
  const [isAddingPallet, setIsAddingPallet] = useState(false);

  const allStorageRows = useMemo(() => {
    const rows = [];
    if (storageAreas && Array.isArray(storageAreas)) {
      storageAreas.forEach((area) => {
        (area.rows || []).forEach((row) => {
          if (row.is_active !== false) {
            rows.push({ id: row.id, name: row.name, areaName: area.name });
          }
        });
      });
    }
    return rows;
  }, [storageAreas]);

  if (pendingForkliftRequests.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
        <p>No pending forklift requests.</p>
      </div>
    );
  }

  return (
    <div className="card-grid">
      {pendingForkliftRequests.map((fr) => {
        const productName = fr.product?.name || productLookup[fr.product_id]?.name || 'Unknown';
        const fccCode = fr.product?.fcc_code || productLookup[fr.product_id]?.fcc_code || '';
        const shortCode = fr.product?.short_code || productLookup[fr.product_id]?.short_code || '';
        const licences = (fr.pallet_licences || []).filter(pl => pl.status !== FORKLIFT_REQUEST_STATUS.CANCELLED);
        const isEditing = editingForkliftId === fr.id;

        return (
          <article key={fr.id} className="approval-card" style={{ maxWidth: '720px' }}>
            <header>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: 0 }}>{productName}</h3>
                <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                  <span className="badge">{fr.lot_number || '—'}</span>
                  {fccCode && <span className="badge" style={{ background: '#e0e7ff', color: '#3730a3' }}>FCC: {fccCode}</span>}
                  {shortCode && <span className="badge" style={{ background: '#d1fae5', color: '#065f46' }}>{shortCode}</span>}
                </div>
              </div>
              <button
                type="button"
                className="secondary-button"
                style={{ fontSize: '13px', padding: '4px 12px' }}
                onClick={() => setEditingForkliftId(isEditing ? null : fr.id)}
              >
                {isEditing ? 'Done Editing' : 'Edit'}
              </button>
            </header>

            {/* Summary row */}
            <dl className="summary-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <div><dt>Pallets</dt><dd>{licences.length}</dd></div>
              <div><dt>Total Cases</dt><dd>{fr.total_cases ?? 0}</dd></div>
              <div><dt>Cases/Pallet</dt><dd>{fr.cases_per_pallet ?? '—'}</dd></div>
              <div><dt>Scanned By</dt><dd>{userNameMap[fr.scanned_by] || '—'}</dd></div>
            </dl>

            {/* Full details section */}
            <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '14px' }}>
                <div>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>Lot Number</span>
                  <div style={{ fontWeight: 600, marginTop: '2px' }}>{fr.lot_number || '—'}</div>
                </div>
                <div>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>Submitted</span>
                  <div style={{ marginTop: '2px' }}>{formatDateTime(fr.submitted_at || fr.created_at)}</div>
                </div>
                <div>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>Production Date</span>
                  {isEditing ? (
                    <input
                      type="date"
                      value={fr.production_date ? toDateKey(fr.production_date) : ''}
                      onChange={(e) => {
                        const val = e.target.value ? new Date(e.target.value + 'T00:00:00').toISOString() : null;
                        updateForkliftRequest(fr.id, { production_date: val });
                      }}
                      style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                    />
                  ) : (
                    <div style={{ marginTop: '2px', fontWeight: 600 }}>
                      {fr.production_date ? formatDate(fr.production_date) : '—'}
                    </div>
                  )}
                </div>
                <div>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>Expiration Date</span>
                  {isEditing ? (
                    <input
                      type="date"
                      value={fr.expiration_date ? toDateKey(fr.expiration_date) : ''}
                      onChange={(e) => {
                        const val = e.target.value ? new Date(e.target.value + 'T00:00:00').toISOString() : null;
                        updateForkliftRequest(fr.id, { expiration_date: val });
                      }}
                      style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                    />
                  ) : (
                    <div style={{ marginTop: '2px', fontWeight: 600 }}>
                      {formatDate(fr.expiration_date)}
                    </div>
                  )}
                </div>
                <div>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>Cases Per Pallet</span>
                  {isEditing ? (
                    <input
                      type="number"
                      min="1"
                      value={fr.cases_per_pallet ?? ''}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (val > 0) updateForkliftRequest(fr.id, { cases_per_pallet: val });
                      }}
                      style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                    />
                  ) : (
                    <div style={{ marginTop: '2px', fontWeight: 600 }}>{fr.cases_per_pallet ?? '—'}</div>
                  )}
                </div>
                <div>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>Line</span>
                  {isEditing ? (
                    <select
                      value={fr.line_id || ''}
                      onChange={(e) => updateForkliftRequest(fr.id, { line_id: e.target.value || null })}
                      style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                    >
                      <option value="">No line</option>
                      {(productionLines || []).map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ marginTop: '2px', fontWeight: 600 }}>
                      {fr.line_id ? (lineLookup[fr.line_id] || fr.line_id) : '—'}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Shift selector */}
            <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <strong style={{ fontSize: '14px' }}>Shift</strong>
              <select
                value={fr.shift_id || ''}
                onChange={(e) => updateForkliftRequest(fr.id, { shift_id: e.target.value || null })}
                style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px' }}
              >
                <option value="">Select shift</option>
                {(productionShifts || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {!fr.shift_id && <span style={{ color: '#ef4444', fontSize: '12px' }}>Required before approval</span>}
            </div>

            {/* Pallet licences - always visible */}
            <div style={{ marginBottom: '12px' }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>
                Pallet Licences ({licences.length})
              </h4>
              <div style={{ maxHeight: '300px', overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Licence #</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Row</th>
                      <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Cases</th>
                      <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Type</th>
                      <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Status</th>
                      {isEditing && <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {licences.map((pl) => (
                      <tr key={pl.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: '12px' }}>{pl.licence_number}</td>
                        <td style={{ padding: '8px 10px' }}>{rowLookup[pl.storage_row_id] || pl.storage_row_id || '—'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          {isEditing && editingPalletId === pl.id ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <input
                                type="number"
                                min="1"
                                value={editPalletCases}
                                onChange={(e) => setEditPalletCases(e.target.value)}
                                style={{ width: '60px', padding: '2px 6px', border: '1px solid #d1d5db', borderRadius: '4px', textAlign: 'center' }}
                                autoFocus
                              />
                              <button
                                type="button"
                                style={{ padding: '2px 6px', fontSize: '12px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                                onClick={async () => {
                                  const val = parseInt(editPalletCases);
                                  if (val > 0) {
                                    await updatePalletLicence(fr.id, pl.id, { cases: val, is_partial: val !== fr.cases_per_pallet });
                                  }
                                  setEditingPalletId(null);
                                  setEditPalletCases('');
                                }}
                              >Save</button>
                              <button
                                type="button"
                                style={{ padding: '2px 6px', fontSize: '12px', background: '#9ca3af', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                                onClick={() => { setEditingPalletId(null); setEditPalletCases(''); }}
                              >Cancel</button>
                            </span>
                          ) : (
                            <span
                              style={isEditing ? { cursor: 'pointer', borderBottom: '1px dashed #6b7280' } : {}}
                              onClick={() => {
                                if (isEditing) {
                                  setEditingPalletId(pl.id);
                                  setEditPalletCases(String(pl.cases));
                                }
                              }}
                              title={isEditing ? 'Click to edit cases' : ''}
                            >
                              {pl.cases}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          {pl.is_partial ? (
                            <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Partial</span>
                          ) : (
                            <span style={{ background: '#d1fae5', color: '#065f46', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Full</span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          {pl.status === PALLET_STATUS.MISSING_STICKER ? (
                            <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Missing Sticker</span>
                          ) : (
                            <span style={{ background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Pending</span>
                          )}
                        </td>
                        {isEditing && (
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            <button
                              type="button"
                              style={{ padding: '2px 8px', fontSize: '12px', background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: '4px', cursor: 'pointer' }}
                              onClick={async () => {
                                const ok = await confirm(`Remove pallet ${pl.licence_number}?`);
                                if (ok) {
                                  const result = await removePalletLicence(fr.id, pl.id);
                                  if (!result?.success) addToast(result?.error || 'Remove failed', 'error');
                                }
                              }}
                            >Remove</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Add Pallet form - only in edit mode */}
            {isEditing && (
              <div style={{ marginBottom: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '12px' }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>Add Missing Pallet</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div>
                    <label style={{ fontSize: '12px', color: '#6b7280', display: 'block', marginBottom: '2px' }}>Licence Number</label>
                    <input
                      type="text"
                      placeholder="e.g. MP04926L1-PFN640-002"
                      value={addPalletForm.licence_number}
                      onChange={(e) => setAddPalletForm(prev => ({ ...prev, licence_number: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: '#6b7280', display: 'block', marginBottom: '2px' }}>Storage Row</label>
                    <select
                      value={addPalletForm.storage_row_id}
                      onChange={(e) => setAddPalletForm(prev => ({ ...prev, storage_row_id: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }}
                    >
                      <option value="">Select row...</option>
                      {allStorageRows.map((r) => (
                        <option key={r.id} value={r.id}>{r.areaName} - {r.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                  <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <input
                      type="checkbox"
                      checked={addPalletForm.is_partial}
                      onChange={(e) => setAddPalletForm(prev => ({ ...prev, is_partial: e.target.checked }))}
                    />
                    Partial pallet
                  </label>
                  {addPalletForm.is_partial && (
                    <input
                      type="number"
                      min="1"
                      placeholder="Cases"
                      value={addPalletForm.partial_cases}
                      onChange={(e) => setAddPalletForm(prev => ({ ...prev, partial_cases: e.target.value }))}
                      style={{ width: '80px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px' }}
                    />
                  )}
                  <button
                    type="button"
                    disabled={!addPalletForm.licence_number || !addPalletForm.storage_row_id || isAddingPallet}
                    style={{
                      marginLeft: 'auto', padding: '6px 16px', fontSize: '13px', fontWeight: 600,
                      background: (!addPalletForm.licence_number || !addPalletForm.storage_row_id) ? '#d1d5db' : '#10b981',
                      color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer'
                    }}
                    onClick={async () => {
                      setIsAddingPallet(true);
                      const payload = {
                        licence_number: addPalletForm.licence_number.trim(),
                        storage_row_id: addPalletForm.storage_row_id,
                        is_partial: addPalletForm.is_partial,
                        partial_cases: addPalletForm.is_partial ? parseInt(addPalletForm.partial_cases) || null : null,
                      };
                      const result = await addPalletToForkliftRequest(fr.id, payload);
                      setIsAddingPallet(false);
                      if (result?.success) {
                        setAddPalletForm({ licence_number: '', storage_row_id: '', is_partial: false, partial_cases: '' });
                      } else {
                        addToast(result?.error || 'Failed to add pallet', 'error');
                      }
                    }}
                  >
                    {isAddingPallet ? 'Adding...' : 'Add Pallet'}
                  </button>
                </div>
              </div>
            )}

            <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                className="secondary-button"
                disabled={!fr.shift_id || forkliftProcessingId === fr.id}
                onClick={async () => {
                  if (!fr.shift_id) {
                    addToast('Please select a shift before approving.', 'error');
                    return;
                  }
                  setForkliftProcessingId(fr.id);
                  const result = await approveForkliftRequest(fr.id);
                  setForkliftProcessingId(null);
                  if (result?.success) {
                    fetchForkliftRequests();
                  } else {
                    addToast(result?.error || 'Approval failed', 'error');
                  }
                }}
              >
                {forkliftProcessingId === fr.id ? 'Approving...' : 'Approve'}
              </button>
              <button
                type="button"
                className="secondary-button danger"
                disabled={forkliftRejectingId === fr.id}
                onClick={() => {
                  confirm('Reject this forklift request? All pallet licences will be cancelled.').then(async (ok) => {
                    if (!ok) return;
                    setForkliftRejectingId(fr.id);
                    const result = await rejectForkliftRequest(fr.id);
                    setForkliftRejectingId(null);
                    if (result?.success) {
                      fetchForkliftRequests();
                    } else {
                      addToast(result?.error || 'Reject failed', 'error');
                    }
                  });
                }}
              >
                {forkliftRejectingId === fr.id ? 'Rejecting...' : 'Reject'}
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
};

export default ForkliftTab;
