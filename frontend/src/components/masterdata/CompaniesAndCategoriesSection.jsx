import React, { useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";
import { CATEGORY_TYPES } from '../../constants';

const TYPE_OPTIONS = [
  { value: "raw",       label: "Ingredients" },
  { value: "finished",  label: "Finished Goods" },
  { value: "packaging", label: "Packaging" },
];
const TYPE_LABEL = { raw: "Ingredients", finished: "Finished Goods", packaging: "Packaging" };

// ── Add Company form ──────────────────────────────────────────────────────────
function AddCompanyForm({ onAdd }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!id.trim() || !name.trim()) return;
    setSaving(true);
    try {
      await onAdd(id.trim().toLowerCase().replace(/\s+/g, "-"), name.trim());
      setId("");
      setName("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="inline-form" style={{ marginBottom: 20 }}>
      <label>
        <span>ID <span style={{ fontSize: 11, color: "#9ca3af" }}>(slug, e.g. client-x)</span></span>
        <input
          value={id}
          onChange={e => setId(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          placeholder="e.g. client-x"
          required
        />
      </label>
      <label>
        <span>Company Name</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Client X"
          required
        />
      </label>
      <button type="submit" className="primary-button" disabled={saving}>
        {saving ? "Adding…" : "+ Add Company"}
      </button>
    </form>
  );
}

// ── Add Category form (inline under a company) ────────────────────────────────
function AddCategoryForm({ companyId, onAdd }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("raw");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onAdd(name.trim(), type, companyId);
      setName("");
      setType("raw");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="inline-form" style={{ marginTop: 8, paddingLeft: 20 }}>
      <label>
        <span>Category Name</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Ingredients"
          required
        />
      </label>
      <label>
        <span>Type</span>
        <select value={type} onChange={e => setType(e.target.value)}>
          {TYPE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary-button" disabled={saving} style={{ alignSelf: "flex-end" }}>
        {saving ? "Adding…" : "+ Add Category"}
      </button>
    </form>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────
const CompaniesAndCategoriesSection = () => {
  const {
    categoryGroupsMapped,
    categories,
    addCategoryGroup,
    updateCategoryGroup,
    addCategory,
    updateCategory,
    toggleCategoryActive,
  } = useAppData();
  const { addToast } = useToast();

  const [editingGroup, setEditingGroup] = useState(null);   // group id being renamed
  const [groupDraft, setGroupDraft] = useState("");
  const [editingCat, setEditingCat] = useState(null);       // cat id being edited
  const [catDraft, setCatDraft] = useState({ name: "", type: "raw" });
  const [expandedGroups, setExpandedGroups] = useState({});  // id → bool
  const [showAddCat, setShowAddCat] = useState(null);        // group id

  const activeGroups = categoryGroupsMapped.filter(g => g.active !== false);
  const allGroups    = categoryGroupsMapped;

  const categoriesForGroup = (groupId) =>
    categories.filter(c => c.type !== "group" && c.parentId === groupId);

  const handleAddCompany = async (id, name) => {
    try {
      await addCategoryGroup(id, name);
      addToast(`Company "${name}" added.`, "success");
      setExpandedGroups(prev => ({ ...prev, [id]: true }));
    } catch (err) {
      addToast(err.response?.data?.detail || "Failed to add company.", "error");
    }
  };

  const handleRenameGroup = async (id) => {
    if (!groupDraft.trim()) return;
    try {
      await updateCategoryGroup(id, { name: groupDraft.trim() });
      addToast("Company renamed.", "success");
    } catch (err) {
      addToast(err.response?.data?.detail || "Failed to rename company.", "error");
    }
    setEditingGroup(null);
  };

  const handleToggleGroup = async (group) => {
    try {
      await updateCategoryGroup(group.id, { is_active: !group.active });
      addToast(`Company ${group.active ? "deactivated" : "activated"}.`, "success");
    } catch (err) {
      addToast(err.response?.data?.detail || "Failed to update company.", "error");
    }
  };

  const handleAddCategory = async (name, type, parentId) => {
    try {
      await addCategory(name, type, null, parentId);
      addToast(`Category "${name}" added.`, "success");
    } catch (err) {
      addToast(err.response?.data?.detail || "Failed to add category.", "error");
    }
    setShowAddCat(null);
  };

  const handleSaveCategory = async (id) => {
    if (!catDraft.name.trim()) return;
    try {
      await updateCategory(id, { name: catDraft.name.trim(), type: catDraft.type });
      addToast("Category updated.", "success");
    } catch (err) {
      addToast(err.response?.data?.detail || "Failed to update category.", "error");
    }
    setEditingCat(null);
  };

  const handleToggleCategory = async (cat) => {
    try {
      await toggleCategoryActive(cat.id);
    } catch (err) {
      addToast("Failed to update category.", "error");
    }
  };

  return (
    <section className="panel" style={{ gridColumn: "1 / -1" }}>
      <div className="panel-header">
        <h2>Companies &amp; Categories</h2>
        <span className="muted">Superadmin only — define which companies and product categories exist</span>
      </div>

      <AddCompanyForm onAdd={handleAddCompany} />

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {allGroups.length === 0 && (
          <p className="muted">No companies yet. Add one above.</p>
        )}

        {allGroups.map(group => {
          const cats = categoriesForGroup(group.id);
          const isExpanded = expandedGroups[group.id] !== false; // default expanded

          return (
            <div
              key={group.id}
              style={{
                border: "1px solid #e5e7eb", borderRadius: 8,
                overflow: "hidden",
                opacity: group.active === false ? 0.6 : 1,
              }}
            >
              {/* Company header row */}
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", background: "#f8fafc",
                borderBottom: isExpanded ? "1px solid #e5e7eb" : "none",
              }}>
                <button
                  onClick={() => setExpandedGroups(prev => ({ ...prev, [group.id]: !isExpanded }))}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#6b7280", padding: "0 4px" }}
                >
                  {isExpanded ? "▼" : "▶"}
                </button>

                {editingGroup === group.id ? (
                  <>
                    <input
                      autoFocus
                      value={groupDraft}
                      onChange={e => setGroupDraft(e.target.value)}
                      style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #d1d5db", fontSize: 14, flex: 1, maxWidth: 220 }}
                      onKeyDown={e => { if (e.key === "Enter") handleRenameGroup(group.id); if (e.key === "Escape") setEditingGroup(null); }}
                    />
                    <button className="primary-button" style={{ padding: "4px 12px" }} onClick={() => handleRenameGroup(group.id)}>Save</button>
                    <button className="secondary-button" style={{ padding: "4px 12px" }} onClick={() => setEditingGroup(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>
                      {group.name}
                      <code style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>{group.id}</code>
                    </span>
                    {group.active === false && (
                      <span className="chip chip-hold" style={{ fontSize: 11 }}>Inactive</span>
                    )}
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>{cats.length} categories</span>
                    <button
                      className="secondary-button"
                      style={{ padding: "3px 10px", fontSize: 12 }}
                      onClick={() => { setEditingGroup(group.id); setGroupDraft(group.name); }}
                    >Rename</button>
                    <button
                      className="secondary-button"
                      style={{ padding: "3px 10px", fontSize: 12 }}
                      onClick={() => handleToggleGroup(group)}
                    >{group.active === false ? "Activate" : "Deactivate"}</button>
                  </>
                )}
              </div>

              {/* Categories list */}
              {isExpanded && (
                <div style={{ padding: "8px 14px 12px" }}>
                  {cats.length === 0 && (
                    <p style={{ color: "#9ca3af", fontSize: 13, margin: "8px 0" }}>No categories yet.</p>
                  )}

                  {cats.map(cat => (
                    <div key={cat.id} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "6px 0", borderBottom: "1px solid #f3f4f6",
                      opacity: cat.active === false ? 0.55 : 1,
                    }}>
                      <span style={{ width: 16, color: "#d1d5db", flexShrink: 0 }}>└</span>

                      {editingCat === cat.id ? (
                        <>
                          <input
                            autoFocus
                            value={catDraft.name}
                            onChange={e => setCatDraft(d => ({ ...d, name: e.target.value }))}
                            style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #d1d5db", fontSize: 13, width: 160 }}
                            onKeyDown={e => { if (e.key === "Escape") setEditingCat(null); }}
                          />
                          <select
                            value={catDraft.type}
                            onChange={e => setCatDraft(d => ({ ...d, type: e.target.value }))}
                            style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #d1d5db", fontSize: 13 }}
                          >
                            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <button className="primary-button" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => handleSaveCategory(cat.id)}>Save</button>
                          <button className="secondary-button" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setEditingCat(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1, fontSize: 14 }}>{cat.name}</span>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
                            background: cat.type === CATEGORY_TYPES.FINISHED ? "#fff7ed" : cat.type === CATEGORY_TYPES.PACKAGING ? "#f0fdf4" : "#eff6ff",
                            color: cat.type === CATEGORY_TYPES.FINISHED ? "#c2410c" : cat.type === CATEGORY_TYPES.PACKAGING ? "#15803d" : "#1d4ed8",
                            border: `1px solid ${cat.type === CATEGORY_TYPES.FINISHED ? "#fed7aa" : cat.type === CATEGORY_TYPES.PACKAGING ? "#bbf7d0" : "#bfdbfe"}`,
                          }}>
                            {TYPE_LABEL[cat.type] || cat.type}
                          </span>
                          {cat.active === false && <span className="chip chip-hold" style={{ fontSize: 11 }}>Inactive</span>}
                          <button
                            className="secondary-button"
                            style={{ padding: "3px 10px", fontSize: 12 }}
                            onClick={() => { setEditingCat(cat.id); setCatDraft({ name: cat.name, type: cat.type }); }}
                          >Edit</button>
                          <button
                            className="secondary-button"
                            style={{ padding: "3px 10px", fontSize: 12 }}
                            onClick={() => handleToggleCategory(cat)}
                          >{cat.active === false ? "Activate" : "Deactivate"}</button>
                        </>
                      )}
                    </div>
                  ))}

                  {/* Add category to this company */}
                  {showAddCat === group.id ? (
                    <AddCategoryForm companyId={group.id} onAdd={handleAddCategory} />
                  ) : (
                    <button
                      className="secondary-button"
                      style={{ marginTop: 10, fontSize: 12, padding: "4px 12px" }}
                      onClick={() => setShowAddCat(group.id)}
                    >
                      + Add Category
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default CompaniesAndCategoriesSection;
