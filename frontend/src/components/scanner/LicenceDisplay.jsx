import React from 'react';
import { splitLicenceForDisplay } from '../../utils/scannerFeedback';
import './LicenceDisplay.css';

const LicenceDisplay = ({ licence, className = '' }) => {
  const { prefix, suffix } = splitLicenceForDisplay(licence);
  return (
    <span className={`licence-display ${className}`.trim()}>
      <span className="licence-display-prefix">{prefix}</span>
      {suffix && <span className="licence-display-suffix">{suffix}</span>}
    </span>
  );
};

export default LicenceDisplay;
