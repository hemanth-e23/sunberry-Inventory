import React, { useMemo, useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import { useAppData } from "../../context/AppDataContext";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, GROUP_ORDER } from "./reportUtils";

const SnapshotReport = ({ productOptions, categoryOptions }) => {
  const {
    receiptReportingRows,
    finishedGoodsCapacitySummary,
    categories,
  } = useAppData();

  // ── State ──
  const [snapMode, setSnapMode] = useState("current");
  const [snapDate, setSnapDate] = useState(today());
  const [snapCatFilter, setSnapCatFilter] = useState("");
  const [snapProductFilter, setSnapProductFilter] = useState("");
  const [snapHoldFilter, setSnapHoldFilter] = useState("all");
  const [snapData, setSnapData] = useState(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapError, setSnapError] = useState(null);

  // ── Derived ──
  const categoryParentMap = useMemo(() => {
    const map = {};
    (categories || []).forEach((c) => { if (c.id && c.type) map[c.id] = c.type; });
    return map;
  }, [categories]);

  const currentSnapshotRows = useMemo(() => {
    return receiptReportingRows.filter((row) => {
      if (snapProductFilter && row.productId !== snapProductFilter) return false;
      if (snapCatFilter && row.categoryId !== snapCatFilter) return false;
      if (snapHoldFilter === "on" && !row.hold) return false;
      if (snapHoldFilter === "off" && row.hold) return false;
      return true;
    });
  }, [receiptReportingRows, snapProductFilter, snapCatFilter, snapHoldFilter]);

  const currentSnapshotByProduct = useMemo(() => {
    const map = new Map();
    currentSnapshotRows.forEach((row) => {
      const key = row.productId;
      if (!map.has(key)) {
        const groupId = categoryParentMap[row.categoryId] || "other";
        map.set(key, {
          productId: row.productId,
          productName: row.productName,
          productCode: row.productCode,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          groupId,
          lots: 0,
          lotNumbers: new Set(),
          casesOnHand: 0,
          palletsOnHand: 0,
          floorPallets: 0,
          holdCases: 0,
          unit: row.quantityUnits || "cases",
        });
      }
      const entry = map.get(key);
      const qty = Number(row.quantity || 0);
      const cpp = Number(row.casesPerPallet || 0);
      entry.lots += 1;
      if (row.lotNo) entry.lotNumbers.add(row.lotNo);
      entry.casesOnHand += qty;
      entry.palletsOnHand += cpp > 0 ? qty / cpp : 0;
      entry.floorPallets += Number(row.floorPallets || 0);
      if (row.hold) entry.holdCases += qty;
      if (row.quantityUnits && row.quantityUnits !== "cases") {
        entry.unit = row.quantityUnits;
      }
    });
    return Array.from(map.values())
      .map((e) => ({ ...e, lotNumbers: Array.from(e.lotNumbers).sort() }))
      .sort((a, b) => b.casesOnHand - a.casesOnHand);
  }, [currentSnapshotRows, categoryParentMap]);

  const snapshotByGroup = useMemo(() => {
    const groups = {};
    GROUP_ORDER.forEach((g) => { groups[g.groupId] = []; });
    groups["other"] = [];
    currentSnapshotByProduct.forEach((row) => {
      const bucket = groups[row.groupId] ? row.groupId : "other";
      groups[bucket].push(row);
    });
    return groups;
  }, [currentSnapshotByProduct]);

  const groupTotals = useMemo(() => {
    const totals = {};
    Object.entries(snapshotByGroup).forEach(([gid, rows]) => {
      totals[gid] = rows.reduce(
        (acc, r) => ({ cases: acc.cases + r.casesOnHand, pallets: acc.pallets + r.palletsOnHand, floor: acc.floor + r.floorPallets, hold: acc.hold + r.holdCases }),
        { cases: 0, pallets: 0, floor: 0, hold: 0 },
      );
    });
    return totals;
  }, [snapshotByGroup]);

  // ── API fetch ──
  const fetchSnapshot = useCallback(async () => {
    if (!snapDate) return;
    setSnapLoading(true);
    setSnapError(null);
    try {
      const data = await apiFetch("/reports/point-in-time", {
        as_of_date: snapDate,
        product_id: snapProductFilter || undefined,
        category_id: snapCatFilter || undefined,
      });
      setSnapData(data);
    } catch (e) {
      setSnapError(apiError(e));
    } finally {
      setSnapLoading(false);
    }
  }, [snapDate, snapProductFilter, snapCatFilter]);

  // ── Columns ──
  const snapPitCols = [
    { label: "Product", value: (r) => r.product_name },
    { label: "Code", value: (r) => r.product_code },
    { label: "Category", value: (r) => r.category_name },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Vendor", value: (r) => r.vendor_name || "—" },
    { label: "Receipt Date", value: (r) => formatDate(r.receipt_date) },
    { label: "Expiry Date", value: (r) => formatDate(r.expiration_date) },
    { label: "Quantity", value: (r) => `${formatNumber(r.quantity)} ${r.unit}` },
  ];

  return (
    <section className="reports-panel">
      {/* Mode toggle */}
      <div className="snap-mode-bar">
        <div className="snap-mode-toggle">
          <button
            type="button"
            className={snapMode === "current" ? "active" : ""}
            onClick={() => setSnapMode("current")}
          >
            Current On-Hand
          </button>
          <button
            type="button"
            className={snapMode === "pit" ? "active" : ""}
            onClick={() => setSnapMode("pit")}
          >
            Point-in-Time
          </button>
        </div>

        {snapMode === "pit" && (
          <div className="snap-pit-controls">
            <label>
              <span>As of Date</span>
              <input
                type="date"
                value={snapDate}
                onChange={(e) => setSnapDate(e.target.value)}
                max={today()}
              />
            </label>
            <RunButton onClick={fetchSnapshot} loading={snapLoading} />
          </div>
        )}

        {snapMode === "current" && (
          <div className="snap-pit-controls">
            <label>
              <span>Product</span>
              <SearchableSelect options={productOptions} value={snapProductFilter} onChange={setSnapProductFilter} allowEmptyOption emptyLabel="All Products" />
            </label>
            <label>
              <span>Category</span>
              <SearchableSelect options={categoryOptions} value={snapCatFilter} onChange={setSnapCatFilter} allowEmptyOption emptyLabel="All Categories" />
            </label>
            <label>
              <span>Hold Status</span>
              <SearchableSelect
                options={[
                  { value: "all", label: "Hold & Released" },
                  { value: "on", label: "On Hold Only" },
                  { value: "off", label: "Exclude Hold" },
                ]}
                value={snapHoldFilter}
                onChange={setSnapHoldFilter}
                allowEmptyOption={false}
              />
            </label>
          </div>
        )}
      </div>

      {/* Current mode */}
      {snapMode === "current" && (
        <>
          {GROUP_ORDER.map(({ groupId, label, color }) => {
            const rows = snapshotByGroup[groupId] || [];
            const totals = groupTotals[groupId] || { cases: 0, pallets: 0, floor: 0, hold: 0 };
            const isFG = groupId === "finished";

            const unitTotals = {};
            if (!isFG) {
              rows.forEach((r) => {
                const u = r.unit || "cases";
                unitTotals[u] = (unitTotals[u] || 0) + r.casesOnHand;
              });
            }

            const lotCol = {
              label: "Lot Numbers",
              value: (r) => (r.lotNumbers || []).join(", ") || "—",
              renderValue: (r) => (r.lotNumbers || []).length === 0
                ? <span style={{color:"#9ca3af"}}>—</span>
                : (
                  <div style={{display:"flex", flexWrap:"wrap", gap:3}}>
                    {(r.lotNumbers || []).map((ln) => (
                      <span key={ln} style={{display:"inline-block", padding:"1px 7px", background:"#fff7ed", color:"#c2410c", border:"1px solid #fed7aa", borderRadius:10, fontSize:11, fontWeight:600, whiteSpace:"nowrap"}}>{ln}</span>
                    ))}
                  </div>
                ),
            };

            const cols = isFG
              ? [
                  { label: "Product", value: (r) => r.productName },
                  { label: "Code", value: (r) => r.productCode },
                  { label: "Category", value: (r) => r.categoryName },
                  lotCol,
                  { label: "Cases On Hand", value: (r) => formatNumber(r.casesOnHand) },
                  { label: "Pallets On Hand", value: (r) => formatNumber(r.palletsOnHand, 2) },
                  { label: "Floor Pallets", value: (r) => formatNumber(r.floorPallets, 2) },
                  { label: "Hold Cases", value: (r) => formatNumber(r.holdCases) },
                ]
              : [
                  { label: "Product", value: (r) => r.productName },
                  { label: "Code", value: (r) => r.productCode },
                  { label: "Category", value: (r) => r.categoryName },
                  lotCol,
                  { label: "Qty On Hand", value: (r) => formatNumber(r.casesOnHand) },
                  { label: "Unit", value: (r) => r.unit || "cases" },
                  { label: "Hold Qty", value: (r) => r.holdCases > 0 ? formatNumber(r.holdCases) : "—" },
                ];

            return (
              <div key={groupId} className="reports-section snapshot-group-section">
                <div className="snapshot-group-header" style={{ borderLeftColor: color }}>
                  <div className="snapshot-group-title">
                    <span className="snapshot-group-dot" style={{ background: color }} />
                    <h3>{label}</h3>
                    <span className="snapshot-group-count">{rows.length} product{rows.length !== 1 ? "s" : ""}</span>
                  </div>

                  <div className="snapshot-group-totals">
                    {isFG ? (
                      <>
                        <span><strong>{formatNumber(totals.cases)}</strong> cases</span>
                        <span><strong>{formatNumber(totals.pallets, 2)}</strong> pallets</span>
                        <span><strong>{formatNumber(finishedGoodsCapacitySummary?.utilization || 0, 0)}%</strong> rack</span>
                      </>
                    ) : (
                      Object.entries(unitTotals).map(([u, qty]) => (
                        <span key={u}><strong>{formatNumber(qty)}</strong> {u}</span>
                      ))
                    )}
                    {totals.hold > 0 && (
                      <span className="hold-badge">{formatNumber(totals.hold)} held</span>
                    )}
                  </div>

                  <ExportButtons
                    columns={cols}
                    rows={rows}
                    fileBaseName={`snapshot-${label.toLowerCase().replace(/\s+/g, "-")}`}
                  />
                </div>

                {rows.length === 0 ? (
                  <p className="group-empty">No {label.toLowerCase()} currently in stock.</p>
                ) : (
                  <ReportTable columns={cols} rows={rows} />
                )}
              </div>
            );
          })}
        </>
      )}

      {/* Point-in-time mode */}
      {snapMode === "pit" && (
        <>
          {snapLoading && <LoadingBox />}
          {snapError && <ErrorBox message={snapError} />}
          {!snapLoading && !snapError && !snapData && (
            <div className="report-empty-prompt">Select a date and click <strong>Run Report</strong> to see what was on hand on that day.</div>
          )}
          {snapData && (
            <>
              <SummaryCards cards={[
                { label: "As of Date", value: snapData.as_of_date },
                { label: "Total Lots", value: formatNumber(snapData.totals?.lots) },
                ...Object.entries(snapData.totals?.by_category || {}).map(([k, v]) => ({
                  label: `${k?.charAt(0).toUpperCase()}${k?.slice(1) || ""} Cases`,
                  value: formatNumber(v),
                })),
              ]} />
              <div className="reports-section">
                <div className="reports-section-header">
                  <div>
                    <h3>Inventory on {snapData.as_of_date}</h3>
                    <p>Reconstructed from current data by rewinding subsequent transactions.</p>
                  </div>
                  <ExportButtons columns={snapPitCols} rows={snapData.rows || []} fileBaseName={`inventory-snapshot-${snapData.as_of_date}`} />
                </div>
                <ReportTable columns={snapPitCols} rows={snapData.rows || []} emptyMessage="No inventory found for that date." />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
};

export default SnapshotReport;
