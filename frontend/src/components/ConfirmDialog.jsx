import React from 'react';

const ConfirmDialog = ({ message, title = 'Confirm', confirmLabel = 'Confirm', onConfirm, onCancel }) => {
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    }}>
      <div style={{
        backgroundColor: '#fff',
        borderRadius: '8px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
        padding: '28px 32px',
        maxWidth: '420px',
        width: '100%',
        margin: '0 16px',
      }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: 600, color: '#111' }}>
          {title}
        </h3>
        <p style={{ margin: '0 0 24px', fontSize: '14px', color: '#444', lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 18px',
              fontSize: '14px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              background: '#fff',
              color: '#374151',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 18px',
              fontSize: '14px',
              borderRadius: '6px',
              border: 'none',
              background: '#dc2626',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
