import React, { useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";

// Case weight is a property of the package SIZE, not the flavor — set it once
// here and every product of that size inherits it on the BOL (SPEC §7.1).
const PackageSizesSection = () => {
  const { packageSizes, updatePackageSize } = useAppData();
  const { addToast } = useToast();

  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");

  const handleSave = async (id) => {
    try {
      await updatePackageSize(id, { caseWeight: draft === "" ? null : draft });
      setEditingId(null);
      setDraft("");
    } catch (error) {
      console.error("Error updating package size:", error);
      addToast("Failed to update case weight. Please try again.", "error");
    }
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Package Sizes</h2>
        <span className="muted">Case weight per size — used for the BOL</span>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Size</th>
              <th>Case Weight (lb)</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(packageSizes || []).map((size) =>
              editingId === size.id ? (
                <tr key={size.id} className="editing">
                  <td>{size.label}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      autoFocus
                    />
                  </td>
                  <td className="actions-col">
                    <button className="primary-button" onClick={() => handleSave(size.id)}>
                      Save
                    </button>
                    <button className="secondary-button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={size.id}>
                  <td>{size.label}</td>
                  <td>
                    {size.caseWeight != null ? (
                      `${size.caseWeight} lb`
                    ) : (
                      <span className="muted">not set</span>
                    )}
                  </td>
                  <td className="actions-col">
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setEditingId(size.id);
                        setDraft(size.caseWeight ?? "");
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
            {!(packageSizes || []).length && (
              <tr>
                <td colSpan={3} className="empty">
                  No package sizes defined.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default PackageSizesSection;
