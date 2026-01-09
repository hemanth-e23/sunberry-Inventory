import React from 'react';
import { Loader2 } from 'lucide-react';

const LoadingSpinner = ({ size = 'md', text = '' }) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16'
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3">
      <Loader2 
        className={`${sizeClasses[size]} text-primary animate-spin`} 
        style={{
          color: 'var(--color-primary)',
          animation: 'spin 1s linear infinite'
        }}
      />
      {text && (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
          {text}
        </p>
      )}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default LoadingSpinner;
