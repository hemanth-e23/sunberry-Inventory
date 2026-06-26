// Document-style exporters for a single ship-out order. Unlike the generic
// ExportButtons (one flat table), these lay the order out as a readable
// document: an order header block, then a section per product with its pallets.
import jsPDF from "jspdf";
import "jspdf-autotable";
import ExcelJS from "exceljs";
import { sanitizeFileName } from "./reportUtils";
import { formatDate, formatDateTime } from "../../utils/dateUtils";

const ORANGE = [245, 124, 0];

const num = (v) => Number(v || 0).toLocaleString();

const palletRows = (line) =>
  (line.picks || []).map((p) => ({
    licence: p.licence_number || "—",
    lot: p.lot_number || line.lot_number || "—",
    rack: p.rack || "—",
    cases: num(p.cases),
    partial: p.was_partial ? "Yes" : "No",
    scannedBy: p.scanned_by || "—",
    scannedAt: p.scanned_at ? formatDateTime(p.scanned_at) : "—",
  }));

const fileBase = (data) => sanitizeFileName(`ship-out-order-${data.order_number || "order"}`);

const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// ── PDF: a proper order document ─────────────────────────────────────────────
export const exportOrderPDF = (data) => {
  const doc = new jsPDF("portrait", "pt", "a4");
  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 40;
  let y = 48;

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Ship-Out Order", marginX, y);
  doc.setFontSize(16);
  doc.text(`#${data.order_number || "—"}`, pageW - marginX, y, { align: "right" });
  y += 10;
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(1.5);
  doc.line(marginX, y, pageW - marginX, y);
  y += 22;

  // Meta block (two columns of label/value pairs)
  const meta = [
    ["Created By", data.created_by || "—"],
    ["Created", data.created_at ? formatDateTime(data.created_at) : "—"],
    ["Approved By", data.approved_by || "—"],
    ["Approved", data.approved_at ? formatDateTime(data.approved_at) : "—"],
    ["Total Cases", num(data.totals?.cases_picked)],
    ["Pallets", num(data.totals?.pallet_count)],
    ["Products", num(data.totals?.line_count)],
    ["Printed", formatDate(new Date().toISOString())],
  ];
  const colW = (pageW - marginX * 2) / 2;
  doc.setFontSize(10);
  meta.forEach(([label, value], i) => {
    const col = i % 2;
    const x = marginX + col * colW;
    if (col === 0 && i > 0) y += 18;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(110);
    doc.text(`${label.toUpperCase()}`, x, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(20);
    doc.text(String(value), x + 90, y);
  });
  y += 28;

  // One section per product line
  (data.lines || []).forEach((line) => {
    const rows = palletRows(line);
    const heading = `${line.product_name || "—"}  (${line.product_code || "—"})`;
    const subheading = `${num(line.cases_picked)} cases${line.lot_number ? `  ·  Lot ${line.lot_number}` : ""}  ·  ${rows.length} pallets`;

    if (y > doc.internal.pageSize.getHeight() - 120) {
      doc.addPage();
      y = 48;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(heading, marginX, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(subheading, marginX, y);
    y += 8;

    doc.autoTable({
      startY: y,
      head: [["Licence #", "Lot #", "Rack", "Cases", "Partial", "Scanned By", "Scanned At"]],
      body: rows.map((r) => [r.licence, r.lot, r.rack, r.cases, r.partial, r.scannedBy, r.scannedAt]),
      styles: { fontSize: 8, cellPadding: 4, textColor: 30 },
      headStyles: { fillColor: ORANGE, textColor: 255 },
      alternateRowStyles: { fillColor: [250, 250, 250] },
      margin: { left: marginX, right: marginX },
    });
    y = doc.lastAutoTable.finalY + 24;
  });

  // Page footer
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `Order ${data.order_number || ""}  ·  Page ${p} of ${pages}`,
      pageW / 2,
      doc.internal.pageSize.getHeight() - 20,
      { align: "center" },
    );
  }

  doc.save(`${fileBase(data)}.pdf`);
};

// ── Excel: header block + per-product tables ─────────────────────────────────
export const exportOrderExcel = async (data) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ship-Out Order");
  ws.columns = [
    { width: 26 }, { width: 16 }, { width: 10 }, { width: 9 },
    { width: 9 }, { width: 16 }, { width: 22 },
  ];

  const titleRow = ws.addRow([`Ship-Out Order #${data.order_number || "—"}`]);
  titleRow.font = { bold: true, size: 16 };
  ws.mergeCells(titleRow.number, 1, titleRow.number, 7);

  const metaPairs = [
    ["Created By", data.created_by || "—", "Created", data.created_at ? formatDateTime(data.created_at) : "—"],
    ["Approved By", data.approved_by || "—", "Approved", data.approved_at ? formatDateTime(data.approved_at) : "—"],
    ["Total Cases", num(data.totals?.cases_picked), "Pallets", num(data.totals?.pallet_count)],
    ["Products", num(data.totals?.line_count), "", ""],
  ];
  metaPairs.forEach((p) => {
    const row = ws.addRow(p);
    row.getCell(1).font = { bold: true, color: { argb: "FF6B7280" } };
    row.getCell(3).font = { bold: true, color: { argb: "FF6B7280" } };
  });
  ws.addRow([]);

  (data.lines || []).forEach((line) => {
    const hdr = ws.addRow([
      `${line.product_name || "—"} (${line.product_code || "—"}) — ${num(line.cases_picked)} cases${line.lot_number ? ` · Lot ${line.lot_number}` : ""}`,
    ]);
    hdr.font = { bold: true, size: 12 };
    ws.mergeCells(hdr.number, 1, hdr.number, 7);

    const colHeader = ws.addRow(["Licence #", "Lot #", "Rack", "Cases", "Partial", "Scanned By", "Scanned At"]);
    colHeader.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF57C00" } };
    });
    palletRows(line).forEach((r) => {
      ws.addRow([r.licence, r.lot, r.rack, r.cases, r.partial, r.scannedBy, r.scannedAt]);
    });
    ws.addRow([]);
  });

  const buffer = await wb.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${fileBase(data)}.xlsx`,
  );
};

// ── CSV: metadata header lines, then a flat per-pallet table ──────────────────
export const exportOrderCSV = (data) => {
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [];
  lines.push([esc("Ship-Out Order"), esc(data.order_number || "")].join(","));
  lines.push([esc("Created By"), esc(data.created_by || ""), esc("Created"), esc(data.created_at ? formatDateTime(data.created_at) : "")].join(","));
  lines.push([esc("Approved By"), esc(data.approved_by || ""), esc("Approved"), esc(data.approved_at ? formatDateTime(data.approved_at) : "")].join(","));
  lines.push([esc("Total Cases"), esc(num(data.totals?.cases_picked)), esc("Pallets"), esc(num(data.totals?.pallet_count)), esc("Products"), esc(num(data.totals?.line_count))].join(","));
  lines.push("");
  lines.push(["Product", "Code", "Lot #", "Licence #", "Rack", "Cases", "Partial", "Scanned By", "Scanned At"].map(esc).join(","));
  (data.lines || []).forEach((line) => {
    palletRows(line).forEach((r) => {
      lines.push([
        line.product_name, line.product_code, r.lot, r.licence, r.rack, r.cases, r.partial, r.scannedBy, r.scannedAt,
      ].map(esc).join(","));
    });
  });
  triggerDownload(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }), `${fileBase(data)}.csv`);
};
