/**
 * Warehouse feature flags based on warehouse type.
 *
 * owned   – Full-featured plant (Plant A). All features enabled.
 * partner – External partner plant. No staging, production integration, or forklift.
 * null    – Corporate / superadmin user. Can see everything across all warehouses.
 */

const FEATURES = {
  owned: {
    staging: true,
    productionRequests: true,
    forklift: true,
  },
  partner: {
    staging: false,
    productionRequests: false,
    forklift: false,
  },
};

/**
 * Returns true if the given feature is available for the warehouse type.
 * Corporate users (warehouseType = null) always return true.
 *
 * @param {string|null} warehouseType  - 'owned', 'partner', or null
 * @param {string}      feature        - key from FEATURES object
 */
export const hasFeature = (warehouseType, feature) => {
  if (!warehouseType) return true; // corporate / superadmin sees everything
  return FEATURES[warehouseType]?.[feature] ?? true;
};
