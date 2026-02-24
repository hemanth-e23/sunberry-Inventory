import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import "./BOLPage.css";

const API_BASE_URL = "/api";

const BOLPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const getAuthHeaders = async () => {
    const token = localStorage.getItem("token");
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  };

  const fetchBOL = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams();
      if (startDate) params.append("production_date_start", startDate);
      if (endDate) params.append("production_date_end", endDate);
      const url = `${API_BASE_URL}/inventory/bol-report${params.toString() ? `?${params}` : ""}`;
      const response = await axios.get(url, { headers });
      setRows(response.data?.rows || []);
    } catch (err) {
      setError(err.response?.data?.detail || err.message || "Failed to load BOL report");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    fetchBOL();
  }, [fetchBOL]);

  const formatNumber = (value, fractionDigits = 1) =>
    value != null
      ? Number(value).toLocaleString(undefined, {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        })
      : "—";

  const getStatusBadge = (status) => {
    const classes = {
      ok: "status-ok",
      under: "status-under",
      over: "status-over",
      no_data: "status-no-data",
    };
    const labels = {
      ok: "OK",
      under: "Under",
      over: "Over",
      no_data: "No Data",
    };
    return (
      <span className={`bol-status-badge ${classes[status] || ""}`}>
        {labels[status] || status}
      </span>
    );
  };

  return (
    <div className="bol-page">
      <div className="page-header">
        <button
          type="button"
          onClick={() => navigate(getDashboardPath(user?.role))}
          className="back-button"
        >
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h1>BOL Report</h1>
          <p>
            Batch Output vs Logged — compare actual batch size (from Production lab test) to
            finished goods logged in Inventory. Within ±3% is OK.
          </p>
        </div>
      </div>

      <section className="bol-filters">
        <div className="filter-group">
          <label>
            <span>Start Date</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label>
            <span>End Date</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
          <button type="button" onClick={fetchBOL} className="refresh-btn" disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </section>

      {error && (
        <div className="bol-error">
          {error}
        </div>
      )}

      <section className="bol-table-section">
        <div className="table-wrapper">
          <table className="bol-table">
            <thead>
              <tr>
                <th>Production Date</th>
                <th>Product (Flavor)</th>
                <th>Actual Batch Size (gal)</th>
                <th>Batches</th>
                <th>Gal/Case</th>
                <th>Expected Cases</th>
                <th>Logged Cases</th>
                <th>Variance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="empty-state">
                    No BOL data for the selected date range. Ensure Production batches are
                    Complete and Inventory has finished goods receipts with matching production
                    dates.
                  </td>
                </tr>
              )}
              {rows.map((row, idx) => (
                <tr key={idx}>
                  <td>{row.production_date || "—"}</td>
                  <td>{row.product_name || "—"}</td>
                  <td>{formatNumber(row.total_actual_batch_size_gal, 2)}</td>
                  <td>{row.batch_count ?? "—"}</td>
                  <td>{formatNumber(row.gal_per_case, 1)}</td>
                  <td>{formatNumber(row.expected_cases, 1)}</td>
                  <td>{formatNumber(row.logged_cases, 1)}</td>
                  <td>
                    {row.variance_pct != null
                      ? `${row.variance_pct >= 0 ? "+" : ""}${formatNumber(row.variance_pct, 2)}%`
                      : "—"}
                  </td>
                  <td>{getStatusBadge(row.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default BOLPage;
