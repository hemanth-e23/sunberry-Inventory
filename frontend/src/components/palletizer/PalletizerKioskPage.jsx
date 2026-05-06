import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Printer, RefreshCw, AlertTriangle, Copy } from 'lucide-react';
import {
  kioskGetLines,
  kioskMintPallets,
  kioskRecentPallets,
} from '../../api/palletizerService';
import PalletStickerLayout from './PalletStickerLayout';
import './PalletizerKioskPage.css';

const POLL_MS = 10_000;

const COUNT_PRESETS = [10, 15, 25, 50];
const COPIES_OPTIONS = [1, 2, 4];

const buildStickerSet = (pallets, product, lot, bbd, copies, orientation) => {
  const orientations = orientation === 'both'
    ? ['portrait', 'landscape']
    : [orientation];
  const out = [];
  pallets.forEach(p => {
    orientations.forEach(o => {
      for (let i = 0; i < copies; i += 1) {
        out.push({
          key: `${p.licence_number}-${o}-${i}`,
          orientation: o,
          productName: product?.name,
          fcc: product?.fcc_code,
          cases: product?.default_cases_per_pallet,
          bbd,
          lot,
          palletId: p.licence_number,
        });
      }
    });
  });
  return out;
};

const PalletizerKioskPage = () => {
  const [searchParams] = useSearchParams();
  const warehouseId = searchParams.get('warehouse_id') || searchParams.get('warehouseId') || '';
  const apiKey = searchParams.get('api_key') || searchParams.get('apiKey') || '';

  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // { mode: 'print' | 'reprint', line, active }
  const [printPayload, setPrintPayload] = useState(null);
  const printRootRef = useRef(null);

  const fetchLines = useCallback(async () => {
    if (!warehouseId || !apiKey) {
      setError('Missing warehouse_id or api_key in URL.');
      setLoading(false);
      return;
    }
    try {
      const { data } = await kioskGetLines(apiKey, warehouseId);
      setLines(data || []);
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [warehouseId, apiKey]);

  useEffect(() => {
    fetchLines();
    const t = setInterval(fetchLines, POLL_MS);
    return () => clearInterval(t);
  }, [fetchLines]);

  // Once printPayload is set + DOM updates, fire window.print and clean up.
  useEffect(() => {
    if (!printPayload) return undefined;
    const id = setTimeout(() => {
      window.print();
      setPrintPayload(null);
    }, 250);
    return () => clearTimeout(id);
  }, [printPayload]);

  const openPrint = (line, active) => setDialog({ mode: 'print', line, active });
  const openReprint = (line, active) => setDialog({ mode: 'reprint', line, active });
  const closeDialog = () => setDialog(null);

  return (
    <div className="palletizer-kiosk">
      <header className="palletizer-kiosk__header">
        <div>
          <h1>Palletizer</h1>
          <p>Print pallet tags as you build pallets. Each tag has a unique scannable Pallet ID.</p>
        </div>
        <button className="kiosk-btn kiosk-btn--ghost" onClick={fetchLines}>
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      {error && (
        <div className="palletizer-kiosk__error">
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {loading && <div className="palletizer-kiosk__empty">Loading…</div>}

      {!loading && !error && lines.length === 0 && (
        <div className="palletizer-kiosk__empty">No production lines configured for this plant.</div>
      )}

      <div className="palletizer-kiosk__lines">
        {lines.map(({ line, active }) => (
          <div key={line.id} className="kiosk-line-card">
            <header className="kiosk-line-card__head">
              <h2>{line.name}</h2>
              {active ? <span className="badge badge--running">Producing</span> : <span className="badge badge--idle">Idle</span>}
            </header>

            {!active ? (
              <div className="kiosk-line-card__notice">
                <AlertTriangle size={20} />
                Current production not set — ask supervisor.
              </div>
            ) : (
              <>
                <div className="kiosk-line-card__row"><span className="lbl">Product</span><span className="val val--big">{active.product?.name}</span></div>
                <div className="kiosk-line-card__row"><span className="lbl">Lot</span><span className="val">{active.lot_number}</span></div>
                <div className="kiosk-line-card__row"><span className="lbl">FCC</span><span className="val">{active.product?.fcc_code || '-'}</span></div>
                <div className="kiosk-line-card__row"><span className="lbl">Cases / pallet</span><span className="val">{active.product?.default_cases_per_pallet ?? '-'}</span></div>
                <div className="kiosk-line-card__row"><span className="lbl">Last printed</span><span className="val">{String(active.last_printed_seq).padStart(3, '0')}</span></div>
                <div className="kiosk-line-card__row"><span className="lbl">Next pallet</span><span className="val val--strong">{String(active.last_printed_seq + 1).padStart(3, '0')}</span></div>

                <div className="kiosk-line-card__actions">
                  <button className="kiosk-btn kiosk-btn--primary" onClick={() => openPrint(line, active)}>
                    <Printer size={18} /> Print Pallets
                  </button>
                  <button
                    className="kiosk-btn kiosk-btn--secondary"
                    onClick={() => openReprint(line, active)}
                    disabled={active.last_printed_seq < 1}
                  >
                    <Copy size={18} /> Reprint
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {dialog?.mode === 'print' && (
        <PrintDialog
          line={dialog.line}
          active={dialog.active}
          warehouseId={warehouseId}
          apiKey={apiKey}
          onClose={closeDialog}
          onPrint={(payload) => {
            setPrintPayload(payload);
            closeDialog();
            // Refresh counter after the print fires
            setTimeout(fetchLines, 1000);
          }}
        />
      )}

      {dialog?.mode === 'reprint' && (
        <ReprintDialog
          line={dialog.line}
          active={dialog.active}
          warehouseId={warehouseId}
          apiKey={apiKey}
          onClose={closeDialog}
          onPrint={(payload) => {
            setPrintPayload(payload);
            closeDialog();
          }}
        />
      )}

      {/* Hidden print root — only visible during print */}
      <div ref={printRootRef} className="palletizer-kiosk__print-root" aria-hidden="true">
        {printPayload && printPayload.stickers.map(s => (
          <PalletStickerLayout
            key={s.key}
            productName={s.productName}
            fcc={s.fcc}
            cases={s.cases}
            bbd={s.bbd}
            lot={s.lot}
            palletId={s.palletId}
            orientation={s.orientation}
          />
        ))}
      </div>
    </div>
  );
};

// ─── PRINT DIALOG ────────────────────────────────────────────────────────────

const PrintDialog = ({ line, active, warehouseId, apiKey, onClose, onPrint }) => {
  const [count, setCount] = useState(10);
  const [copies, setCopies] = useState(2);
  const [orientation, setOrientation] = useState('landscape');
  const [submitting, setSubmitting] = useState(false);

  const startSeq = active.last_printed_seq + 1;
  const endSeq = active.last_printed_seq + Number(count || 0);
  const orientationsCount = orientation === 'both' ? 2 : 1;
  const totalStickers = Math.max(0, Number(count || 0)) * Number(copies) * orientationsCount;

  const valid = Number(count) >= 1 && Number(count) <= 200;

  const handlePrint = async () => {
    if (!valid) return;
    try {
      setSubmitting(true);
      const { data } = await kioskMintPallets(apiKey, warehouseId, line.id, Number(count));
      const stickers = buildStickerSet(
        data.pallets,
        data.product,
        data.lot_number,
        data.bbd,
        Number(copies),
        orientation,
      );
      onPrint({ stickers });
    } catch (err) {
      // Show inline; dialog stays open so user can retry
      const msg = err?.response?.data?.detail || err.message || 'Failed to mint pallets';
      window.alert(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="kiosk-modal-backdrop" onClick={onClose}>
      <div className="kiosk-modal" onClick={e => e.stopPropagation()}>
        <h3>Print pallets — {line.name}</h3>
        <p className="muted">Lot {active.lot_number} · {active.product?.name}</p>

        <label className="kiosk-modal__field">
          <span>How many pallets?</span>
          <div className="kiosk-modal__presets">
            {COUNT_PRESETS.map(n => (
              <button
                key={n}
                type="button"
                className={`kiosk-chip ${Number(count) === n ? 'kiosk-chip--active' : ''}`}
                onClick={() => setCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <input
            type="number"
            min="1"
            max="200"
            value={count}
            onChange={e => setCount(e.target.value)}
          />
        </label>

        <label className="kiosk-modal__field">
          <span>Copies per side</span>
          <div className="kiosk-modal__presets">
            {COPIES_OPTIONS.map(n => (
              <button
                key={n}
                type="button"
                className={`kiosk-chip ${Number(copies) === n ? 'kiosk-chip--active' : ''}`}
                onClick={() => setCopies(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </label>

        <label className="kiosk-modal__field">
          <span>Orientation</span>
          <div className="kiosk-modal__presets">
            {[
              { v: 'landscape', label: 'Landscape' },
              { v: 'portrait', label: 'Portrait' },
              { v: 'both', label: 'Both' },
            ].map(o => (
              <button
                key={o.v}
                type="button"
                className={`kiosk-chip ${orientation === o.v ? 'kiosk-chip--active' : ''}`}
                onClick={() => setOrientation(o.v)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </label>

        <div className="kiosk-modal__summary">
          {valid ? (
            <>
              Will mint <strong>{String(startSeq).padStart(3, '0')}</strong>–<strong>{String(endSeq).padStart(3, '0')}</strong> · print <strong>{totalStickers}</strong> sticker{totalStickers === 1 ? '' : 's'}
            </>
          ) : (
            <span className="error">Count must be between 1 and 200.</span>
          )}
        </div>

        <div className="kiosk-modal__actions">
          <button className="kiosk-btn kiosk-btn--ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="kiosk-btn kiosk-btn--primary"
            disabled={!valid || submitting}
            onClick={handlePrint}
          >
            {submitting ? 'Working…' : 'Print'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── REPRINT DIALOG ──────────────────────────────────────────────────────────

const ReprintDialog = ({ line, active, warehouseId, apiKey, onClose, onPrint }) => {
  const [recent, setRecent] = useState({ pallets: [], product: null, lot_number: '', bbd: null });
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [copies, setCopies] = useState(2);
  const [orientation, setOrientation] = useState('landscape');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await kioskRecentPallets(apiKey, warehouseId, line.id);
        if (cancelled) return;
        setRecent({
          pallets: data.pallets || [],
          product: active.product,
          lot_number: data.lot_number,
          bbd: null,
        });
        if (data.last_printed_seq > 0) {
          setFrom(String(data.last_printed_seq).padStart(3, '0'));
          setTo(String(data.last_printed_seq).padStart(3, '0'));
          setSelected(new Set([data.last_printed_seq]));
        }
      } catch (err) {
        window.alert(err?.response?.data?.detail || 'Failed to load printed pallets');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiKey, warehouseId, line.id, active.product]);

  const applyRange = () => {
    const f = parseInt(from, 10);
    const t = parseInt(to, 10);
    if (Number.isNaN(f) || Number.isNaN(t) || f < 1 || t < 1 || f > t) return;
    const next = new Set();
    for (let i = f; i <= t; i += 1) next.add(i);
    setSelected(next);
  };

  const toggle = (seq) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const orientationsCount = orientation === 'both' ? 2 : 1;
  const total = selected.size * Number(copies) * orientationsCount;

  const handleReprint = () => {
    const pickedPallets = recent.pallets.filter(p => selected.has(p.sequence));
    if (pickedPallets.length === 0) return;

    // BBD compute on client: today + product.expire_years (matches backend logic)
    let bbd = null;
    if (recent.product?.expire_years) {
      const d = new Date();
      try {
        d.setFullYear(d.getFullYear() + Number(recent.product.expire_years));
        bbd = d.toISOString().slice(0, 10);
      } catch {
        bbd = null;
      }
    }

    const stickers = buildStickerSet(
      pickedPallets,
      recent.product,
      recent.lot_number,
      bbd,
      Number(copies),
      orientation,
    );
    onPrint({ stickers });
  };

  return (
    <div className="kiosk-modal-backdrop" onClick={onClose}>
      <div className="kiosk-modal kiosk-modal--wide" onClick={e => e.stopPropagation()}>
        <h3>Reprint — {line.name}</h3>
        <p className="muted">Lot {active.lot_number} · {active.product?.name}</p>

        {loading ? (
          <div className="muted">Loading printed pallets…</div>
        ) : recent.pallets.length === 0 ? (
          <div className="muted">No pallets have been printed yet for this active production.</div>
        ) : (
          <>
            <label className="kiosk-modal__field">
              <span>Range</span>
              <div className="kiosk-modal__range">
                from
                <input value={from} onChange={e => setFrom(e.target.value)} placeholder="001" />
                to
                <input value={to} onChange={e => setTo(e.target.value)} placeholder="010" />
                <button type="button" className="kiosk-btn kiosk-btn--ghost" onClick={applyRange}>Select range</button>
                <button type="button" className="kiosk-btn kiosk-btn--ghost" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            </label>

            <div className="kiosk-modal__field">
              <span>Or pick individually</span>
              <div className="kiosk-modal__seq-grid">
                {recent.pallets.map(p => (
                  <button
                    key={p.sequence}
                    type="button"
                    className={`kiosk-chip ${selected.has(p.sequence) ? 'kiosk-chip--active' : ''}`}
                    onClick={() => toggle(p.sequence)}
                  >
                    {String(p.sequence).padStart(3, '0')}
                  </button>
                ))}
              </div>
            </div>

            <label className="kiosk-modal__field">
              <span>Copies per side</span>
              <div className="kiosk-modal__presets">
                {COPIES_OPTIONS.map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`kiosk-chip ${Number(copies) === n ? 'kiosk-chip--active' : ''}`}
                    onClick={() => setCopies(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </label>

            <label className="kiosk-modal__field">
              <span>Orientation</span>
              <div className="kiosk-modal__presets">
                {[
                  { v: 'landscape', label: 'Landscape' },
                  { v: 'portrait', label: 'Portrait' },
                  { v: 'both', label: 'Both' },
                ].map(o => (
                  <button
                    key={o.v}
                    type="button"
                    className={`kiosk-chip ${orientation === o.v ? 'kiosk-chip--active' : ''}`}
                    onClick={() => setOrientation(o.v)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </label>

            <div className="kiosk-modal__summary">
              Reprinting <strong>{selected.size}</strong> pallet{selected.size === 1 ? '' : 's'} · <strong>{total}</strong> sticker{total === 1 ? '' : 's'} (no counter change)
            </div>
          </>
        )}

        <div className="kiosk-modal__actions">
          <button className="kiosk-btn kiosk-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="kiosk-btn kiosk-btn--primary"
            onClick={handleReprint}
            disabled={selected.size === 0}
          >
            Print Reprints
          </button>
        </div>
      </div>
    </div>
  );
};

export default PalletizerKioskPage;
