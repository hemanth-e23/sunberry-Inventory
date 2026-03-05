import React, { useMemo, useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";

const VendorsSection = () => {
  const {
    vendors,
    addVendor,
    updateVendor,
    toggleVendorActive,
  } = useAppData();
  const { addToast } = useToast();

  const [showInactiveVendors, setShowInactiveVendors] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [editingVendor, setEditingVendor] = useState(null);
  const [vendorDraft, setVendorDraft] = useState("");

  const filteredVendors = useMemo(
    () => vendors.filter((vendor) => showInactiveVendors || vendor.active !== false),
    [vendors, showInactiveVendors],
  );

  const handleAddVendor = async (event) => {
    event.preventDefault();
    if (!newVendorName.trim()) return;
    try {
      const created = await addVendor(newVendorName);
      if (created) {
        setNewVendorName("");
      }
    } catch (error) {
      console.error("Error adding vendor:", error);
      const errorMessage =
        error.response?.data?.detail ||
        error.message ||
        "Failed to add vendor. Please try again.";
      addToast(errorMessage, "error");
    }
  };

  const handleSaveVendor = async (id) => {
    const name = vendorDraft.trim();
    if (!name) return;
    try {
      await updateVendor(id, name);
      setEditingVendor(null);
      setVendorDraft("");
    } catch (error) {
      console.error("Error updating vendor:", error);
      addToast("Failed to update vendor. Please try again.", "error");
    }
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Vendors</h2>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showInactiveVendors}
            onChange={(event) => setShowInactiveVendors(event.target.checked)}
          />
          <span>Show inactive</span>
        </label>
      </div>
      <form onSubmit={handleAddVendor} className="inline-form">
        <input
          type="text"
          value={newVendorName}
          onChange={(e) => setNewVendorName(e.target.value)}
          placeholder="Add vendor"
          required
        />
        <button type="submit" className="primary-button">
          Add
        </button>
      </form>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Status</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredVendors.map((vendor) =>
              editingVendor === vendor.id ? (
                <tr key={vendor.id} className="editing">
                  <td>
                    <input
                      value={vendorDraft}
                      onChange={(e) => setVendorDraft(e.target.value)}
                      autoFocus
                    />
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        vendor.active === false ? "chip-hold" : "chip-clear"
                      }`}
                    >
                      {vendor.active === false ? "Inactive" : "Active"}
                    </span>
                  </td>
                  <td className="actions-col">
                    <button
                      className="primary-button"
                      onClick={() => handleSaveVendor(vendor.id)}
                    >
                      Save
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => setEditingVendor(null)}
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={vendor.id}>
                  <td>{vendor.name}</td>
                  <td>
                    <span
                      className={`chip ${
                        vendor.active === false ? "chip-hold" : "chip-clear"
                      }`}
                    >
                      {vendor.active === false ? "Inactive" : "Active"}
                    </span>
                  </td>
                  <td className="actions-col">
                    <div className="node-actions">
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setEditingVendor(vendor.id);
                          setVendorDraft(vendor.name);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="secondary-button"
                        onClick={async () => {
                          try {
                            await toggleVendorActive(vendor.id);
                          } catch (error) {
                            console.error("Error toggling vendor:", error);
                            addToast(
                              "Failed to update vendor. Please try again.",
                              "error",
                            );
                          }
                        }}
                      >
                        {vendor.active === false ? "Activate" : "Deactivate"}
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
            {!filteredVendors.length && (
              <tr>
                <td colSpan={3} className="empty">
                  No vendors defined.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default VendorsSection;
