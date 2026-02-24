import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, ArrowRightLeft, Truck } from 'lucide-react';
import './ScannerHome.css';

const ScannerHome = () => {
  const navigate = useNavigate();

  return (
    <div className="scanner-home">
      <h2 className="scanner-home-title">What would you like to do?</h2>
      <div className="scanner-home-buttons">
        <button
          type="button"
          className="scanner-home-btn primary"
          onClick={() => navigate('/forklift/receipt')}
        >
          <Package size={40} />
          <span>Receipt Scan</span>
          <span className="scanner-home-desc">Scan pallets into storage</span>
        </button>
        <button
          type="button"
          className="scanner-home-btn"
          onClick={() => navigate('/forklift/transfer')}
        >
          <ArrowRightLeft size={40} />
          <span>Transfer</span>
          <span className="scanner-home-desc">Move pallets between rows</span>
        </button>
        <button
          type="button"
          className="scanner-home-btn"
          onClick={() => navigate('/forklift/ship-out')}
        >
          <Truck size={40} />
          <span>Ship-out</span>
          <span className="scanner-home-desc">Pick pallets for shipping</span>
        </button>
      </div>
    </div>
  );
};

export default ScannerHome;
