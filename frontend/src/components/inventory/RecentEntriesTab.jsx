import React, { useState, useMemo } from "react";
import { Printer } from "lucide-react";
import { formatDateTime as formatDate } from "../../utils/dateUtils";
import { formatUserName } from "../../utils/userDisplay";
import { CATEGORY_TYPES } from '../../constants';
import { apiErrorMessage, printSessionLabels } from "../../api/lotReceivingApi";
import { useToast } from "../../context/ToastContext";
import { useAppData } from "../../context/AppDataContext";
import LotLabelPrint from "../ingredient/LotLabelPrint";
import PrintStickersDialog from "../ingredient/PrintStickersDialog";

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
  const { addToast } = useToast();
  const { refreshReceipts } = useAppData();
  const [sheet, setSheet] = useState(null);
  const [printingId, setPrintingId] = useState(null);
  // The entry whose print options are being chosen. Null when the dialog is shut.
  const [asking, setAsking] = useState(null);

  /**
   * Reprint a receipt's stickers, any time after it was logged.
   *
   * The offer used to live only in the moment after saving and vanished on
   * navigation, which does not fit how the stickering actually happens: barrels
   * already on the racks get entered now and stickered days later, as each is
   * pulled for staging. The endpoint never had a state gate — this is only
   * putting the button somewhere it survives.
   */
  const handlePrint = async ({ count, scope }) => {
    const entry = asking;
    if (!entry) return;
    setPrintingId(entry.id);
    try {
      setSheet(await printSessionLabels(entry.id, count, { scope }));
      setAsking(null);
      // Printing RESOLVES the lot when the receipt has none yet — that is what
      // makes the walk-in path work: log off the BOL, print, scan. So the
      // receipt held here is stale the moment this returns, and every screen
      // branching on `materialLotId` would keep showing the pre-lot version
      // until a hard refresh.
      refreshReceipts?.();
    } catch (error) {
      addToast(apiErrorMessage(error, "Could not print stickers"), "error");
    } finally {
      setPrintingId(null);
    }
  };

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
          submittedBy: formatUserName(receipt.submittedBy, userLookup),
          approvedBy: receipt.approvedBy
            ? formatUserName(receipt.approvedBy, userLookup)
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
          // How many identical stickers this receipt is worth — one per
          // container. Finished goods are excluded: their pallets carry unique
          // licences, not one repeated lot sticker.
          stickerCount: Math.max(0, Math.round(Number(receipt.containerCount) || 0)),
          // What one container IS, and how many ride a pallet. Together these
          // decide whether the print dialog can offer pallet stickers at all —
          // blank for barrels, 50 for bags.
          unitLabel: (receipt.containerUnit || 'unit').replace(/s$/, ''),
          unitsPerPallet: receipt.unitsPerPallet || null,
          canPrint:
            category?.type !== CATEGORY_TYPES.FINISHED &&
            Number(receipt.containerCount) > 0,
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
                  {entry.canPrint && (
                    <div className="recent-card-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setAsking(entry)}
                        disabled={printingId === entry.id}
                      >
                        <Printer size={14} />
                        {printingId === entry.id ? "Preparing…" : "Print stickers"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ));
        })()}
        {!recentEntries.length && (
          <div className="empty-state">No receipts recorded yet.</div>
        )}
      </div>
      <PrintStickersDialog
        open={!!asking}
        busy={!!printingId}
        lot={asking && {
          productName: asking.productName,
          lotCode: asking.lot,
          unitLabel: asking.unitLabel,
          unitsPerPallet: asking.unitsPerPallet,
          totalUnits: asking.stickerCount,
        }}
        onCancel={() => setAsking(null)}
        onConfirm={handlePrint}
      />

      {sheet && <LotLabelPrint sheet={sheet} onDone={() => setSheet(null)} />}
    </section>
  );
};

export default RecentEntriesTab;
