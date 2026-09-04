import React, { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import Modal from '../Modal';

/**
 * What are you labelling — pallets, or the containers on them?
 *
 * Every print button used to answer this for you, always the same way: one
 * sticker per container. Correct for barrels, where the container is the thing
 * carried, and wrong twice over for anything that arrives wrapped on a pallet.
 *
 *   Receiving 500 bags   -> you want 10 pallet stickers, not 500. Nobody
 *                           destacks a wrapped pallet at the dock.
 *   Opening one pallet   -> you want 50 bag stickers, not 500. Only the pallet
 *                           being broken needs its contents labelled.
 *
 * Both stickers are the SAME sticker — same lot code, same QR — with one word
 * different in the middle band, so scanning either resolves to the same lot. A
 * bag does not become different material by coming off a pallet.
 *
 * For a lot with no `unitsPerPallet` there is only one possible answer, so this
 * collapses to a plain confirmation rather than asking a question with one
 * option.
 */
const PrintStickersDialog = ({ lot, open, onCancel, onConfirm, busy = false }) => {
  const unitLabel = lot?.unitLabel || 'unit';
  const perPallet = Number(lot?.unitsPerPallet) || 0;
  const totalUnits = Math.max(0, Math.round(Number(lot?.totalUnits) || 0));
  const palletised = perPallet > 1;
  const palletCount = palletised ? Math.ceil(totalUnits / perPallet) : 0;

  const [choice, setChoice] = useState(palletised ? 'pallet' : 'all');
  const [someCount, setSomeCount] = useState(perPallet || 1);

  // Re-seed when the dialog is opened for a different lot — otherwise the
  // previous lot's choice and count persist into the next print run.
  useEffect(() => {
    if (!open) return;
    setChoice(palletised ? 'pallet' : 'all');
    setSomeCount(perPallet || 1);
  }, [open, palletised, perPallet, lot?.lotCode]);

  if (!open) return null;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const resolved =
    choice === 'pallet'
      ? { count: palletCount, scope: 'pallet' }
      : choice === 'all'
        ? { count: totalUnits, scope: 'unit' }
        : { count: Math.max(0, Math.round(Number(someCount) || 0)), scope: 'unit' };

  const option = (value, heading, detail) => (
    <label
      key={value}
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px',
        border: `1px solid ${choice === value ? '#4caf50' : '#e5e7eb'}`,
        background: choice === value ? '#f0fdf4' : 'transparent',
        borderRadius: 8, marginBottom: 8, cursor: 'pointer',
      }}
    >
      <input
        type="radio"
        checked={choice === value}
        onChange={() => setChoice(value)}
        style={{ marginTop: 3 }}
      />
      <span>
        <span style={{ fontWeight: 600 }}>{heading}</span>
        <span style={{ display: 'block', fontSize: '0.8rem', color: '#6b7280' }}>
          {detail}
        </span>
      </span>
    </label>
  );

  return (
    <Modal isOpen={open} onClose={onCancel} title="Print stickers" size="md">
      <div style={{ marginBottom: 12, fontSize: '0.875rem', color: '#374151' }}>
        <strong>{lot?.productName || 'This lot'}</strong>
        {lot?.lotCode && (
          <span style={{ color: '#9ca3af' }}> · {lot.lotCode}</span>
        )}
      </div>

      {palletised ? (
        <>
          {option(
            'pallet',
            `${plural(palletCount, 'pallet sticker')}`,
            `One per wrapped pallet — ${perPallet} ${unitLabel}s under each. `
            + 'This is what goes on at receiving.',
          )}
          {option(
            'all',
            `${plural(totalUnits, `${unitLabel} sticker`)}`,
            `One for every ${unitLabel} in the lot.`,
          )}
          <label
            style={{
              display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px',
              border: `1px solid ${choice === 'some' ? '#4caf50' : '#e5e7eb'}`,
              background: choice === 'some' ? '#f0fdf4' : 'transparent',
              borderRadius: 8, cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              checked={choice === 'some'}
              onChange={() => setChoice('some')}
            />
            <input
              type="number"
              min="1"
              max={totalUnits || undefined}
              step="1"
              value={someCount}
              onChange={(e) => { setChoice('some'); setSomeCount(e.target.value); }}
              style={{ width: 80, padding: '4px 8px' }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{unitLabel} stickers</span>
              <span style={{ display: 'block', fontSize: '0.8rem', color: '#6b7280' }}>
                {/* The staging case: one pallet gets opened, and only its
                    contents need labelling before they can be scanned out. */}
                For opening a pallet — sticker just the {unitLabel}s coming off it.
              </span>
            </span>
          </label>
        </>
      ) : (
        <p style={{ fontSize: '0.875rem', color: '#374151' }}>
          {plural(totalUnits, `${unitLabel} sticker`)} — one for every {unitLabel}.
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || resolved.count <= 0}
          onClick={() => onConfirm(resolved)}
        >
          <Printer size={14} />
          {busy ? 'Preparing…' : `Print ${resolved.count}`}
        </button>
      </div>
    </Modal>
  );
};

export default PrintStickersDialog;
