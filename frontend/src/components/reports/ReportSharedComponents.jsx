import React from "react";
import jsPDF from "jspdf";
import "jspdf-autotable";
import ExcelJS from "exceljs";
import { sanitizeFileName, daysAgo, today, monthStart } from "./reportUtils";

// ─────────────────────────────────────────────────────────────────────────────
// Export buttons
// ─────────────────────────────────────────────────────────────────────────────

export const ExportButtons = ({ columns, rows, fileBaseName }) => {
  const headers = columns.map((c) => c.label);
  const body = rows.map((row) =>
    columns.map((c) => {
      const v = c.value(row);
      return v == null ? "" : String(v);
    }),
  );
  const fileName = sanitizeFileName(fileBaseName);
  const disabled = rows.length === 0;

  const handleCSV = () => {
    if (disabled) return;
    const lines = [headers.join(",")].concat(
      body.map((r) => r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${fileName}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExcel = async () => {
    if (disabled) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Report");
    ws.addRow(headers);
    body.forEach((row) => ws.addRow(row));
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePDF = () => {
    if (disabled) return;
    const orientation = headers.length > 6 ? "landscape" : "portrait";
    const doc = new jsPDF(orientation, "pt", "a4");
    doc.setFontSize(14);
    doc.text(fileBaseName, 40, 40);
    doc.autoTable({
      startY: 60,
      head: [headers],
      body,
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [245, 124, 0] },
    });
    doc.save(`${fileName}.pdf`);
  };

  return (
    <div className="report-export-buttons">
      <button type="button" onClick={handleCSV} disabled={disabled}>Export CSV</button>
      <button type="button" onClick={handleExcel} disabled={disabled}>Export Excel</button>
      <button type="button" onClick={handlePDF} disabled={disabled}>Export PDF</button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Reusable table
// ─────────────────────────────────────────────────────────────────────────────

export const ReportTable = ({ columns, rows, emptyMessage = "No data for the selected filters." }) => (
  <div className="table-wrapper">
    <table className="report-table">
      <thead>
        <tr>{columns.map((c) => <th key={c.label} className={c.className}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length} className="empty-state">{emptyMessage}</td></tr>
        ) : (
          rows.map((row, i) => (
            <tr key={row.id || i}>
              {columns.map((c) => <td key={c.label} className={c.className}>{(c.renderValue || c.value)(row)}</td>)}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary card grid
// ─────────────────────────────────────────────────────────────────────────────

export const SummaryCards = ({ cards }) => (
  <div className="reports-summary-grid">
    {cards.map((card) => (
      <article key={card.label} className={`summary-card${card.highlight ? " summary-card--highlight" : ""}`}>
        <h4>{card.label}</h4>
        <span className="summary-value">{card.value}</span>
        {card.sub && <span className="summary-sub">{card.sub}</span>}
      </article>
    ))}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Loading / error states
// ─────────────────────────────────────────────────────────────────────────────

export const LoadingBox = () => (
  <div className="report-loading">
    <span className="report-spinner" />
    Loading report data…
  </div>
);

export const ErrorBox = ({ message }) => (
  <div className="report-error">⚠ {message}</div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Run Report button
// ─────────────────────────────────────────────────────────────────────────────

export const RunButton = ({ onClick, loading }) => (
  <button className="run-report-btn" onClick={onClick} disabled={loading} type="button">
    {loading ? "Loading…" : "Run Report"}
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// Quick range buttons
// ─────────────────────────────────────────────────────────────────────────────

export const QuickRange = ({ onRange }) => (
  <div className="quick-range-buttons">
    <button type="button" onClick={() => onRange(daysAgo(6), today())}>Last 7 Days</button>
    <button type="button" onClick={() => onRange(daysAgo(29), today())}>Last 30 Days</button>
    <button type="button" onClick={() => onRange(monthStart(), today())}>Month to Date</button>
    <button type="button" onClick={() => onRange("", "")}>Clear</button>
  </div>
);
