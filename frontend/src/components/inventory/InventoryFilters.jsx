import React, { useState } from "react";

const InventoryFilters = ({
  // Filter values (lifted state from parent)
  smartSearchTerm,
  setSmartSearchTerm,
  searchFields,
  setSearchFields,
  productFilter,
  setProductFilter,
  holdFilter,
  setHoldFilter,
  expiryStartDate,
  setExpiryStartDate,
  expiryEndDate,
  setExpiryEndDate,
  quantityThreshold,
  setQuantityThreshold,
  quantityOperator,
  setQuantityOperator,
  ageFilter,
  setAgeFilter,
  sortOption,
  setSortOption,
  inventoryStartDate,
  setInventoryStartDate,
  inventoryEndDate,
  setInventoryEndDate,
  showZeroInventory,
  setShowZeroInventory,
  // Options data
  productOptions,
}) => {
  const [showFilters, setShowFilters] = useState(false);

  return (
    <div className="collapsible-section">
      <div
        className="collapsible-header"
        onClick={() => setShowFilters(!showFilters)}
      >
        <h3>Filters</h3>
        <span className="chevron">{showFilters ? '▼' : '▶'}</span>
      </div>
      {showFilters && (
        <div className="collapsible-content">
          <div className="advanced-filters">
            <div className="filter-section">
              <h3>Basic Filters</h3>
              <div className="filters">
                <label>
                  <span>Smart Search</span>
                  <input
                    type="text"
                    value={smartSearchTerm}
                    onChange={(event) => setSmartSearchTerm(event.target.value)}
                    placeholder="Search by name, SID, FCC code, or lot number"
                  />
                </label>
                <label>
                  <span>Search Fields</span>
                  <div className="checkbox-group">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={searchFields.includes("name")}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSearchFields([...searchFields, "name"]);
                          } else {
                            setSearchFields(searchFields.filter(f => f !== "name"));
                          }
                        }}
                      />
                      <span>Product Name</span>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={searchFields.includes("sid")}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSearchFields([...searchFields, "sid"]);
                          } else {
                            setSearchFields(searchFields.filter(f => f !== "sid"));
                          }
                        }}
                      />
                      <span>SID</span>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={searchFields.includes("fcc")}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSearchFields([...searchFields, "fcc"]);
                          } else {
                            setSearchFields(searchFields.filter(f => f !== "fcc"));
                          }
                        }}
                      />
                      <span>FCC Code</span>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={searchFields.includes("lot")}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSearchFields([...searchFields, "lot"]);
                          } else {
                            setSearchFields(searchFields.filter(f => f !== "lot"));
                          }
                        }}
                      />
                      <span>Lot Number</span>
                    </label>
                  </div>
                </label>
                <label>
                  <span>Product</span>
                  <select
                    value={productFilter}
                    onChange={(event) => setProductFilter(event.target.value)}
                  >
                    <option value="all">All Products</option>
                    {productOptions.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Hold Filter</span>
                  <select
                    value={holdFilter}
                    onChange={(event) => setHoldFilter(event.target.value)}
                  >
                    <option value="all">Show All</option>
                    <option value="hold">Hold Only</option>
                    <option value="clear">Exclude Holds</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="filter-section">
              <h3>Advanced Filters</h3>
              <div className="filters">
                <label>
                  <span>Expiry Date Range</span>
                  <div className="date-range">
                    <input
                      type="date"
                      value={expiryStartDate}
                      onChange={(event) => setExpiryStartDate(event.target.value)}
                      placeholder="From"
                    />
                    <input
                      type="date"
                      value={expiryEndDate}
                      onChange={(event) => setExpiryEndDate(event.target.value)}
                      placeholder="To"
                    />
                  </div>
                </label>
                <label>
                  <span>Quantity Filter</span>
                  <div className="quantity-filter">
                    <select
                      value={quantityOperator}
                      onChange={(event) => setQuantityOperator(event.target.value)}
                    >
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                      <option value="equal">Equal to</option>
                    </select>
                    <input
                      type="number"
                      value={quantityThreshold}
                      onChange={(event) => setQuantityThreshold(event.target.value)}
                      placeholder="Enter quantity"
                    />
                  </div>
                </label>
                <label>
                  <span>Age Filter</span>
                  <select
                    value={ageFilter}
                    onChange={(event) => setAgeFilter(event.target.value)}
                  >
                    <option value="all">All Ages</option>
                    <option value="7days">Last 7 days</option>
                    <option value="30days">Last 30 days</option>
                    <option value="90days">Last 90 days</option>
                    <option value="older">Older than 90 days</option>
                    <option value="none">No activity ever</option>
                  </select>
                </label>
                <label>
                  <span>Sort</span>
                  <select
                    value={sortOption}
                    onChange={(event) => setSortOption(event.target.value)}
                  >
                    <option value="recent">Recent First</option>
                    <option value="oldest">Oldest First</option>
                    <option value="hold-first">Hold Status (Hold → Clear)</option>
                    <option value="clear-first">Hold Status (Clear → Hold)</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="filter-section">
              <h3>Display Options</h3>
              <div className="filters">
                <label>
                  <span>Date Range</span>
                  <div className="date-range">
                    <input
                      type="date"
                      value={inventoryStartDate}
                      onChange={(event) => setInventoryStartDate(event.target.value)}
                      placeholder="From"
                    />
                    <input
                      type="date"
                      value={inventoryEndDate}
                      onChange={(event) => setInventoryEndDate(event.target.value)}
                      placeholder="To"
                    />
                  </div>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={showZeroInventory}
                    onChange={(event) => setShowZeroInventory(event.target.checked)}
                  />
                  <span>Include products not in hand</span>
                </label>
                <div className="filter-actions">
                  <button
                    onClick={() => {
                      setExpiryStartDate("");
                      setExpiryEndDate("");
                      setQuantityThreshold("");
                      setQuantityOperator("above");
                      setAgeFilter("all");
                      setSmartSearchTerm("");
                      setSearchFields(["name", "sid", "fcc", "lot"]);
                    }}
                    className="clear-filters-btn"
                  >
                    Clear All Filters
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventoryFilters;
