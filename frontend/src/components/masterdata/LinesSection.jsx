import React, { useMemo, useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";

const LinesSection = () => {
  const {
    productionLines,
    addProductionLine,
    updateProductionLine,
    toggleProductionLineActive,
  } = useAppData();
  const { addToast } = useToast();

  const [showInactiveLines, setShowInactiveLines] = useState(false);
  const [newLineName, setNewLineName] = useState("");
  const [newLineNotes, setNewLineNotes] = useState("");
  const [editingLine, setEditingLine] = useState(null);
  const [lineDraft, setLineDraft] = useState({ name: "", notes: "" });

  const filteredLines = useMemo(
    () =>
      productionLines.filter(
        (line) => showInactiveLines || line.active !== false,
      ),
    [productionLines, showInactiveLines],
  );

  const handleAddLine = async (event) => {
    event.preventDefault();
    try {
      const result = await addProductionLine(newLineName, newLineNotes);
      if (result) {
        setNewLineName("");
        setNewLineNotes("");
      }
    } catch (error) {
      addToast(
        error.message || "Failed to add production line. Please try again.",
        "error",
      );
    }
  };

  return (
    <div>
      <form onSubmit={handleAddLine} className="inline-form responsive">
        <label className="full">
          <span>Add Line</span>
          <input
            type="text"
            value={newLineName}
            onChange={(e) => setNewLineName(e.target.value)}
            placeholder="e.g. Line 1"
            required
          />
        </label>
        <label className="full">
          <span>Notes</span>
          <input
            type="text"
            value={newLineNotes}
            onChange={(e) => setNewLineNotes(e.target.value)}
            placeholder="Optional"
          />
        </label>
        <button type="submit" className="primary-button">
          Add Line
        </button>
      </form>

      <div className="panel-header">
        <h3>Lines</h3>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showInactiveLines}
            onChange={(event) => setShowInactiveLines(event.target.checked)}
          />
          <span>Show inactive</span>
        </label>
      </div>
      <ul className="chip-list">
        {filteredLines.map((line) => (
          <li key={line.id} className="chip-item">
            {editingLine === line.id ? (
              <div className="inline-edit">
                <input
                  type="text"
                  value={lineDraft.name}
                  onChange={(e) =>
                    setLineDraft((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="Line name"
                  autoFocus
                />
                <input
                  type="text"
                  value={lineDraft.notes}
                  onChange={(e) =>
                    setLineDraft((prev) => ({
                      ...prev,
                      notes: e.target.value,
                    }))
                  }
                  placeholder="Notes"
                />
                <div className="node-actions">
                  <button
                    className="primary-button"
                    onClick={async () => {
                      try {
                        await updateProductionLine(line.id, lineDraft);
                        setEditingLine(null);
                      } catch (error) {
                        addToast(
                          error.message ||
                            "Failed to update production line. Please try again.",
                          "error",
                        );
                      }
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => setEditingLine(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="chip-item-inner">
                <div>
                  <span className="chip-label">{line.name}</span>
                  {line.notes && (
                    <span className="muted small">{line.notes}</span>
                  )}
                  <span
                    className={`chip ${
                      line.active === false ? "chip-hold" : "chip-clear"
                    }`}
                  >
                    {line.active === false ? "Inactive" : "Active"}
                  </span>
                </div>
                <div className="node-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setEditingLine(line.id);
                      setLineDraft({
                        name: line.name,
                        notes: line.notes || "",
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await toggleProductionLineActive(line.id);
                      } catch (error) {
                        addToast(
                          error.message ||
                            "Failed to toggle production line. Please try again.",
                          "error",
                        );
                      }
                    }}
                  >
                    {line.active === false ? "Activate" : "Deactivate"}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
        {!filteredLines.length && (
          <li className="muted">No lines defined.</li>
        )}
      </ul>
    </div>
  );
};

export default LinesSection;
