import React, { createContext, useContext, useState, useCallback } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);

  const confirm = useCallback((message, options = {}) =>
    new Promise(resolve => setDialog({ message, ...options, resolve })), []);

  const yes = () => { dialog?.resolve(true); setDialog(null); };
  const no = () => { dialog?.resolve(false); setDialog(null); };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {dialog && (
        <ConfirmDialog
          message={dialog.message}
          title={dialog.title}
          confirmLabel={dialog.confirmLabel}
          onConfirm={yes}
          onCancel={no}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
};
