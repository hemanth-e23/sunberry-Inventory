import React, { useState } from 'react';
import apiClient from '../api/client';
import './ShipOutDocuments.css';

// Renders the frozen document snapshot as a Packing Slip and a Bill of Lading,
// styled to match Sunberry's original forms. Print-friendly (window.print()).

const fmtD = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
};
const fmtT = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const ShipOutDocuments = ({ snapshot: s, transferId }) => {
  const [tab, setTab] = useState('slip');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState('');

  // Open the server-rendered BOL. It is fetched through apiClient rather than
  // linked directly because a new tab carries no Authorization header — the
  // request would 401. Fetch with auth, then open the bytes as a blob so the
  // browser's own PDF viewer (and its print button) handles it.
  const openBolPdf = async () => {
    if (!transferId) return;
    setPdfBusy(true);
    setPdfError('');
    let url;
    try {
      const r = await apiClient.get(`/inventory/transfers/${transferId}/bol.pdf`, {
        responseType: 'blob',
      });
      url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      const win = window.open(url, '_blank', 'noopener');
      if (!win) setPdfError('Allow pop-ups for this site to open the BOL.');
    } catch (err) {
      // An error response arrives as a Blob too, so the detail has to be read out.
      let detail = 'Could not build the BOL PDF.';
      try {
        const text = await err?.response?.data?.text?.();
        if (text) detail = JSON.parse(text).detail || detail;
      } catch { /* keep the default */ }
      setPdfError(detail);
    } finally {
      setPdfBusy(false);
      // Revoke late so the new tab has finished loading the blob.
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  };

  if (!s) return null;

  const shipTo = s.ship_to || {};
  const cityStateZip = [shipTo.city, shipTo.state].filter(Boolean).join(', ') + (shipTo.zip_code ? `, ${shipTo.zip_code}` : '');

  return (
    <section className="panel sod-panel">
      {/* Orientation follows the active document: packing slip prints landscape
          (wide line table), BOL prints portrait A4. */}
      <style>{`@page { size: A4 ${tab === 'slip' ? 'landscape' : 'portrait'}; margin: 8mm; }`}</style>
      <div className="panel-header sod-controls">
        <div className="sod-tabs">
          <button className={tab === 'slip' ? 'active' : ''} onClick={() => setTab('slip')}>Packing Slip</button>
          <button className={tab === 'bol' ? 'active' : ''} onClick={() => setTab('bol')}>Bill of Lading</button>
        </div>
        <div className="sod-actions">
          {transferId && (
            <button className="primary-button" onClick={openBolPdf} disabled={pdfBusy}>
              {pdfBusy ? 'Building…' : 'Open BOL PDF'}
            </button>
          )}
          <button className="sod-print-html" onClick={() => window.print()}>Print this view</button>
        </div>
      </div>
      {pdfError && <p className="sod-pdf-error">{pdfError}</p>}

      {tab === 'slip' && (
        <div className="sod-doc" id="packing-slip">
          <div className="sod-slip-head">
            <div>
              <strong>Ship Date:</strong><br />{fmtD(s.ship_date)} {s.appointment_time || ''}
            </div>
            <div className="sod-title">Sunberry Paw Paw Packing Slip</div>
            <div className="sod-logo">SunBerry<br /><span>PAW PAW</span></div>
          </div>
          <div className="sod-slip-parties">
            <div>
              <strong>Ship From:</strong><br />
              {s.ship_from.name}<br />{s.ship_from.address}<br />{s.ship_from.city_state_zip}
            </div>
            <div>
              <strong>Ship To:</strong><br />
              {shipTo.location_name}<br />{shipTo.address_line1}<br />{cityStateZip}
            </div>
            <div>
              <strong>Bill To:</strong><br />
              {s.bill_to.name}<br />{s.bill_to.lines.map((l, i) => <span key={i}>{l}<br /></span>)}
            </div>
          </div>
          <div className="sod-carrier"><strong>Carrier:</strong><br />{s.carrier || '—'}</div>
          <table className="sod-table">
            <thead>
              <tr><th>Order Number</th><th>PO Number</th><th>Item</th><th>Item Description</th><th>UPC</th><th>Quantity</th><th>UOM</th><th>Lot Number</th></tr>
            </thead>
            <tbody>
              {s.slip_lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.order_number || ''}</td><td>{l.po_number || ''}</td><td>{l.item}</td>
                  <td>{l.description}</td><td></td><td>{l.quantity}</td><td>{l.uom}</td><td>{l.lot_number || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'bol' && (
        <div className="sod-doc sod-bol" id="bol">
          <div className="sod-bol-head">
            <div><strong>Date:</strong> {fmtD(s.ship_date)}</div>
            <div className="sod-title">BILL OF LADING</div>
            <div>Page 1 of 1</div>
          </div>

          {/* Shipper / ship-to / third-party  +  B of L / carrier column */}
          <div className="sod-box">
            <div className="sod-row2">
              <div className="sod-col-l">
                <div className="sod-band">SHIPPER</div>
                <table className="sod-kv"><tbody>
                  <tr><td className="k">NAME</td><td><strong>{s.ship_from.name}</strong></td></tr>
                  <tr><td className="k">ADDRESS</td><td><strong>{s.ship_from.address}</strong></td></tr>
                  <tr><td className="k">CITY / STATE / ZIP</td><td><strong>{s.ship_from.city_state_zip}</strong></td></tr>
                  <tr><td className="k">SID NO.</td><td>&nbsp;</td></tr>
                </tbody></table>
                <div className="sod-band">SHIP TO</div>
                <table className="sod-kv"><tbody>
                  <tr><td className="k">NAME</td><td><strong>{shipTo.location_name || ''}</strong></td></tr>
                  <tr><td className="k">ADDRESS</td><td><strong>{shipTo.address_line1 || ''}</strong></td></tr>
                  <tr><td className="k">CITY / STATE / ZIP</td><td><strong>{cityStateZip}</strong></td></tr>
                  <tr><td className="k">CID NO.</td><td>&nbsp;</td></tr>
                </tbody></table>
                <div className="sod-band">THIRD PARTY FREIGHT CHARGES BILL TO</div>
                <table className="sod-kv"><tbody>
                  <tr><td className="k">NAME</td><td>&nbsp;</td></tr>
                  <tr><td className="k">ADDRESS</td><td>&nbsp;</td></tr>
                  <tr><td className="k">CITY / STATE / ZIP</td><td>&nbsp;</td></tr>
                  <tr><td className="k">TELEPHONE</td><td>&nbsp;</td></tr>
                </tbody></table>
              </div>
              <div className="sod-col-r">
                <table className="sod-kv sod-kv-right"><tbody>
                  <tr><td className="k">B of L NO</td><td><strong>{s.bol_number}</strong></td></tr>
                </tbody></table>
                <div className="sod-fill" style={{ minHeight: '55px', borderBottom: '1px solid #333' }}></div>
                <table className="sod-kv sod-kv-right"><tbody>
                  <tr><td className="k">CARRIER NAME</td><td><strong>{s.carrier || ''}</strong></td></tr>
                  <tr><td className="k">CARRIER NO</td><td>&nbsp;</td></tr>
                  <tr><td className="k">TRAILER NO</td><td><strong>{s.trailer_number || ''}</strong></td></tr>
                  <tr><td className="k">SEAL NO</td><td><strong>{s.seal_number || ''}</strong></td></tr>
                  <tr><td className="k">SERIAL NO</td><td>&nbsp;</td></tr>
                  <tr><td className="k">SCAC</td><td>&nbsp;</td></tr>
                  <tr><td className="k">PRO NO</td><td>&nbsp;</td></tr>
                </tbody></table>
                <div className="sod-fill" style={{ minHeight: '18px' }}></div>
              </div>
            </div>
            <div className="sod-row2 bordered">
              <div className="sod-col-l">
                <div className="sod-band">SPECIAL INSTRUCTIONS</div>
                <div className="sod-instrbox" style={{ minHeight: '80px', padding: '4px 6px' }}>{s.ship_short ? 'SHIPPED SHORT OF ORDERED QUANTITY.' : ''}</div>
              </div>
              <div className="sod-col-r">
                <div className="sod-band">FREIGHT CHARGE TERMS</div>
                <div className="small" style={{ padding: '3px 6px' }}>Freight charges prepaid unless marked otherwise.</div>
                <table className="sod-terms"><tbody><tr>
                  <td className="sod-band-cell">PREPAID</td><td className="sod-chk"></td>
                  <td className="sod-band-cell">COLLECT</td><td className="sod-chk"></td>
                  <td className="sod-band-cell">THIRD PARTY</td><td className="sod-chk"></td>
                </tr></tbody></table>
                <div className="sod-note">Master bill of lading with attached underlying bills of lading.</div>
              </div>
            </div>
          </div>

          {/* Customer order table */}
          <table className="sod-table sod-dark-head" style={{ marginTop: '-1px' }}>
            <thead>
              <tr><th style={{ width: '26%' }}>CUSTOMER ORDER NO.</th><th>NO. OF PKGS</th><th>WGT</th><th style={{ width: '12%' }}>PALLET / SLIP</th><th style={{ width: '32%' }}>ADDITIONAL SHIPPER INFO</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>{s.order_number}</strong></td><td><strong>{s.total_cases}</strong></td>
                <td><strong>{Math.round(s.weight.product)}</strong></td>
                <td className="sod-yn"><span>Y</span><span className="n">N</span></td>
                <td><strong>{s.po_number ? `PO: ${s.po_number}` : ''}</strong></td>
              </tr>
              <tr><td></td><td></td><td></td><td className="sod-yn"><span>Y</span><span className="n">N</span></td><td></td></tr>
              <tr><td></td><td></td><td></td><td className="sod-yn"><span>Y</span><span className="n">N</span></td><td></td></tr>
              <tr>
                <td className="sod-shade" style={{ textAlign: 'center', fontWeight: 800 }}>TOTAL</td>
                <td className="sod-shade" style={{ fontWeight: 700 }}>{s.total_cases}</td>
                <td className="sod-shade" style={{ fontWeight: 700 }}>{Math.round(s.weight.product)}</td>
                <td></td><td></td>
              </tr>
            </tbody>
          </table>

          {/* Handling unit table */}
          <div className="sod-ltl">LTL. ONLY</div>
          <table className="sod-table sod-dark-head">
            <thead>
              <tr>
                <th colSpan={2}>HANDLING UNIT</th><th colSpan={2}>PACKAGE</th>
                <th rowSpan={2}>WGT</th><th rowSpan={2}>HM (X)</th>
                <th rowSpan={2} style={{ width: '30%' }}>DESCRIPTION OF ARTICLES, SPECIAL MARKS &amp; EXCEPTIONS</th>
                <th rowSpan={2}>NMFC NO.</th><th rowSpan={2}>CLASS</th>
              </tr>
              <tr><th>QTY</th><th>TYPE</th><th>QTY</th><th>TYPE</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>{s.pallet_count}</strong></td><td><strong>PAL</strong></td><td></td><td></td><td><strong>{Math.round(s.weight.pallets)}</strong></td><td></td><td></td><td>{s.nmfc}</td><td>{s.freight_class}</td></tr>
              <tr><td className="sod-shade"></td><td className="sod-shade"></td><td><strong>{s.total_cases}</strong></td><td><strong>CS</strong></td><td><strong>{Math.round(s.weight.product)}</strong></td><td></td><td><strong>{s.freight_description}</strong></td><td>{s.nmfc}</td><td>{s.freight_class}</td></tr>
              <tr><td className="sod-shade"></td><td className="sod-shade"></td><td className="sod-shade"></td><td className="sod-shade"></td><td><strong>{Math.round(s.weight.total)}</strong></td><td></td><td></td><td></td><td></td></tr>
            </tbody>
          </table>

          {/* Carrier info validation stamp */}
          <div className="sod-stamp-title">Carrier Info Validation Stamp</div>
          <table className="sod-table sod-stamp">
            <tbody>
              <tr>
                <td className="k">Tractor License No</td><td className="v">{s.truck_license || s.truck_number || ''}</td>
                <td className="k">Total Cases Shipped</td><td className="v">{s.total_cases}</td>
                <td className="k">Appointment Time</td><td className="v"><strong>{s.appointment_time || ''}</strong></td>
              </tr>
              <tr>
                <td className="k">Trailer License No</td><td className="v">{s.trailer_license || ''}</td>
                <td className="k">Date Shipped</td><td className="v"><strong>{fmtD(s.ship_date)}</strong></td>
                <td className="k">Time In</td><td className="v"><strong>{fmtT(s.time_in)}</strong></td>
              </tr>
              <tr>
                <td className="k">Driver's License No</td><td className="v">{s.driver_license || ''}</td>
                <td className="k">Carrier</td><td className="v">{s.carrier || ''}</td>
                <td className="k">Time Out</td><td className="v"><strong>{fmtT(s.time_out)}</strong></td>
              </tr>
              <tr>
                <td className="k">Driver's Name</td><td className="v">{s.driver_name || ''}</td>
                <td className="k"></td><td className="v"></td><td className="k"></td><td className="v"></td>
              </tr>
            </tbody>
          </table>

          {/* Value / COD / fee terms */}
          <table className="sod-grid"><tbody><tr>
            <td className="sod-cell" style={{ width: '58%' }}>
              <div className="small">
                Where the rate is dependent on value, shippers are required to state specifically in
                writing the agreed or declared value of the property as follows: &ldquo;The agreed or
                declared value of the property is specifically stated by the shipper to be not
                exceeding ______________ per ______________.&rdquo;
              </div>
            </td>
            <td className="sod-cell" style={{ width: '42%' }}>
              <div className="sod-band">COD AMOUNT $</div>
              <div className="sod-band">FEE TERMS</div>
              <table className="sod-terms"><tbody><tr>
                <td className="sod-band-cell">COLLECT</td><td className="sod-chk"></td>
                <td className="sod-band-cell">PREPAID</td><td className="sod-chk"></td>
                <td className="sod-band-cell">CUSTOMER CHECK</td><td className="sod-chk"></td>
              </tr></tbody></table>
            </td>
          </tr></tbody></table>

          <div className="sod-liability">
            NOTE: Liability limitation for loss or damage in this shipment may be applicable. See 49 USC § 14706(c)(1)(A) and (B).
          </div>

          <table className="sod-grid"><tbody><tr>
            <td className="sod-cell small" style={{ width: '58%' }}>
              Received, subject to individually determined rates or contracts that have been agreed
              upon in writing between the carrier and shipper, if applicable, otherwise to the rates,
              classifications, and rules that have been established by the carrier and are available
              to the shipper, on request, and to all applicable state and federal regulations.
            </td>
            <td className="sod-cell small" style={{ width: '42%' }}>
              The carrier shall not make delivery of this shipment without payment of charges and
              all other lawful fees.
              <div className="sod-band" style={{ marginTop: '6px' }}>SHIPPER SIGNATURE</div>
              <div className="sod-sigbox" style={{ minHeight: '24px' }}></div>
            </td>
          </tr></tbody></table>

          <table className="sod-grid"><tbody>
            <tr>
              <td className="sod-cell" style={{ width: '40%' }}>
                <div className="sod-band">SHIPPER SIGNATURE &amp; DATE</div>
                <div className="sod-sigbox" style={{ minHeight: '58px' }}></div>
              </td>
              <td className="sod-cell" style={{ width: '38%' }}>
                <div className="sod-band">CARRIER SIGNATURE &amp; PICK-UP DATE</div>
                <div className="sod-sigbox" style={{ minHeight: '58px' }}></div>
              </td>
              <td className="sod-cell" style={{ width: '22%' }}>
                <div className="sod-band">TRAILER LOADED</div>
                <table className="sod-kv sod-kv-tl"><tbody>
                  <tr><td className="k">BY SHIPPER</td><td className="sod-chk"><strong>X</strong></td></tr>
                  <tr><td className="k">BY DRIVER</td><td className="sod-chk"></td></tr>
                </tbody></table>
                <div className="sod-band">FREIGHT COUNTED</div>
                <table className="sod-kv sod-kv-tl"><tbody>
                  <tr><td className="k">BY SHIPPER</td><td className="sod-chk"><strong>X</strong></td></tr>
                  <tr><td className="k">BY DRIVER/PALLETS SAID TO CONTAIN</td><td className="sod-chk"></td></tr>
                  <tr><td className="k">BY DRIVER PIECES</td><td className="sod-chk"></td></tr>
                </tbody></table>
              </td>
            </tr>
            <tr>
              <td className="sod-cell small" colSpan={2}>
                This is to certify that the above-named materials are properly classified, packaged,
                marked, and labeled, and are in proper condition for transportation according to the
                applicable regulations of the DOT.
              </td>
              <td className="sod-cell small">
                Carrier acknowledges receipt of packages and required placards. Carrier certifies
                emergency response information was made available and/or carrier has the DOT emergency
                response guidebook or equivalent documentation in the vehicle. Property described
                above is received in good order, except as noted.
              </td>
            </tr>
          </tbody></table>
        </div>
      )}
    </section>
  );
};

export default ShipOutDocuments;
