import React, { useState } from "react";
import { formatDateTime } from "../../utils/dateUtils";
import { formatNumber } from "./reportUtils";

// One line of the balance, in display order. `sign` is how it enters the sum.
const FG_TRACE_LINES = [
  { key: "produced", label: "Produced", sign: "" },
  { key: "shipped", label: "Shipped (orders)", sign: "−" },
  { key: "shuttle", label: "Moyel shuttle (trailers)", sign: "−" },
  { key: "adjusted", label: "Adjusted (whole pallets + case adjustments)", sign: "−" },
  { key: "missing", label: "Missing", sign: "−" },
  { key: "pending", label: "Pending forklift review", sign: "−" },
  { key: "in_stock", label: "In stock", sign: "=" },
];

const describe = (item) => {
  const parts = [];
  if (item.order_number) parts.push(`Order ${item.order_number}${item.customer ? ` (${item.customer})` : ""}`);
  if (item.trailer_number) parts.push(`Trailer ${item.trailer_number}`);
  if (item.row_name) parts.push(item.row_name);
  if (item.partial) parts.push("partial pull");
  if (item.live_loaded) parts.push("live-loaded");
  if (item.case_adjustment) parts.push(`${item.cases > 0 ? "+" : "−"}${Math.abs(item.cases)} cases on the pallet`);
  if (item.adjustment_type) parts.push(item.adjustment_type.replace(/-/g, " "));
  if (item.reason_code) parts.push(item.reason_code.replace(/_/g, " "));
  if (item.reason) parts.push(item.reason);
  return parts.join(" · ");
};

const PalletList = ({ items }) => (
  <table className="report-table" style={{ width: "100%", fontSize: "12px" }}>
    <thead>
      <tr><th>#</th><th>Licence</th><th>Cases</th><th>Where / why</th><th>Who</th><th>When</th></tr>
    </thead>
    <tbody>
      {items.map((it, i) => (
        <tr key={`${it.licence_number}-${i}`}>
          <td>{it.sequence != null ? String(it.sequence).padStart(3, "0") : "—"}</td>
          <td style={{ fontFamily: "monospace" }}>{it.licence_number}</td>
          {/* The column is what the row takes off its line, so a case
              adjustment's rows add up to the line total (−50 removed shows
              50; +3 added back shows −3). The signed change is in the text. */}
          <td>{formatNumber(it.case_adjustment ? -it.cases : it.cases)}</td>
          <td>{describe(it) || "—"}</td>
          <td>{it.by || "—"}</td>
          <td>{it.at ? formatDateTime(it.at) : "—"}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * Finished-goods lot trace from the pallets themselves (FG pallet lifecycle §5):
 * Produced − Shipped − Moyel shuttle − Adjusted − Missing − Pending = In stock.
 * Each line opens to its pallets. Not produced is listed but not counted.
 */
const FgPalletTrace = ({ lot }) => {
  const [open, setOpen] = useState(null);
  const toggle = (k) => setOpen((cur) => (cur === k ? null : k));
  return (
    <div className="reports-section lot-trace-receipt" data-testid="fg-pallet-trace">
      <div className="lot-trace-header">
        <div className="lot-trace-header-main">
          <h3>
            {lot.product_name}
            {lot.product_code && <span className="lot-code-badge">{lot.product_code}</span>}
            <span className="lot-badge">Lot {lot.lot_number}</span>
            {lot.balanced ? (
              <span className="lot-status lot-status--approved">✅ balanced</span>
            ) : (
              <span className="lot-status lot-status--hold">
                Off by {lot.difference.pallets} pallets / {formatNumber(lot.difference.cases)} cases
              </span>
            )}
          </h3>
          <div className="lot-trace-meta">
            <span>From pallets</span>
            <span>Receipts on hand: <strong>{formatNumber(lot.books.receipt_on_hand)} cases</strong></span>
            {Math.abs(lot.books.on_hand_difference) > 0.001 && (
              <span style={{ color: "#b91c1c" }}>
                Pallets vs receipts: {lot.books.on_hand_difference > 0 ? "+" : ""}{formatNumber(lot.books.on_hand_difference)} cases
              </span>
            )}
          </div>
        </div>
      </div>
      <table className="report-table" style={{ width: "100%" }}>
        <thead><tr><th /><th>Line</th><th style={{ textAlign: "right" }}>Pallets</th><th style={{ textAlign: "right" }}>Cases</th></tr></thead>
        <tbody>
          {FG_TRACE_LINES.map(({ key, label, sign }) => {
            const b = lot[key];
            const items = b.items || [];
            return (
              <React.Fragment key={key}>
                <tr onClick={() => items.length && toggle(key)} style={{ cursor: items.length ? "pointer" : "default", fontWeight: key === "in_stock" || key === "produced" ? 700 : 400 }}>
                  <td style={{ width: "24px" }}>{sign}</td>
                  <td>{label}{items.length ? (open === key ? " ▾" : " ▸") : ""}</td>
                  <td style={{ textAlign: "right" }}>{formatNumber(b.pallets)}</td>
                  <td style={{ textAlign: "right" }}>{formatNumber(b.cases)}</td>
                </tr>
                {open === key && (
                  <tr><td /><td colSpan={3}>
                    {key === "in_stock" && (lot.in_stock_by_row || []).length > 0 && (
                      <div style={{ marginBottom: "6px" }}>
                        {lot.in_stock_by_row.map((r) => (
                          <span key={r.row_name} className="row-chip row-chip--to">
                            <span className="row-chip-name">{r.row_name}</span>
                            <span className="row-chip-qty">{r.pallets} pal · {formatNumber(r.cases)} cs</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <PalletList items={items} />
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
          <tr onClick={() => lot.not_produced.items.length && toggle("not_produced")} style={{ color: "#6b7280", cursor: "pointer" }}>
            <td />
            <td>Not produced (not counted){lot.not_produced.items.length ? (open === "not_produced" ? " ▾" : " ▸") : ""}</td>
            <td style={{ textAlign: "right" }}>{lot.not_produced.pallets}</td>
            <td />
          </tr>
          {open === "not_produced" && (
            <tr><td /><td colSpan={3}><PalletList items={lot.not_produced.items} /></td></tr>
          )}
        </tbody>
      </table>
      {(lot.found_history || []).length > 0 && (
        <div className="lot-timeline">
          <h4>Missing → found</h4>
          <ul style={{ fontSize: "13px" }}>
            {lot.found_history.map((e, i) => (
              <li key={i}>
                <strong>{e.licence_number}</strong> {e.event_type.replace(/_/g, " ")}
                {e.by ? ` · ${e.by}` : ""}{e.at ? ` · ${formatDateTime(e.at)}` : ""}
                {e.reason ? ` — ${e.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default FgPalletTrace;
