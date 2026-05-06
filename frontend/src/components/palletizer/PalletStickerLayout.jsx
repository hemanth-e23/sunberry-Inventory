import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import './PalletStickerLayout.css';

const renderBarcode = (svgEl, value, opts = {}) => {
  if (!svgEl || !value) return;
  try {
    svgEl.textContent = '';
    JsBarcode(svgEl, String(value), {
      format: 'CODE128',
      width: 2,
      height: 50,
      displayValue: false,
      margin: 10,
      background: '#ffffff',
      lineColor: '#000000',
      ...opts,
    });
  } catch {
    // Bad input — render a blank rather than crash the print.
  }
};

const renderQr = (canvasEl, value) => {
  if (!canvasEl || !value) return;
  QRCode.toCanvas(canvasEl, String(value), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
    color: { dark: '#000000', light: '#ffffff' },
  }).catch(() => { /* swallow — keep the page rendering */ });
};

const formatBbd = (bbd) => {
  if (!bbd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(bbd));
  if (!m) return String(bbd);
  return `${m[2]}/${m[3]}/${m[1]}`;
};

const ProductName = ({ productName }) => (
  <div className="tag-product-name">{(productName || 'Unknown Product').toUpperCase()}</div>
);

const FccBlock = ({ fcc, barcodeRef }) => (
  <>
    <div className="tag-barcode-container">
      <svg ref={barcodeRef} className="tag-barcode" />
    </div>
    <div className="tag-fcc-code">{fcc || '-'}</div>
  </>
);

const InfoRow = ({ lot, cases, bbd }) => (
  <div className="tag-info-row">
    <div className="tag-info-col">
      <span className="info-label">Lot</span>
      <span className="info-value info-value--lot">{lot || '-'}</span>
    </div>
    <div className="tag-info-col">
      <span className="info-label">Quantity</span>
      <span className="info-value">{cases != null ? `${cases} cases` : '-'}</span>
    </div>
    <div className="tag-info-col">
      <span className="info-label">BBD</span>
      <span className="info-value">{formatBbd(bbd) || '-'}</span>
    </div>
  </div>
);

const PalletBlock = ({ palletId, qrRef }) => (
  <>
    <div className="tag-pallet-section">
      <span className="pallet-label">Pallet ID</span>
      <span className="pallet-value">{palletId || '-'}</span>
    </div>
    <div className="tag-qr-container">
      <canvas ref={qrRef} className="tag-qr" />
    </div>
  </>
);

/**
 * Pallet sticker. 4" × 5.75" physical stock.
 *
 * Portrait — top-to-bottom stack:
 *   Name → FCC barcode → FCC text → Lot/Qty/BBD → Pallet ID + QR
 *
 * Landscape — two columns, left/right:
 *   LEFT:  Name → FCC barcode → FCC text → Lot/Qty/BBD
 *   RIGHT: Pallet ID + full-height QR
 */
const PalletStickerLayout = ({
  productName,
  fcc,
  cases,
  bbd,
  lot,
  palletId,
  orientation = 'portrait',
}) => {
  const fccBarcodeRef = useRef(null);
  const palletQrRef = useRef(null);

  useEffect(() => {
    renderBarcode(fccBarcodeRef.current, fcc);
    renderQr(palletQrRef.current, palletId);
  }, [fcc, palletId]);

  if (orientation === 'landscape') {
    return (
      <div className="pallet-tag pallet-tag--landscape">
        <div className="pallet-tag__col pallet-tag__col--left">
          <ProductName productName={productName} />
          <div className="tag-divider" />
          <FccBlock fcc={fcc} barcodeRef={fccBarcodeRef} />
          <div className="tag-divider" />
          <InfoRow lot={lot} cases={cases} bbd={bbd} />
        </div>
        <div className="pallet-tag__col-divider" />
        <div className="pallet-tag__col pallet-tag__col--right">
          <PalletBlock palletId={palletId} qrRef={palletQrRef} />
        </div>
      </div>
    );
  }

  return (
    <div className="pallet-tag pallet-tag--portrait">
      <ProductName productName={productName} />
      <div className="tag-divider" />
      <FccBlock fcc={fcc} barcodeRef={fccBarcodeRef} />
      <div className="tag-divider" />
      <InfoRow lot={lot} cases={cases} bbd={bbd} />
      <div className="tag-divider" />
      <PalletBlock palletId={palletId} qrRef={palletQrRef} />
    </div>
  );
};

export default PalletStickerLayout;
