import React, { useMemo, useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import "../MasterDataPage.css";

const TYPE_LABEL = { raw: "Ingredients", finished: "Finished Goods", packaging: "Packaging" };

const CategoriesSection = () => {
  const { categories, categoryGroupsMapped } = useAppData();
  const [showInactive, setShowInactive] = useState(false);

  const displayCategories = useMemo(
    () => categories.filter(
      cat => cat.type !== "group" && (showInactive || cat.active !== false)
    ),
    [categories, showInactive],
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Product Categories</h2>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
          />
          <span>Show inactive</span>
        </label>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Type</th>
              <th>Company</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {displayCategories.map(cat => (
              <tr key={cat.id}>
                <td>{cat.name}</td>
                <td>{TYPE_LABEL[cat.type] || cat.type}</td>
                <td>{categoryGroupsMapped.find(g => g.id === cat.parentId)?.name || "—"}</td>
                <td>
                  <span className={`chip ${cat.active === false ? "chip-hold" : "chip-clear"}`}>
                    {cat.active === false ? "Inactive" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
            {!displayCategories.length && (
              <tr>
                <td colSpan={4} className="empty">No categories defined.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default CategoriesSection;
