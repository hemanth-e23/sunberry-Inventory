import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar, Legend } from "recharts";
import jsPDF from "jspdf";
import "jspdf-autotable";
import { utils as XLSXUtils, writeFile as writeXLSXFile } from "xlsx";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import SearchableSelect from "./SearchableSelect";
import "./ReportsPage.css";
import "./ReportsPageEnhanced.css";

const toDateKey = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const withinRange = (value, start, end) => {
  if (!value) return true;
  const key = toDateKey(value);
  if (!key) return false;
  if (start && key < start) return false;
  if (end && key > end) return false;
  return true;
};

const formatNumber = (value, fractionDigits = 0) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

const formatDate = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
};

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const sanitizeFileName = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "report";

const ReportExportButtons = ({ columns, rows, fileBaseName }) => {
  const headers = columns.map((column) => column.label);
  const body = rows.map((row) =>
    columns.map((column) => {
      const value = column.value(row);
      return value == null ? "" : String(value);
    }),
  );

  const fileName = sanitizeFileName(fileBaseName);
  const disabled = rows.length === 0;

  const handleCSV = () => {
    if (disabled) return;
    const csvLines = [headers.join(",")].concat(
      body.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")),
    );
    const blob = new Blob([csvLines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${fileName}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExcel = () => {
    if (disabled) return;
    const worksheet = XLSXUtils.aoa_to_sheet([headers, ...body]);
    const workbook = XLSXUtils.book_new();
    XLSXUtils.book_append_sheet(workbook, worksheet, "Report");
    writeXLSXFile(workbook, `${fileName}.xlsx`);
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
      headStyles: { fillColor: [29, 78, 216] },
    });
    doc.save(`${fileName}.pdf`);
  };

  return (
    <div className="report-export-buttons">
      <button type="button" onClick={handleCSV} disabled={disabled}>
        Export CSV
      </button>
      <button type="button" onClick={handleExcel} disabled={disabled}>
        Export Excel
      </button>
      <button type="button" onClick={handlePDF} disabled={disabled}>
        Export PDF
      </button>
    </div>
  );
};

const ReportsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    receiptReportingRows,
    movementReportingRows,
    receiptsTimeline,
    finishedGoodsCapacitySummary,
    products,
    productCategories,
  } = useAppData();

  const [activeTab, setActiveTab] = useState("snapshot");
  const [productFilter, setProductFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [holdFilter, setHoldFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [movementType, setMovementType] = useState("all");

  const productOptions = useMemo(
    () =>
      [{ value: "", label: "All Products" }].concat(
        products
          .filter((product) => product.status === "active")
          .map((product) => ({
            value: product.id,
            label: `${product.name}${product.fcc ? ` (${product.fcc})` : product.sid ? ` (${product.sid})` : ""}`,
          })),
      ),
    [products],
  );

  const categoryOptions = useMemo(
    () =>
      [{ value: "", label: "All Categories" }].concat(
        productCategories.map((category) => ({
          value: category.id,
          label: category.name,
        })),
      ),
    [productCategories],
  );

  const holdOptions = useMemo(
    () => [
      { value: "all", label: "Hold & Released" },
      { value: "on", label: "On Hold Only" },
      { value: "off", label: "Exclude Hold" },
    ],
    [],
  );

  const movementOptions = useMemo(
    () => [
      { value: "all", label: "All Actions" },
      { value: "Transfer", label: "Transfers" },
      { value: "Adjustment", label: "Adjustments" },
      { value: "Hold", label: "Holds" },
      { value: "Release", label: "Hold Releases" },
    ],
    [],
  );

  const filteredReceipts = useMemo(() => {
    return receiptReportingRows.filter((row) => {
      if (productFilter && row.productId !== productFilter) return false;
      if (categoryFilter && row.categoryId !== categoryFilter) return false;
      if (holdFilter === "on" && !row.hold) return false;
      if (holdFilter === "off" && row.hold) return false;
      if (!withinRange(row.receiptDate, startDate, endDate)) return false;
      return true;
    });
  }, [receiptReportingRows, productFilter, categoryFilter, holdFilter, startDate, endDate]);

  const filteredTimeline = useMemo(() => {
    const buckets = {};
    filteredReceipts.forEach((row) => {
      const key = toDateKey(row.receiptDate);
      if (!key) return;
      if (!buckets[key]) {
        buckets[key] = {
          date: key,
          totalCases: 0,
          floorCases: 0,
        };
      }
      const totalCases = Number(row.quantity || 0);
      const derivedFloorCases = Number(row.floorPallets || 0) * Number(row.casesPerPallet || 0);
      const floorCases = Number(row.floorCases || derivedFloorCases);
      buckets[key].totalCases += totalCases;
      buckets[key].floorCases += floorCases;
    });
    return Object.values(buckets)
      .map((entry) => ({
        ...entry,
        rackCases: Math.max(entry.totalCases - entry.floorCases, 0),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [filteredReceipts]);

  const snapshotRows = useMemo(() => {
    const map = new Map();

    filteredReceipts.forEach((row) => {
      const key = row.productId;
      if (!map.has(key)) {
        map.set(key, {
          productId: row.productId,
          productName: row.productName,
          productCode: row.productCode,
          categoryName: row.categoryName,
          lots: 0,
          casesOnHand: 0,
          palletsOnHand: 0,
          floorPallets: 0,
          holdCases: 0,
        });
      }
      const entry = map.get(key);
      const cases = Number(row.quantity || 0);
      const casesPerPallet = Number(row.casesPerPallet || 0);
      entry.lots += 1;
      entry.casesOnHand += cases;
      entry.palletsOnHand += casesPerPallet > 0 ? cases / casesPerPallet : 0;
      entry.floorPallets += Number(row.floorPallets || 0);
      if (row.hold) {
        entry.holdCases += cases;
      }
    });

    return Array.from(map.values()).sort((a, b) => b.casesOnHand - a.casesOnHand);
  }, [filteredReceipts]);

  const filteredMovements = useMemo(() => {
    return movementReportingRows.filter((row) => {
      if (!withinRange(row.timestamp, startDate, endDate)) return false;
      if (productFilter) {
        const product = products.find((item) => item.id === productFilter);
        if (!product || product.name !== row.productName) {
          return false;
        }
      }
      if (movementType !== "all" && row.type !== movementType) return false;
      return true;
    });
  }, [movementReportingRows, startDate, endDate, productFilter, movementType, products]);

  const categorySummary = useMemo(() => {
    const aggregate = {};
    filteredReceipts.forEach((row) => {
      if (!aggregate[row.categoryName]) {
        aggregate[row.categoryName] = { category: row.categoryName, cases: 0, lots: 0 };
      }
      aggregate[row.categoryName].cases += Number(row.quantity || 0);
      aggregate[row.categoryName].lots += 1;
    });
    return Object.values(aggregate).sort((a, b) => b.cases - a.cases);
  }, [filteredReceipts]);

  const snapshotTotals = useMemo(() => {
    return snapshotRows.reduce(
      (acc, row) => {
        acc.cases += row.casesOnHand;
        acc.pallets += row.palletsOnHand;
        acc.floor += row.floorPallets;
        acc.hold += row.holdCases;
        return acc;
      },
      { cases: 0, pallets: 0, floor: 0, hold: 0 },
    );
  }, [snapshotRows]);

  const receiptColumns = [
    { label: "Receipt Date", value: (row) => formatDate(row.receiptDate) },
    { label: "Product", value: (row) => row.productName },
    { label: "Code", value: (row) => row.productCode },
    { label: "Category", value: (row) => row.categoryName },
    { label: "Lot", value: (row) => row.lotNo },
    { label: "Cases", value: (row) => formatNumber(row.quantity) },
    { label: "Floor Pallets", value: (row) => formatNumber(row.floorPallets, 2) },
    { label: "Hold", value: (row) => (row.hold ? "Yes" : "No") },
    { label: "Status", value: (row) => row.status },
  ];

  const snapshotColumns = [
    { label: "Product", value: (row) => row.productName },
    { label: "Code", value: (row) => row.productCode },
    { label: "Category", value: (row) => row.categoryName },
    { label: "Lots", value: (row) => formatNumber(row.lots) },
    { label: "Cases On Hand", value: (row) => formatNumber(row.casesOnHand) },
    { label: "Pallets On Hand", value: (row) => formatNumber(row.palletsOnHand, 2) },
    { label: "Floor Pallets", value: (row) => formatNumber(row.floorPallets, 2) },
    { label: "Hold Cases", value: (row) => formatNumber(row.holdCases) },
  ];

  const movementColumns = [
    { label: "Timestamp", value: (row) => formatDateTime(row.timestamp) },
    { label: "Type", value: (row) => row.type },
    { label: "Status", value: (row) => row.status },
    { label: "Product", value: (row) => row.productName },
    { label: "Quantity", value: (row) => formatNumber(row.quantity) },
    { label: "Notes", value: (row) => row.notes },
  ];

  return (
    <div className="reports-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h1>Reporting</h1>
          <p>Analyze inventory performance, receipts, and warehouse activity.</p>
        </div>
      </div>

      <section className="reports-filter-bar">
        <div className="filter-group">
          <label>
            <span>Start Date</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label>
            <span>End Date</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <div className="quick-range-buttons">
            <button type="button" onClick={() => {
              const today = new Date();
              const start = new Date(today);
              start.setDate(start.getDate() - 6);
              setStartDate(toDateKey(start));
              setEndDate(toDateKey(today));
            }}>
              Last 7 Days
            </button>
            <button type="button" onClick={() => {
              const today = new Date();
              const start = new Date(today.getFullYear(), today.getMonth(), 1);
              setStartDate(toDateKey(start));
              setEndDate(toDateKey(today));
            }}>
              Month to Date
            </button>
            <button type="button" onClick={() => {
              setStartDate("");
              setEndDate("");
            }}>
              Clear
            </button>
          </div>
        </div>
        <div className="filter-group">
          <label>
            <span>Product</span>
            <SearchableSelect
              options={productOptions}
              value={productFilter}
              onChange={setProductFilter}
              allowEmptyOption
              emptyLabel="All Products"
            />
          </label>
          <label>
            <span>Category</span>
            <SearchableSelect
              options={categoryOptions}
              value={categoryFilter}
              onChange={setCategoryFilter}
              allowEmptyOption
              emptyLabel="All Categories"
            />
          </label>
          <label>
            <span>Hold Status</span>
            <SearchableSelect
              options={holdOptions}
              value={holdFilter}
              onChange={setHoldFilter}
              allowEmptyOption={false}
            />
          </label>
          {activeTab === "movements" && (
            <label>
              <span>Action Type</span>
              <SearchableSelect
                options={movementOptions}
                value={movementType}
                onChange={setMovementType}
                allowEmptyOption={false}
              />
            </label>
          )}
        </div>
      </section>

      <nav className="reports-tabs">
        <button
          type="button"
          className={activeTab === "snapshot" ? "active" : ""}
          onClick={() => setActiveTab("snapshot")}
        >
          Inventory Snapshot
        </button>
        <button
          type="button"
          className={activeTab === "receipts" ? "active" : ""}
          onClick={() => setActiveTab("receipts")}
        >
          Receipts & Production
        </button>
        {/*
        <button
          type="button"
          className={activeTab === "movements" ? "active" : ""}
          onClick={() => setActiveTab("movements")}
        >
          Movements & Adjustments
        </button>
        */}
      </nav>

      {activeTab === "snapshot" && (
        <section className="reports-panel">
          <div className="reports-summary-grid">
            <article className="summary-card">
              <h4>Total Cases On Hand</h4>
              <span className="summary-value">{formatNumber(snapshotTotals.cases)}</span>
            </article>
            <article className="summary-card">
              <h4>Pallets On Hand</h4>
              <span className="summary-value">{formatNumber(snapshotTotals.pallets, 2)}</span>
            </article>
            <article className="summary-card">
              <h4>Floor Pallets</h4>
              <span className="summary-value">{formatNumber(snapshotTotals.floor, 2)}</span>
            </article>
            <article className="summary-card">
              <h4>Held Cases</h4>
              <span className="summary-value">{formatNumber(snapshotTotals.hold)}</span>
            </article>
            <article className="summary-card">
              <h4>Rack Utilization</h4>
              <span className="summary-value">
                {formatNumber(finishedGoodsCapacitySummary?.utilization || 0, 0)}%
              </span>
            </article>
          </div>

          <div className="reports-section">
            <div className="reports-section-header">
              <div>
                <h3>Product On-Hand Detail</h3>
                <p>Current quantity by product including floor staging and holds.</p>
              </div>
              <ReportExportButtons
                columns={snapshotColumns}
                rows={snapshotRows}
                fileBaseName="inventory-snapshot"
              />
            </div>
            <div className="table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    {snapshotColumns.map((column) => (
                      <th key={column.label}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {snapshotRows.length === 0 && (
                    <tr>
                      <td colSpan={snapshotColumns.length} className="empty-state">
                        No inventory records match the selected filters.
                      </td>
                    </tr>
                  )}
                  {snapshotRows.map((row) => (
                    <tr key={row.productId}>
                      {snapshotColumns.map((column) => (
                        <td key={column.label}>{column.value(row)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="reports-section">
            <div className="reports-section-header">
              <div>
                <h3>Category Breakdown</h3>
                <p>Lots and cases by product category.</p>
              </div>
            </div>
            <div className="table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Lots</th>
                    <th>Cases</th>
                  </tr>
                </thead>
                <tbody>
                  {categorySummary.length === 0 && (
                    <tr>
                      <td colSpan={3} className="empty-state">
                        No category data for the selected filters.
                      </td>
                    </tr>
                  )}
                  {categorySummary.map((row) => (
                    <tr key={row.category || "Uncategorized"}>
                      <td>{row.category || "Uncategorized"}</td>
                      <td>{formatNumber(row.lots)}</td>
                      <td>{formatNumber(row.cases)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {activeTab === "receipts" && (
        <section className="reports-panel">
          <div className="reports-section">
            <div className="reports-section-header">
              <div>
                <h3>Receipts Trend</h3>
                <p>Cases received split between racked inventory and floor staging.</p>
              </div>
            </div>
            <div className="chart-wrapper">
              {filteredTimeline.length === 0 ? (
                <div className="empty-state">No receipt activity for the selected filters.</div>
              ) : (
                <ResponsiveContainer width="100%" height={340}>
                  <BarChart data={filteredTimeline} margin={{ top: 20, right: 30, left: 10, bottom: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" />
                    <YAxis allowDecimals={false} label={{ value: "Cases", angle: -90, position: "insideLeft", offset: 10 }} />
                    <Tooltip
                      formatter={(value, name) => [formatNumber(value), name]}
                      labelFormatter={(label) => `Date: ${label}`}
                    />
                    <Legend verticalAlign="top" height={36} />
                    <Bar
                      dataKey="rackCases"
                      name="Cases Racked"
                      stackId="cases"
                      fill="#6366f1"
                      radius={[6, 6, 0, 0]}
                    />
                    <Bar
                      dataKey="floorCases"
                      name="Floor Cases"
                      stackId="cases"
                      fill="#f97316"
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="reports-section">
            <div className="reports-section-header">
              <div>
                <h3>Receipts Detail</h3>
                <p>Line-item receipts filtered by product, date, and hold status.</p>
              </div>
              <ReportExportButtons
                columns={receiptColumns}
                rows={filteredReceipts}
                fileBaseName="receipts-detail"
              />
            </div>
            <div className="table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    {receiptColumns.map((column) => (
                      <th key={column.label}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredReceipts.length === 0 && (
                    <tr>
                      <td colSpan={receiptColumns.length} className="empty-state">
                        No receipts match the selected filters.
                      </td>
                    </tr>
                  )}
                  {filteredReceipts.map((row) => (
                    <tr key={row.id}>
                      {receiptColumns.map((column) => (
                        <td key={column.label}>{column.value(row)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/*
      {activeTab === "movements" && (
        <section className="reports-panel">
          <div className="reports-section">
            <div className="reports-section-header">
              <div>
                <h3>Movement Summary</h3>
                <p>Transfers, adjustments, and holds across the selected period.</p>
              </div>
              <ReportExportButtons
                columns={movementColumns}
                rows={filteredMovements}
                fileBaseName="inventory-movements"
              />
            </div>
            <div className="table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    {movementColumns.map((column) => (
                      <th key={column.label}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMovements.length === 0 && (
                    <tr>
                      <td colSpan={movementColumns.length} className="empty-state">
                        No movement records for the selected filters.
                      </td>
                    </tr>
                  )}
                  {filteredMovements.map((row) => (
                    <tr key={row.id}>
                      {movementColumns.map((column) => (
                        <td key={column.label}>{column.value(row)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="reports-section">
            <div className="reports-section-header">
              <div>
                <h3>Movement Mix</h3>
                <p>Volume of actions grouped by type.</p>
              </div>
            </div>
            <div className="chart-wrapper">
              {filteredMovements.length === 0 ? (
                <div className="empty-state">No movement activity for the selected filters.</div>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={Object.values(
                      filteredMovements.reduce((acc, row) => {
                        if (!acc[row.type]) {
                          acc[row.type] = { type: row.type, count: 0 };
                        }
                        acc[row.type].count += 1;
                        return acc;
                      }, {}),
                    )}
                    margin={{ top: 20, right: 30, left: 10, bottom: 10 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="type" />
                    <YAxis allowDecimals={false} />
                    <Tooltip formatter={(value) => formatNumber(value)} />
                    <Bar dataKey="count" fill="#2563eb" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </section>
      )}
      */}
    </div>
  );
};

export default ReportsPage;
