import React, { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import './Toast.css';

const Toast = ({
    message,
    type = 'info',
    onClose,
    duration = 4000,
    position = 'top-right'
}) => {
    useEffect(() => {
        if (duration > 0) {
            const timer = setTimeout(() => {
                onClose();
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [duration, onClose]);

    const icons = {
        success: <CheckCircle size={20} />,
        error: <AlertCircle size={20} />,
        warning: <AlertTriangle size={20} />,
        info: <Info size={20} />
    };

    const typeStyles = {
        success: 'toast-success',
        error: 'toast-error',
        warning: 'toast-warning',
        info: 'toast-info'
    };

    return (
        <div
            className={`toast ${typeStyles[type]} toast-${position} animate-slide-in`}
            role="alert"
        >
            <div className="toast-icon">
                {icons[type]}
            </div>
            <div className="toast-content">
                <p>{message}</p>
            </div>
            <button
                onClick={onClose}
                className="toast-close icon-btn"
                aria-label="Close notification"
            >
                <X size={16} />
            </button>
        </div>
    );
};

export default Toast;
