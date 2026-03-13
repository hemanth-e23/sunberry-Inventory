import React, { useState, useMemo } from "react";
import { formatDateTime as formatDate } from "../../utils/dateUtils";
import { CATEGORY_TYPES } from '../../constants';

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

const RecentEntriesTab = ({
  receipts,
  productsById,
  categoriesById,
  userLookup,
  getReceiptLocations,
}) => {
  const [recentSearch, setRecentSearch] = useState("");
  const [recentStatusFilter, setRecentStatusFilter] = useState("all");
  const [recentTypeFilter, setRecentTypeFilter] = useState("all");

  const recentEntries = useMemo(() => {
    const sorted = [...receipts].sort((a, b) => {
      const aTime =
        parseDate(a.approvedAt) || parseDate(a.submittedAt) || parseDate(a.receiptDate) || 0;
      const bTime =
        parseDate(b.approvedAt) || parseDate(b.submittedAt) || parseDate(b.receiptDate) || 0;
      return bTime - aTime;
    });

    const term = recentSearch.trim().toLowerCase();
    const isFiltered = term || recentStatusFilter !== "all" || recentTypeFilter !== "all";

    return sorted
      .filter((receipt) => {
        if (term) {
          const product = productsById[receipt.productId];
          const productName = (product?.name || "").toLowerCase();
          const lot = (receipt.lotNo || "").toLowerCase();
          const submitted = formatDate(receipt.submittedAt || receipt.receiptDate).toLowerCase();
          const approved = formatDate(receipt.approvedAt).toLowerCase();
          if (
            !productName.includes(term) &&
            !lot.includes(term) &&
            !submitted.includes(term) &&
            !approved.includes(term)
          ) return false;
        }
        if (recentStatusFilter !== "all" && receipt.status !== recentStatusFilter) return false;
        if (recentTypeFilter !== "all") {
          const product = productsById[receipt.productId];
          const category = categoriesById[product?.categoryId];
          if (recentTypeFilter === "finished" && category?.type !== CATEGORY_TYPES.FINISHED) return false;
          if (recentTypeFilter === "ingredient" && category?.type !== "ingredient") return false;
          if (recentTypeFilter === "packaging" && category?.type !== CATEGORY_TYPES.PACKAGING) return false;
        }
        return true;
      })
      .slice(0, isFiltered ? 100 : 30)
      .map((receipt) => {
        const product = productsById[receipt.productId];
        const category = categoriesById[product?.categoryId];
        const productType = category?.type || '-';
        const defaultCPP = productsById[receipt.productId]?.defaultCasesPerPallet ?? null;
        const qty = Number(receipt.quantity) || 0;
        const qtyUnits = receipt.quantityUnits || '';
        const derivedPallets =
          productType === CATEGORY_TYPES.FINISHED && qtyUnits === 'cases' && defaultCPP > 0
            ? Math.round((qty / defaultCPP) * 100) / 100
            : null;
        return {
          id: receipt.id,
          status: receipt.status,
          productName: product?.name || "Unknown product",
          categoryName: category?.name || "—",
          categoryType: category?.type || null,
          quantity: qty,
          quantityUnits: qtyUnits,
          pallets: derivedPallets,
          lot: receipt.lotNo || "—",
          hold: Boolean(receipt.hold),
          submittedBy:
            userLookup[receipt.submittedBy] || receipt.submittedBy || "—",
          approvedBy: receipt.approvedBy
            ? userLookup[receipt.approvedBy] || receipt.approvedBy
            : "—",
          timestamp:
            formatDate(receipt.approvedAt) ||
            formatDate(receipt.submittedAt) ||
            formatDate(receipt.receiptDate),
          timestampMs:
            parseDate(receipt.approvedAt) ||
            parseDate(receipt.submittedAt) ||
            parseDate(receipt.receiptDate) || 0,
          locations: getReceiptLocations(receipt),
          note: receipt.note || "",
        };
      });
  }, [receipts, productsById, categoriesById, userLookup, recentSearch, recentStatusFilter, recentTypeFilter, getReceiptLocations]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Latest Activity</h2>
        <span className="muted">
          Most recent submissions and approvals across all inventory
        </span>
      </div>
      <div className="filters">
        <label>
          <span>Search</span>
          <input
            type="text"
            value={recentSearch}
            onChange={(event) => setRecentSearch(event.target.value)}
            placeholder="Search product, lot, or date"
          />
        </label>
      </div>
      <div className="recent-filter-chips">
        <span className="chip-group-label">Status:</span>
        {[
          { value: "all", label: "All" },
          { value: "approved", label: "Approved" },
          { value: "recorded", label: "Recorded" },
          { value: "pending", label: "Pending" },
        ].map(opt => (
          <button
            key={opt.value}
            className={`recent-filter-chip${recentStatusFilter === opt.value ? " active" : ""}`}
            onClick={() => setRecentStatusFilter(opt.value)}
          >
            {opt.label}
          </button>
        ))}
        <span className="chip-group-label" style={{ marginLeft: 12 }}>Type:</span>
        {[
          { value: "all", label: "All" },
          { value: "finished", label: "FG" },
          { value: "ingredient", label: "Ingredients" },
          { value: "packaging", label: "Packaging" },
        ].map(opt => (
          <button
            key={opt.value}
            className={`recent-filter-chip${recentTypeFilter === opt.value ? " active" : ""}`}
            onClick={() => setRecentTypeFilter(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="recent-entry-count muted" style={{ fontSize: 13, padding: "4px 0 8px 0" }}>
        Showing {recentEntries.length} {recentEntries.length === 1 ? "entry" : "entries"}
      </div>
      <div className="recent-list">
        {(() => {
          const groups = recentEntries.reduce((acc, e) => {
            const d = new Date(e.timestampMs);
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
            const thisWeekStart = new Date(today); thisWeekStart.setDate(today.getDate() - 7);
            let key;
            if (d >= today) key = 'Today';
            else if (d >= yesterday) key = 'Yesterday';
            else if (d >= thisWeekStart) key = 'This Week';
            else key = 'Earlier';
            (acc[key] = acc[key] || []).push(e);
            return acc;
          }, {});
          const groupOrder = ['Today', 'Yesterday', 'This Week', 'Earlier'];
          return groupOrder
            .filter(label => groups[label])
            .map(label => (
            <div key={label} className="recent-group">
              <div className="group-header sticky">{label}</div>
              {groups[label].map(entry => (
                <article key={entry.id} className="recent-card">
                  <header>
                    <div>
                      <h3>{entry.productName}</h3>
                      <span className="badge">{entry.categoryName}</span>
                    </div>
                    <div className="meta">
                      <span className={`status status-${entry.status}`}>
                        {entry.status}
                        {entry.hold && <span className="tag tag-hold">Hold</span>}
                      </span>
                      <span className="timestamp">{entry.timestamp}</span>
                    </div>
                  </header>
                  <div className="recent-details">
                    <span>
                      Qty: <strong>{entry.quantity}</strong> {entry.quantityUnits || ''}
                      {entry.pallets !== null && entry.pallets !== undefined && (
                        <span className="muted"> · {entry.pallets} pallets</span>
                      )}
                    </span>
                    <span>Lot: {entry.lot}</span>
                    <span>Submitted by: {entry.submittedBy}</span>
                    <span>Reviewed by: {entry.approvedBy}</span>
                  </div>
                  {entry.locations.length > 0 && (
                    <ul className="location-list">
                      {entry.locations.map((loc, index) => (
                        <li key={`${entry.id}-loc-${index}`}>
                          <strong>{loc.label}</strong>
                          {loc.detail && <span>{loc.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.note && <p className="note">{entry.note}</p>}
                </article>
              ))}
            </div>
          ));
        })()}
        {!recentEntries.length && (
          <div className="empty-state">No receipts recorded yet.</div>
        )}
      </div>
    </section>
  );
};

export default RecentEntriesTab;
