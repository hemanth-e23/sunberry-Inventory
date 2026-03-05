import React from 'react';

/**
 * Generic full-screen backdrop wrapper.
 * Clicking the backdrop (not the inner card) calls onClose.
 */
const ModalOverlay = ({ children, onClose }) => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      backgroundColor: 'rgba(0,0,0,0.45)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
    onClick={(e) => {
      if (e.target === e.currentTarget && onClose) onClose();
    }}
  >
    <div
      style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        width: '95%',
        maxWidth: 700,
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
      }}
    >
      {children}
    </div>
  </div>
);

export default ModalOverlay;
