import React, { useMemo, useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";

const ShiftsSection = () => {
  const {
    productionShifts,
    addProductionShift,
    updateProductionShift,
    toggleProductionShiftActive,
  } = useAppData();
  const { addToast } = useToast();

  const [showInactiveShifts, setShowInactiveShifts] = useState(false);
  const [newShiftName, setNewShiftName] = useState("");
  const [newShiftNotes, setNewShiftNotes] = useState("");
  const [editingShift, setEditingShift] = useState(null);
  const [shiftDraft, setShiftDraft] = useState({ name: "", notes: "" });

  const filteredShifts = useMemo(
    () =>
      productionShifts.filter(
        (shift) => showInactiveShifts || shift.active !== false,
      ),
    [productionShifts, showInactiveShifts],
  );

  const handleAddShift = async (event) => {
    event.preventDefault();
    try {
      const result = await addProductionShift(newShiftName, newShiftNotes);
      if (result) {
        setNewShiftName("");
        setNewShiftNotes("");
      }
    } catch (error) {
      addToast(
        error.message || "Failed to add production shift. Please try again.",
        "error",
      );
    }
  };

  return (
    <div>
      <form onSubmit={handleAddShift} className="inline-form responsive">
        <label className="full">
          <span>Add Shift</span>
          <input
            type="text"
            value={newShiftName}
            onChange={(e) => setNewShiftName(e.target.value)}
            placeholder="e.g. Shift A"
            required
          />
        </label>
        <label className="full">
          <span>Notes</span>
          <input
            type="text"
            value={newShiftNotes}
            onChange={(e) => setNewShiftNotes(e.target.value)}
            placeholder="Optional"
          />
        </label>
        <button type="submit" className="primary-button">
          Add Shift
        </button>
      </form>

      <div className="panel-header">
        <h3>Shifts</h3>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showInactiveShifts}
            onChange={(event) => setShowInactiveShifts(event.target.checked)}
          />
          <span>Show inactive</span>
        </label>
      </div>
      <ul className="chip-list">
        {filteredShifts.map((shift) => (
          <li key={shift.id} className="chip-item">
            {editingShift === shift.id ? (
              <div className="inline-edit">
                <input
                  type="text"
                  value={shiftDraft.name}
                  onChange={(e) =>
                    setShiftDraft((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="Shift name"
                  autoFocus
                />
                <input
                  type="text"
                  value={shiftDraft.notes}
                  onChange={(e) =>
                    setShiftDraft((prev) => ({
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
                        await updateProductionShift(shift.id, shiftDraft);
                        setEditingShift(null);
                      } catch (error) {
                        addToast(
                          error.message ||
                            "Failed to update production shift. Please try again.",
                          "error",
                        );
                      }
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => setEditingShift(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="chip-item-inner">
                <div>
                  <span className="chip-label">{shift.name}</span>
                  {shift.notes && (
                    <span className="muted small">{shift.notes}</span>
                  )}
                  <span
                    className={`chip ${
                      shift.active === false ? "chip-hold" : "chip-clear"
                    }`}
                  >
                    {shift.active === false ? "Inactive" : "Active"}
                  </span>
                </div>
                <div className="node-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setEditingShift(shift.id);
                      setShiftDraft({
                        name: shift.name,
                        notes: shift.notes || "",
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
                        await toggleProductionShiftActive(shift.id);
                      } catch (error) {
                        addToast(
                          error.message ||
                            "Failed to toggle production shift. Please try again.",
                          "error",
                        );
                      }
                    }}
                  >
                    {shift.active === false ? "Activate" : "Deactivate"}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
        {!filteredShifts.length && (
          <li className="muted">No shifts defined.</li>
        )}
      </ul>
    </div>
  );
};

export default ShiftsSection;
