import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, ArrowRightLeft, Truck } from 'lucide-react';
import './ScannerHome.css';

const ScannerHome = () => {
  const navigate = useNavigate();

  return (
    <div className="scanner-home">
      <h2 className="scanner-home-title">Select Operation</h2>
      <div className="scanner-home-buttons">
        <button
          type="button"
          className="scanner-home-btn receipt"
          onClick={() => navigate('/forklift/receipt')}
        >
          <div className="scanner-home-icon"><Package size={26} /></div>
          <div className="scanner-home-text">
            <span>Receipt Scan</span>
            <span className="scanner-home-desc">Scan pallets from production into storage</span>
          </div>
        </button>
        <button
          type="button"
          className="scanner-home-btn transfer"
          onClick={() => navigate('/forklift/transfer')}
        >
          <div className="scanner-home-icon"><ArrowRightLeft size={26} /></div>
          <div className="scanner-home-text">
            <span>Internal Transfer</span>
            <span className="scanner-home-desc">Move pallets between storage rows</span>
          </div>
        </button>
        <button
          type="button"
          className="scanner-home-btn shipout"
          onClick={() => navigate('/forklift/ship-out')}
        >
          <div className="scanner-home-icon"><Truck size={26} /></div>
          <div className="scanner-home-text">
            <span>Ship-out Picking</span>
            <span className="scanner-home-desc">Pick pallets for approved shipments</span>
          </div>
        </button>
      </div>
    </div>
  );
};

export default ScannerHome;
