import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import "./Shared.css";
import "./MasterDataPage.css";

import CategoriesSection from "./masterdata/CategoriesSection";
import CompaniesAndCategoriesSection from "./masterdata/CompaniesAndCategoriesSection";
import VendorsSection from "./masterdata/VendorsSection";
import LocationsSection from "./masterdata/LocationsSection";
import FGStorageSection from "./masterdata/FGStorageSection";
import ShiftsSection from "./masterdata/ShiftsSection";
import LinesSection from "./masterdata/LinesSection";

const MasterDataPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperadmin = user?.role === "superadmin";
  const {
    categories,
    vendors,
    locationsTree,
    storageAreas,
    finishedGoodsRows,
    productionShifts,
    productionLines,
  } = useAppData();

  // Used to pass a pre-selected location from LocationsSection to FGStorageSection
  const [pendingFGAreaLocation, setPendingFGAreaLocation] = useState(null);

  const stats = useMemo(() => {
    const locationCount = locationsTree.filter(
      (loc) => loc.active !== false,
    ).length;
    const subLocationCount = locationsTree.reduce(
      (sum, loc) =>
        sum + loc.subLocations.filter((sub) => sub.active !== false).length,
      0,
    );
    return [
      {
        label: "Categories",
        value: categories.filter(
          (cat) => cat.active !== false && cat.type !== "group",
        ).length,
      },
      {
        label: "Vendors",
        value: vendors.filter((vendor) => vendor.active !== false).length,
      },
      { label: "Locations", value: locationCount },
      { label: "Sub Locations", value: subLocationCount },
      {
        label: "FG Areas",
        value: storageAreas.filter((area) => area.active !== false).length,
      },
      {
        label: "FG Rows",
        value: finishedGoodsRows.filter((row) => row.active !== false).length,
      },
      { label: "Production Shifts", value: productionShifts.length },
      { label: "Production Lines", value: productionLines.length },
    ];
  }, [
    categories,
    vendors,
    locationsTree,
    storageAreas,
    finishedGoodsRows,
    productionShifts,
    productionLines,
  ]);

  return (
    <div className="master-data-page">
      <div className="page-header">
        <button
          onClick={() => navigate(getDashboardPath(user?.role))}
          className="back-button"
        >
          &larr; Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <section className="panel stats-panel">
          <div className="stats-grid">
            {stats.map((stat) => (
              <div key={stat.label} className="stat-card">
                <span className="label">{stat.label}</span>
                <span className="value">{stat.value}</span>
              </div>
            ))}
          </div>
        </section>

        {isSuperadmin && (
          <div className="data-grid" style={{ gridTemplateColumns: "1fr" }}>
            <CompaniesAndCategoriesSection />
          </div>
        )}

        <div className="data-grid">
          <CategoriesSection />
          <VendorsSection />
        </div>

        <section className="panel">
          <div className="locations-layout">
            <LocationsSection onAssignFGArea={setPendingFGAreaLocation} />
            <FGStorageSection
              initialAreaLocation={pendingFGAreaLocation}
              onAreaLocationConsumed={() => setPendingFGAreaLocation(null)}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Production Shifts &amp; Lines</h2>
            <span className="muted">
              Configure options for the receipt form dropdowns
            </span>
          </div>
          <div className="dual-forms">
            <ShiftsSection />
            <LinesSection />
          </div>
        </section>
      </div>
    </div>
  );
};

export default MasterDataPage;
