import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import { isDateInPast, isDateValid, getTodayDateKey } from "../utils/dateUtils";
import { validateLotNumber } from "../utils/sanitizeUtils";
import SearchableSelect from "./SearchableSelect";
import ReceiptConfirmModal from "./receipt/ReceiptConfirmModal";
import "./Shared.css";
import "./ReceiptPage.css";
import { CATEGORY_TYPES } from '../constants';

const defaultFormState = {
  categoryGroupId: "",
  categoryId: "",
  productId: "",
  receiptDate: getTodayDateKey(),
  lotNo: "",
  expiration: "",
  quantity: "",
  quantityUnits: "",
  weightPerUnit: "",
  weightUnits: "",
  weight: "",
  brix: "",
  bol: "",
  purchaseOrder: "",
  location: "",
  subLocation: "",
  storageRowId: "",
  vendorId: "",
  sid: "",
  fccCode: "",
  productionDate: "",
  shift: "",
  lineNumber: "",
  hold: false,
  casesPerPallet: "",
  fullPallets: "",
  hasPartialPallet: false,
  partialCases: "0",
  quantityTouched: false,
  note: "",
  expirationTouched: false,
  expireYears: null,
  pallets: "", // For raw materials and packaging - pallet count for row occupancy
};

// Container-type units only (how many, not how much weight)
const unitOptions = [
  { value: "barrels", label: "Barrels" },
  { value: "bags", label: "Bags" },
  { value: "drums", label: "Drums" },
  { value: "totes", label: "Totes" },
  { value: "pails", label: "Pails" },
  { value: "bottles", label: "Bottles" },
  { value: "cases", label: "Cases" },
  { value: "pallets", label: "Pallets" },
  { value: "gallons", label: "Gallons" },
  { value: "liters", label: "Liters" },
  { value: "unit", label: "Unit" },
  { value: "units", label: "Units" },
];


const weightUnitOptions = [
  { value: "kg", label: "Kilograms" },
  { value: "lbs", label: "Pounds" },
  { value: "g", label: "Grams" },
  { value: "oz", label: "Ounces" },
  { value: "mt", label: "Metric Tons" },
];

const requiredStar = <span className="required">*</span>;

const getProductLabel = (product) => {
  if (!product) return "";
  const code = product.fcc || product.sid || "";
  return code ? `${product.name} (${code})` : product.name;
};

const buildLicenceNote = (receipt, products = []) => {
  const lot = receipt?.lotNo || receipt?.lot_number;
  const prodId = receipt?.productId || receipt?.product_id;
  if (!receipt?.allocation?.plan?.length || !lot || !prodId) return null;
  const plan = receipt.allocation.plan;
  const totalPallets = plan.reduce((s, i) => s + (parseInt(i.pallets, 10) || 0), 0);
  if (totalPallets < 1) return null;
  const product = products.find((p) => p.id === prodId) || {};
  const productCode = (product.fcc || product.name || "PRD").slice(0, 10).replace(/\s/g, "").toUpperCase();
  const lastSeq = String(totalPallets).padStart(3, "0");
  return `${totalPallets} pallet licence numbers generated (e.g. ${lot}-${productCode}-001 through ${productCode}-${lastSeq})`;
};

// Helper function to calculate day of year (1-365/366)
const getDayOfYear = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
};

const ReceiptPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    categoryGroups,
    productCategories,
    products,
    receipts,
    submitReceipt,
    vendors,
    locations,
    subLocationMap,
    productionShifts,
    productionLines,
    storageAreas,
  } = useAppData();

  const categoryOptions = productCategories;

  const [formData, setFormData] = useState(defaultFormState);
  const [feedback, setFeedback] = useState(null);
  const [_allocationPreview, setAllocationPreview] = useState(null);
  const [autoQuantity, setAutoQuantity] = useState(null);
  const [manualAllocations, setManualAllocations] = useState([]);
  const [floorPallets, setFloorPallets] = useState("0");
  const [confirmation, setConfirmation] = useState({ open: false, payload: null, summary: null });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lotNumberManuallyEdited, setLotNumberManuallyEdited] = useState(false);
  const formRef = useRef(null);
  
  // Helper function to extract line number from line name (e.g., "Line 1" -> "1", "L1" -> "1")
  const extractLineNumber = useCallback((lineId) => {
    if (!lineId) return null;
    const line = productionLines.find(l => l.id === lineId);
    if (!line) return null;

    // Try to extract number from name (e.g., "Line 1", "L1", "1", "Line Number 1")
    const match = line.name.match(/\d+/);
    return match ? match[0] : null;
  }, [productionLines]);

  // Generate lot number: MP[day_of_year][year]L[line_number]
  const generateLotNumber = useCallback((productionDate, lineNumber) => {
    if (!productionDate || !lineNumber) return "";

    const dayOfYear = getDayOfYear(productionDate);
    if (!dayOfYear) return "";

    const lineNum = extractLineNumber(lineNumber);
    if (!lineNum) return "";

    const date = new Date(productionDate);
    const year = date.getFullYear().toString().slice(-2); // Last 2 digits of year

    // Format: MP + 3-digit day of year + 2-digit year + L + line number
    return `MP${String(dayOfYear).padStart(3, '0')}${year}L${lineNum}`;
  }, [extractLineNumber]);

  // State for raw materials/packaging multi-row allocation
  const [rawMaterialRowAllocations, setRawMaterialRowAllocations] = useState([]);

  // Compute total weight for raw materials: quantity * weightPerUnit
  const totalWeight = useMemo(() => {
    const qty = parseFloat(formData.quantity || 0);
    const perUnit = parseFloat(formData.weightPerUnit || 0);
    const total = qty * perUnit;
    return Number.isFinite(total) ? total : 0;
  }, [formData.quantity, formData.weightPerUnit]);

  useEffect(() => {
    const next = totalWeight > 0 ? String(totalWeight) : "";
    setFormData((prev) => prev.weight === next ? prev : { ...prev, weight: next });
  }, [totalWeight]);

  const selectedCategory = useMemo(
    () => categoryOptions.find((cat) => cat.id === formData.categoryId),
    [categoryOptions, formData.categoryId],
  );

  const productLabel = useMemo(() => {
    if (!selectedCategory) return "Product";
    if (selectedCategory.type === CATEGORY_TYPES.FINISHED) return "Finished Good";
    if (selectedCategory.type === CATEGORY_TYPES.PACKAGING) return "Packaging Material";
    return "Raw Material";
  }, [selectedCategory]);

  const isFinishedGood = selectedCategory?.type === CATEGORY_TYPES.FINISHED;

  const addManualAllocation = () => {
    setManualAllocations((prev) => [
      ...prev,
      {
        id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        areaId: "",
        rowId: "",
        fullPallets: "",
        pallets: "",
        cases: 0,
      },
    ]);
  };

  const updateManualAllocation = (allocationId, updates) => {
    setManualAllocations((prev) =>
      prev.map((entry) => {
        if (entry.id !== allocationId) return entry;
        const nextFull = updates.fullPallets ?? entry.fullPallets;
        const nextPallets = updates.pallets ?? entry.pallets;
        const palletsValue = Number(nextPallets);
        const casesPer = Number(formData.casesPerPallet);
        // Recompute pallets from full pallets only
        const fullVal = Number(nextFull);
        const derivedPallets = Number.isFinite(fullVal) ? Math.max(0, fullVal) : palletsValue;
        const finalPallets = Object.prototype.hasOwnProperty.call(updates, 'pallets') ? palletsValue : derivedPallets;
        const casesValue = Number.isFinite(finalPallets) && Number.isFinite(casesPer)
          ? finalPallets * casesPer
          : entry.cases;
        return {
          ...entry,
          ...updates,
          pallets: finalPallets,
          cases: casesValue,
        };
      }),
    );
  };

  const removeManualAllocation = (allocationId) => {
    setManualAllocations((prev) => prev.filter((entry) => entry.id !== allocationId));
  };

  const formatNumber = (num) => {
    if (!Number.isFinite(num)) return "-";
    return Number(num).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  };

  const formatInputValue = (value, decimals = 4) => {
    if (!Number.isFinite(value)) return "";
    const fixed = value.toFixed(decimals);
    const trimmed = fixed.replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
    return trimmed === "" ? "0" : trimmed;
  };

  const activeStorageAreas = useMemo(
    () => storageAreas.filter((area) => area.active),
    [storageAreas],
  );

  // Warehouse list for filtering FG placements: only main locations that have FG areas
  const fgLocationsWithAreas = useMemo(() => {
    const ids = new Set();
    activeStorageAreas.forEach((area) => {
      if (area.locationId) ids.add(area.locationId);
    });
    return locations.filter((loc) => ids.has(loc.id));
  }, [activeStorageAreas, locations]);

  const [fgWarehouseFilter, setFgWarehouseFilter] = useState("");

  const storageAreaLookup = useMemo(() => {
    const map = new Map();
    activeStorageAreas.forEach((area) => {
      map.set(area.id, area);
    });
    return map;
  }, [activeStorageAreas]);

  const totalCasesExpected = useMemo(() => {
    if (!isFinishedGood) return null;
    const casesPerPalletValue = Number(formData.casesPerPallet);
    const fullPalletsValue = Number(formData.fullPallets);
    const partialCasesValue = Number(formData.partialCases);
    if (!Number.isFinite(casesPerPalletValue) || casesPerPalletValue <= 0) return null;
    if (!Number.isFinite(fullPalletsValue)) return null;
    const totalCasesFromFull = fullPalletsValue * casesPerPalletValue;
    const partial = Number.isFinite(partialCasesValue) ? partialCasesValue : 0;
    return totalCasesFromFull + partial;
  }, [isFinishedGood, formData.casesPerPallet, formData.fullPallets, formData.partialCases]);

  // Expected pallets = full pallets + partial cases / cases-per-pallet
  const _expectedPallets = useMemo(() => {
    if (!isFinishedGood) return 0;
    const cpp = Number(formData.casesPerPallet);
    const full = Number(formData.fullPallets);
    const partial = Number(formData.partialCases);
    const safeFull = Number.isFinite(full) ? full : 0;
    if (!Number.isFinite(cpp) || cpp <= 0) return safeFull;
    const partialPallets = Number.isFinite(partial) ? partial / cpp : 0;
    return safeFull + partialPallets;
  }, [isFinishedGood, formData.casesPerPallet, formData.fullPallets, formData.partialCases]);

  const manualTotals = useMemo(() => {
    const casesPerPalletValue = Number(formData.casesPerPallet);
    let totalManualCases = 0;
    let totalPallets = 0;

    manualAllocations.forEach((entry) => {
      const palletsValue = Number(entry.pallets);
      if (!Number.isFinite(palletsValue)) return;
      const casesValue = Number.isFinite(casesPerPalletValue)
        ? palletsValue * casesPerPalletValue
        : 0;
      totalManualCases += casesValue;
      totalPallets += palletsValue;
    });

    const floorPalletValue = Number(floorPallets);
    const floorCases = Number.isFinite(casesPerPalletValue)
      ? floorPalletValue * casesPerPalletValue
      : 0;

    const remainingCases = Math.max(
      0,
      Number(totalCasesExpected || 0) - (totalManualCases + floorCases),
    );
    const autoFloorPallets =
      Number.isFinite(casesPerPalletValue) && casesPerPalletValue > 0
        ? remainingCases / casesPerPalletValue
        : 0;

    const effectiveFloorPallets =
      Math.max(floorPalletValue, autoFloorPallets) || autoFloorPallets;

    return {
      totalManualCases,
      totalPallets,
      rackCases: totalManualCases,
      rackPallets: totalPallets,
      floorCases,
      floorPallets: effectiveFloorPallets,
      remainingFloorPallets: autoFloorPallets,
    };
  }, [manualAllocations, floorPallets, formData.casesPerPallet, totalCasesExpected]);

  const casesMismatch = useMemo(() => {
    if (!isFinishedGood) return false;
    if (!totalCasesExpected) return false;
    const actual = manualTotals.totalManualCases + manualTotals.floorCases;
    return Math.abs(totalCasesExpected - actual) > 0.5;
  }, [isFinishedGood, totalCasesExpected, manualTotals]);

  // Detect packaging and ingredients purely by category type
  const isPackaging = selectedCategory?.type === CATEGORY_TYPES.PACKAGING;

  const showPackagingFields = isPackaging;

  // Detect ingredients: type=raw (ingredients category)
  const isIngredient = selectedCategory?.type === "raw" && !isPackaging;

  const _showLocationField =
    selectedCategory?.type === CATEGORY_TYPES.FINISHED || isPackaging || isIngredient;
  const _showBrixField = isIngredient;

  // Determine if row selection is required (for raw materials and packaging)
  const requiresRowSelection = isIngredient || isPackaging;

  // Get available rows for selected sub-location (for raw materials and packaging)
  // Filter based on entered pallet count if provided
  const availableRows = useMemo(() => {
    if (!formData.subLocation || !formData.location) return [];
    
    // Try to find sub-location from nested locations structure first
    const location = locations.find(loc => loc.id === formData.location);
    const subLoc = location?.subLocations?.find(sub => sub.id === formData.subLocation);
    
    // If not found in nested structure, try subLocationMap (flat structure)
    const subLocFromMap = subLocationMap[formData.location]?.find(sub => sub.id === formData.subLocation);
    const finalSubLoc = subLoc || subLocFromMap;
    
    if (!finalSubLoc) {
      console.warn('Sub-location not found:', formData.subLocation, 'in location:', formData.location);
      return [];
    }
    
    // Get rows from sub-location - check both direct property and ensure it's an array
    const rows = Array.isArray(finalSubLoc.rows) ? finalSubLoc.rows : [];
    
    if (rows.length === 0) {
      return [];
    }

    const totalPalletsNeeded = Number(formData.pallets) || 0;
    
    return rows
      .filter(row => row && row.active !== false)
      .map(row => {
        const capacity = row.palletCapacity || 0;
        const occupied = row.occupiedPallets || 0;
        // This is the TRUE available from database (capacity - already occupied)
        const available = capacity > 0 ? Math.max(0, capacity - occupied) : null;
        
        // Determine if row can fit the needed pallets (use TRUE database available)
        let canFit = true;
        let fitStatus = '';
        if (totalPalletsNeeded > 0 && available !== null) {
          if (available >= totalPalletsNeeded) {
            fitStatus = '✓ Can fit all';
            canFit = true;
          } else if (available > 0) {
            fitStatus = `Can fit ${available} of ${totalPalletsNeeded}`;
            canFit = true; // Can partially fit
          } else {
            fitStatus = 'No capacity';
            canFit = false;
          }
        }
        
        return {
          value: row.id,
          rowData: row,
          label: available !== null
            ? `${row.name} (${available} available of ${capacity})`
            : row.name,
          available: available, // TRUE database available, not reduced by current form allocations
          capacity: capacity,
          canFit: canFit,
          fitStatus: fitStatus,
        };
      })
      .filter(row => {
        // If pallet count is entered, filter out rows with no capacity (unless they have unlimited capacity)
        if (totalPalletsNeeded > 0 && row.available !== null && row.available === 0) {
          return false;
        }
        return true;
      });
  }, [formData.location, formData.subLocation, formData.pallets, locations, subLocationMap]);

  // Sub location with 0 rows = unlimited storage (no row selection needed)
  const isUnlimitedStorage = requiresRowSelection && formData.subLocation && availableRows.length === 0;

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target;
    const parsedValue = type === "checkbox" ? checked : value;

    // Track if lot number is manually edited
    if (name === "lotNo") {
      setLotNumberManuallyEdited(true);
    }
    
    // Reset manual edit flag when production date or line number changes
    // This allows regeneration when these fields change
    if (name === "productionDate" || name === "lineNumber") {
      setLotNumberManuallyEdited(false);
    }

    setFormData((prev) => {
      const next = {
        ...prev,
        [name]: parsedValue,
      };

      if (name === "expiration") {
        next.expirationTouched = true;
      }

      if (name === "quantity") {
        next.quantityTouched = true;
      }

      const quantityDriverFields = [
        "casesPerPallet",
        "fullPallets",
        "partialCases",
        "hasPartialPallet",
      ];

      if (quantityDriverFields.includes(name)) {
        next.quantityTouched = false;
        next.quantity = "";
      }

      if (name === "hasPartialPallet" && !checked) {
        next.partialCases = "0";
      }

      if (name === "hasPartialPallet" && checked && Number(next.partialCases) <= 0) {
        next.partialCases = "";
      }

      // Removed auto-start to avoid duplicate rows in dev Strict Mode

      return next;
    });

    if (name === "quantity") {
      setAutoQuantity(null);
    }
  };

  const handleCategoryGroupChange = (categoryGroupId) => {
    setFormData((prev) => ({
      ...prev,
      categoryGroupId,
      categoryId: "",
      productId: "",
    }));
    setLotNumberManuallyEdited(false);
  };

  const handleCategoryChange = (categoryId) => {
    setFormData((prev) => ({
      ...prev,
      categoryGroupId:
        productCategories.find((cat) => cat.id === categoryId)?.parentId || "",
      categoryId,
      productId: "",
    }));
    setLotNumberManuallyEdited(false);
  };

  const finishedGoodOptions = useMemo(() => {
    if (!formData.categoryId) return [];
    return products
      .filter((product) => product.categoryId === formData.categoryId && product.status === "active")
      .map((product) => ({ value: product.id, label: getProductLabel(product) }));
  }, [products, formData.categoryId]);

  const ingredientOptions = useMemo(
    () => {
      if (!formData.categoryId) return [];
      return products
        .filter((product) => {
          const category = productCategories.find((cat) => cat.id === product.categoryId);
          return category?.type === "raw"
            && product.categoryId === formData.categoryId
            && product.status === "active";
        })
        .map((product) => ({ value: product.id, label: getProductLabel(product) }));
    },
    [products, productCategories, formData.categoryId],
  );

  const packagingOptions = useMemo(
    () => {
      if (!formData.categoryId) return [];
      // For packaging, filter products by category matching selected category
      return products
        .filter((product) => {
          // Check if product belongs to the selected category
          return product.categoryId === formData.categoryId
            && (product.status === "active" || product.active !== false);
        })
        .map((product) => ({ value: product.id, label: getProductLabel(product) }));
    },
    [products, formData.categoryId],
  );

  const handleProductSelect = (productId) => {
    const product = products.find((item) => item.id === productId);
    setFormData((prev) => ({
      ...prev,
      productId,
      sid: product?.sid || "",
      fccCode: product?.fcc || "",
      casesPerPallet: product?.defaultCasesPerPallet ?? "",
      // Do not force a default unit for raw/packaging; use product default if provided
      quantityUnits: product?.quantityUom || prev.quantityUnits || "",
      expireYears: product?.expireYears ?? null,
      expirationTouched: false,
      expiration: prev.expirationTouched ? prev.expiration : "",
    }));
    setManualAllocations([]);
    setFloorPallets("0");
    setLotNumberManuallyEdited(false);
  };

  useEffect(() => {
    if (isFinishedGood) {
      const productionDate = formData.productionDate ? new Date(formData.productionDate) : null;
      const years = Number(formData.expireYears);
      if (
        productionDate &&
        Number.isFinite(years) &&
        years > 0 &&
        !formData.expirationTouched
      ) {
        const next = new Date(productionDate);
        next.setFullYear(next.getFullYear() + years);
        const iso = next.toISOString().slice(0, 10);
        if (iso !== formData.expiration) {
          setFormData((prev) => ({
            ...prev,
            expiration: iso,
          }));
        }
      }
    }
  }, [formData.productionDate, formData.expireYears, formData.expirationTouched, isFinishedGood, formData.expiration]);

  // Auto-generate lot number for finished goods based on production date and line number
  useEffect(() => {
    if (isFinishedGood && !lotNumberManuallyEdited && formData.productionDate && formData.lineNumber) {
      const generatedLotNo = generateLotNumber(formData.productionDate, formData.lineNumber);
      if (generatedLotNo) {
        setFormData((prev) => prev.lotNo === generatedLotNo ? prev : { ...prev, lotNo: generatedLotNo });
      }
    }
  }, [isFinishedGood, formData.productionDate, formData.lineNumber, lotNumberManuallyEdited, generateLotNumber]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return undefined;

    const handleWheel = (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "number") {
        event.preventDefault();
        target.blur();
      }
    };

    form.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      form.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Keep weight in sync for raw materials when quantity/weight-per-unit change
  useEffect(() => {
    if (!isIngredient) return;
    const qty = parseFloat(formData.quantity || 0);
    const perUnit = parseFloat(formData.weightPerUnit || 0);
    if (Number.isFinite(qty) && Number.isFinite(perUnit) && qty >= 0 && perUnit >= 0) {
      const total = qty * perUnit;
      setFormData((prev) => ({ ...prev, weight: total ? total.toFixed(2) : "" }));
    } else {
      setFormData((prev) => prev.weight ? { ...prev, weight: "" } : prev);
    }
  }, [formData.quantity, formData.weightPerUnit, isIngredient]);

  useEffect(() => {
    if (isFinishedGood) {
      setManualAllocations([]);
      setFloorPallets("0");
    }
  }, [isFinishedGood]);

  useEffect(() => {
    if (isFinishedGood) {
      const casesPerPalletValue = Number(formData.casesPerPallet);
      setManualAllocations((prev) =>
        prev.map((entry) => {
          const palletsValue = Number(entry.pallets);
          const casesValue = Number.isFinite(casesPerPalletValue)
            ? palletsValue * casesPerPalletValue
            : 0;
          return { ...entry, cases: Number.isFinite(casesValue) ? casesValue : 0 };
        }),
      );
    }
  }, [isFinishedGood, formData.casesPerPallet]);

  useEffect(() => {
    if (isFinishedGood) {
      const casesPerPalletValue = Number(formData.casesPerPallet);
      const fullPalletsValue = Number(formData.fullPallets);
      const partialCasesValue = Number(formData.partialCases);

      const hasAllValues =
        Number.isFinite(casesPerPalletValue) &&
        casesPerPalletValue > 0 &&
        Number.isFinite(fullPalletsValue) &&
        (!formData.hasPartialPallet || Number.isFinite(partialCasesValue));

      if (hasAllValues) {
        const totalCasesFromPallets = fullPalletsValue * casesPerPalletValue;
        const partialCaseAmount = formData.hasPartialPallet
          ? partialCasesValue
          : 0;
        const totalCases = totalCasesFromPallets + partialCaseAmount;
        if (Number.isFinite(totalCases) && totalCases >= 0) {
          const valueAsString = totalCases.toString();
          setAutoQuantity(valueAsString);
          setFormData((prev) => ({
            ...prev,
            quantity: prev.quantityTouched ? prev.quantity : valueAsString,
            quantityUnits: prev.quantityUnits || "cases",
          }));
        }
      } else {
        setAutoQuantity(null);
      }
    }
  }, [
    isFinishedGood,
    formData.casesPerPallet,
    formData.fullPallets,
    formData.partialCases,
    formData.hasPartialPallet,
    formData.quantityTouched,
  ]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formData.categoryId || !formData.productId) {
      setFeedback({
        type: "error",
        message: "Select category and product before submitting.",
      });
      return;
    }

    // Validate lot number (required for finished goods and raw material ingredients)
    const lotRequired = isFinishedGood || isIngredient;
    if (lotRequired && !(formData.lotNo && formData.lotNo.trim())) {
      setFeedback({
        type: "error",
        message: isIngredient
          ? "Lot number is required for raw material receipts."
          : "Lot number is required for finished goods.",
      });
      return;
    }
    if (formData.lotNo && formData.lotNo.trim()) {
      const existingLotNumbers = receipts.map(r => r.lotNo).filter(Boolean);
      const lotValidation = validateLotNumber(formData.lotNo, existingLotNumbers);
      if (!lotValidation.valid) {
        setFeedback({
          type: "error",
          message: lotValidation.error,
        });
        return;
      }
    }

    // Validate weight fields are filled for ingredients
    if (isIngredient) {
      if (!formData.weightPerUnit || parseFloat(formData.weightPerUnit) <= 0) {
        setFeedback({ type: "error", message: "Weight per container is required for raw material receipts." });
        return;
      }
      if (!formData.weightUnits) {
        setFeedback({ type: "error", message: "Weight unit is required for raw material receipts." });
        return;
      }
    }

    // Validate expiration date
    if (formData.expiration) {
      if (!isDateValid(formData.expiration)) {
        setFeedback({
          type: "error",
          message: "Please enter a valid expiration date.",
        });
        return;
      }
      if (isDateInPast(formData.expiration)) {
        setFeedback({
          type: "error",
          message: "Expiration date cannot be in the past.",
        });
        return;
      }
    }

    // Validate receipt date - receipt dates CAN be in the past (receiving items received earlier)
    // but should be valid dates
    if (formData.receiptDate && !isDateValid(formData.receiptDate)) {
      setFeedback({
        type: "error",
        message: "Please enter a valid receipt date.",
      });
      return;
    }

    const casesPerPalletValue = Number(formData.casesPerPallet);

    const casesPerPalletInvalid =
      isFinishedGood && (!Number.isFinite(casesPerPalletValue) || casesPerPalletValue <= 0);

    if (casesPerPalletInvalid) {
      setFeedback({
        type: "error",
        message: "Enter a valid cases-per-pallet value for finished goods.",
      });
      return;
    }

    // Validate row selection and pallet count for raw materials and packaging
    if (requiresRowSelection && formData.subLocation) {
      // Validate pallet count is entered
      if (!formData.pallets || Number(formData.pallets) <= 0) {
        setFeedback({
          type: "error",
          message: "Please enter the total number of pallets needed.",
        });
        return;
      }

      // Unlimited storage (0/0 sub location): no row selection required
      if (!isUnlimitedStorage) {
        // Validate at least one row is selected
        if (rawMaterialRowAllocations.length === 0) {
          setFeedback({
            type: "error",
            message: "Please select at least one row to store the pallets.",
          });
          return;
        }

        // Validate total pallets match
        const totalAllocated = rawMaterialRowAllocations.reduce((sum, alloc) => sum + (Number(alloc.pallets) || 0), 0);
        const totalNeeded = Number(formData.pallets);

        if (totalAllocated !== totalNeeded) {
          setFeedback({
            type: "error",
            message: `Total pallets allocated (${totalAllocated}) must equal total pallets needed (${totalNeeded}).`,
          });
          return;
        }

        // Validate each row doesn't exceed capacity
        for (const alloc of rawMaterialRowAllocations) {
          const palletsToAdd = Number(alloc.pallets);
          const originalAvailable = alloc.available;
          if (originalAvailable !== null && palletsToAdd > originalAvailable) {
            setFeedback({
              type: "error",
              message: `Row ${alloc.rowName} cannot accommodate ${palletsToAdd} pallets. Available: ${originalAvailable} pallets.`,
            });
            return;
          }
        }
      }
    }

    if (isFinishedGood) {
      if (manualAllocations.length === 0 && Number(floorPallets) <= 0) {
        setFeedback({
          type: "error",
          message: "Add at least one rack placement or floor pallet entry from the forklift log.",
        });
        return;
      }

      const invalidRow = manualAllocations.some(
        (entry) =>
          !entry.areaId ||
          !entry.rowId ||
          Number(entry.pallets) <= 0 ||
          !Number.isFinite(Number(entry.pallets)),
      );

      if (invalidRow) {
        setFeedback({
          type: "error",
          message: "Each placement must include an area, row, and pallet count greater than zero.",
        });
        return;
      }

      if (casesMismatch) {
        setFeedback({
          type: "error",
          message:
            "Pallet placements do not add up to the total cases produced. Adjust the counts or floor pallets.",
        });
        return;
      }
    }

    const receiptPayload = {
      categoryId: formData.categoryId,
      productId: formData.productId,
      receiptDate: formData.receiptDate,
      lotNo: formData.lotNo,
      sid: formData.sid,
      vendorId: formData.vendorId,
      expiration: formData.expiration,
      quantity: formData.quantity,
      quantityUnits: formData.quantityUnits,
      // Container & weight fields for proper UOM tracking
      containerCount: formData.quantity ? parseFloat(formData.quantity) : null,
      containerUnit: formData.quantityUnits || null,
      weightPerContainer: formData.weightPerUnit ? parseFloat(formData.weightPerUnit) : null,
      weightUnit: formData.weightUnits || null,
      weight: formData.weight,
      weightUnits: formData.weightUnits,
      brix: formData.brix,
      bol: formData.bol,
      purchaseOrder: formData.purchaseOrder,
      location: formData.location,
      subLocation: formData.subLocation,
      storageRowId: !isUnlimitedStorage && requiresRowSelection && rawMaterialRowAllocations.length === 1
        ? rawMaterialRowAllocations[0].rowId
        : (isUnlimitedStorage ? null : (formData.storageRowId || null)),
      pallets: requiresRowSelection ? Number(formData.pallets) || null : null,
      rawMaterialRowAllocations: !isUnlimitedStorage && requiresRowSelection && rawMaterialRowAllocations.length > 0
        ? rawMaterialRowAllocations.map(alloc => ({
            rowId: alloc.rowId,
            pallets: Number(alloc.pallets) || 0,
          }))
        : null,
      autoAssignSubLocation: isPackaging,
      productionDate: formData.productionDate,
      fccCode: formData.fccCode,
      shift: formData.shift,
      lineNumber: formData.lineNumber,
      hold: formData.hold,
      casesPerPallet: formData.casesPerPallet,
      fullPallets: formData.fullPallets,
      partialCases: formData.partialCases,
      note: formData.note,
    };

    if (isFinishedGood) {
      receiptPayload.manualAllocations = manualAllocations.map((entry) => ({
        areaId: entry.areaId,
        rowId: entry.rowId,
        pallets: Number(entry.pallets) || 0,
        cases: Number(entry.cases) || 0,
      }));
      receiptPayload.floorPallets = Number(floorPallets) || 0;
      receiptPayload.floorCases = Number(manualTotals.floorCases) || 0;

      const fakeReceiptForLicence = {
        allocation: {
          plan: receiptPayload.manualAllocations.map((a) => ({ pallets: a.pallets })),
        },
        lotNo: formData.lotNo,
        productId: formData.productId,
      };
      const summary = {
        product: products.find((p) => p.id === formData.productId)?.name || "",
        totalCases: totalCasesExpected,
        rackCases: manualTotals.totalManualCases,
        floorCases: manualTotals.floorCases,
        licencePreview: buildLicenceNote(fakeReceiptForLicence, products),
        placements: receiptPayload.manualAllocations.map((entry) => {
          const area = storageAreas.find((areaItem) => areaItem.id === entry.areaId);
          const row = area?.rows.find((rowItem) => rowItem.id === entry.rowId);
          return {
            areaName: area?.name || entry.areaId,
            rowName: row?.name || entry.rowId,
            pallets: entry.pallets,
            cases: entry.cases,
          };
        }),
      };

      setConfirmation({ open: true, payload: receiptPayload, summary });
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await submitReceipt(receiptPayload);

      if (!result.success) {
        setFeedback({
          type: "error",
          message:
            result.message ||
            (result.error === "duplicate_bol"
              ? "BOL number must be unique for raw material receipts."
              : "Failed to submit receipt. Please try again."),
        });
        setIsSubmitting(false);
        return;
      }

      setAllocationPreview(result.receipt?.allocation || null);
      setFormData(defaultFormState);
      setManualAllocations([]);
      setRawMaterialRowAllocations([]);
      setFloorPallets("0");
      setAutoQuantity(null);
      setIsSubmitting(false);
      setLotNumberManuallyEdited(false);
      const licenceNote = buildLicenceNote(result.receipt, products);
      setFeedback({
        type: "success",
        message: licenceNote
          ? `Receipt submitted for approval. ${licenceNote}`
          : "Receipt submitted for approval.",
      });
    } catch (error) {
      console.error('Error submitting receipt:', error);
      setFeedback({
        type: "error",
        message: "Failed to submit receipt. Please try again.",
      });
      setIsSubmitting(false);
    }
  };

  const finalizeFinishedGoodReceipt = async () => {
    if (!confirmation.payload) return;
    setIsSubmitting(true);
    try {
      const result = await submitReceipt(confirmation.payload);

      if (!result.success) {
        setFeedback({
          type: "error",
          message:
            result.message ||
            (result.error === "duplicate_bol"
              ? "BOL number must be unique for raw material receipts."
              : "Failed to submit receipt. Please try again."),
        });
        setIsSubmitting(false);
        setConfirmation({ open: false, payload: null, summary: null });
        return;
      }

      setAllocationPreview(result.receipt?.allocation || null);
      setFormData(defaultFormState);
      setManualAllocations([]);
      setFloorPallets("0");
      setAutoQuantity(null);
      setIsSubmitting(false);
      setLotNumberManuallyEdited(false);
      const licenceNote = buildLicenceNote(result.receipt, products);
      setFeedback({
        type: "success",
        message: licenceNote
          ? `Receipt submitted for approval. ${licenceNote}`
          : "Receipt submitted for approval.",
      });
      setConfirmation({ open: false, payload: null, summary: null });
    } catch (error) {
      console.error('Error submitting receipt:', error);
      setFeedback({
        type: "error",
        message: "Failed to submit receipt. Please try again.",
      });
      setIsSubmitting(false);
      setConfirmation({ open: false, payload: null, summary: null });
    }
  };

  const cancelConfirmation = () => {
    setConfirmation({ open: false, payload: null, summary: null });
  };

  return (
    <div className="receipt-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <section className="panel">
          <div className="panel-header">
            <h2>Log Receipt</h2>
            <p className="muted">
              Submit new inventory for supervisor approval. Finished and
              packaging goods will be auto slotted once approved.
            </p>
          </div>

          {/* Moved feedback near the submit button for better visibility */}

          <form ref={formRef} onSubmit={handleSubmit} className="simple-form">
            <div className="form-grid receipt-layout">
              <label className="full-width">
                <span>Item Category {requiredStar}</span>
                <select
                  name="categoryGroupId"
                  value={formData.categoryGroupId}
                  onChange={(e) => handleCategoryGroupChange(e.target.value)}
                  required
                >
                  <option value="">Select category</option>
                  {categoryGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>

              {formData.categoryGroupId && (
                <label className="full-width">
                  <span>Product Category {requiredStar}</span>
                  <select
                    name="categoryId"
                    value={formData.categoryId}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    required
                  >
                    <option value="">Select product category</option>
                    {categoryOptions
                      .filter(
                        (category) =>
                          category.parentId === formData.categoryGroupId,
                      )
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {!formData.categoryId && (
                <div className="form-hint full-width">
                  Choose a product category to load the rest of the receipt
                  form.
                </div>
              )}

              {formData.categoryId && (
                <React.Fragment>
                  <label className="full-width">
                    <span>
                      {productLabel} {requiredStar}
                    </span>
                    <SearchableSelect
                      options={
                        isFinishedGood
                          ? finishedGoodOptions
                          : isIngredient
                            ? ingredientOptions
                            : packagingOptions
                      }
                      value={formData.productId}
                      onChange={handleProductSelect}
                      placeholder="Select product"
                      searchPlaceholder="Type to search..."
                      required
                    />
                  </label>

                  {(isIngredient || isPackaging) && (
                    <label>
                      <span>SID / Barcode {requiredStar}</span>
                      <input
                        type="text"
                        name="sid"
                        value={formData.sid}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>FCC Code {requiredStar}</span>
                      <input
                        type="text"
                        name="fccCode"
                        value={formData.fccCode}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}

                  {(isIngredient || isPackaging) && (
                    <label>
                      <span>Vendor</span>
                      <select
                        name="vendorId"
                        value={formData.vendorId}
                        onChange={handleChange}
                      >
                        <option value="">Select vendor (optional)</option>
                        {vendors.map((vendor) => (
                          <option key={vendor.id} value={vendor.id}>
                            {vendor.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>Production Date {requiredStar}</span>
                      <input
                        type="date"
                        name="productionDate"
                        value={formData.productionDate}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>Expiration Date {requiredStar}</span>
                      <input
                        type="date"
                        name="expiration"
                        value={formData.expiration}
                        onChange={(e) => {
                          handleChange(e);
                          // Mark as touched so auto-calculation doesn't override
                          setFormData((prev) => ({ ...prev, expirationTouched: true }));
                        }}
                        required
                      />
                    </label>
                  )}

                  {isIngredient && (
                    <label>
                      <span>Expiration Date {requiredStar}</span>
                      <input
                        type="date"
                        name="expiration"
                        value={formData.expiration}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}

                  {isPackaging && (
                    <label>
                      <span>Expiration Date (Optional)</span>
                      <input
                        type="date"
                        name="expiration"
                        value={formData.expiration}
                        onChange={handleChange}
                      />
                    </label>
                  )}

                  <label>
                    <span>Receipt Date {requiredStar}</span>
                    <input
                      type="date"
                      name="receiptDate"
                      value={formData.receiptDate}
                      onChange={handleChange}
                      required
                    />
                  </label>

                  {isFinishedGood && (
                    <label>
                      <span>Shift {requiredStar}</span>
                      <select
                        name="shift"
                        value={formData.shift}
                        onChange={handleChange}
                        required
                      >
                        <option value="">Select shift</option>
                        {productionShifts.map((shift) => (
                          <option key={shift.id} value={shift.id}>
                            {shift.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>Line Number {requiredStar}</span>
                      <select
                        name="lineNumber"
                        value={formData.lineNumber}
                        onChange={handleChange}
                        required
                      >
                        <option value="">Select line</option>
                        {productionLines.map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label>
                    <span>Lot Number {(isFinishedGood || isIngredient) ? requiredStar : null}</span>
                    <input
                      type="text"
                      name="lotNo"
                      value={formData.lotNo}
                      onChange={handleChange}
                      required={isFinishedGood || isIngredient}
                      aria-label="Lot number"
                    />
                  </label>

                  {(isIngredient || showPackagingFields) && (
                    <React.Fragment>
                      {/* Inline container row: count [type] × weight [unit] */}
                      <label className="full-width">
                        <span>Received As {requiredStar}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <input
                            type="number"
                            name="quantity"
                            value={formData.quantity}
                            onChange={handleChange}
                            min="0"
                            step="0.01"
                            required
                            placeholder="Count"
                            style={{ width: 90 }}
                          />
                          <select
                            name="quantityUnits"
                            value={formData.quantityUnits}
                            onChange={handleChange}
                            required
                            style={{ width: 130 }}
                          >
                            <option value="">Type…</option>
                            {unitOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>

                          {isIngredient && (
                            <>
                              <span style={{ color: '#9ca3af', fontWeight: 600 }}>×</span>
                              <input
                                type="number"
                                name="weightPerUnit"
                                value={formData.weightPerUnit}
                                onChange={handleChange}
                                min="0"
                                step="0.01"
                                required
                                placeholder="Weight each"
                                style={{ width: 110 }}
                              />
                              <select
                                name="weightUnits"
                                value={formData.weightUnits}
                                onChange={handleChange}
                                required
                                style={{ width: 100 }}
                              >
                                <option value="">Unit…</option>
                                {weightUnitOptions.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </>
                          )}
                        </div>

                        {/* Summary: 15 Bags · 3,750 lbs total */}
                        {isIngredient && formData.quantity && formData.quantityUnits && formData.weightPerUnit && formData.weightUnits && totalWeight > 0 && (
                          <div style={{ marginTop: 8, padding: '8px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 12 }}>
                            <span style={{ fontWeight: 700, color: '#15803d', fontSize: '0.95rem' }}>
                              {formData.quantity} {formData.quantityUnits}
                            </span>
                            <span style={{ color: '#9ca3af' }}>·</span>
                            <span style={{ fontWeight: 700, color: '#1a5276', fontSize: '0.95rem' }}>
                              {Number(formData.weight).toLocaleString()} {formData.weightUnits} total
                            </span>
                            <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}>
                              ({formData.weightPerUnit} {formData.weightUnits} × {formData.quantity})
                            </span>
                          </div>
                        )}
                      </label>

                      {isIngredient && (
                        <label>
                          <span>Brix</span>
                          <input
                            type="number"
                            name="brix"
                            value={formData.brix}
                            onChange={handleChange}
                            min="0"
                            step="0.1"
                          />
                        </label>
                      )}

                      <label>
                        <span>Location {requiredStar}</span>
                        <select
                          name="location"
                          value={formData.location}
                            onChange={(e) =>
                            setFormData((prev) => ({
                              ...prev,
                              location: e.target.value,
                              subLocation: "",
                              storageRowId: "",
                              pallets: "", // Clear pallets when location changes
                            }))
                          }
                          required
                        >
                          <option value="">Select location</option>
                          {locations.map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      {formData.location && (
                        <label>
                          <span>Sub Location {requiredStar}</span>
                          <select
                            name="subLocation"
                            value={formData.subLocation}
                              onChange={(e) =>
                              setFormData((prev) => ({
                                ...prev,
                                subLocation: e.target.value,
                                storageRowId: "",
                                pallets: "", // Clear pallets when sub-location changes
                              }))
                            }
                            required
                          >
                            <option value="">Select sub location</option>
                            {(subLocationMap[formData.location] || []).map(
                              (sub) => (
                                <option key={sub.id} value={sub.id}>
                                  {sub.name}
                                </option>
                              ),
                            )}
                          </select>
                        </label>
                      )}

                      {/* NEW FLOW: Pallet count FIRST, then row selection */}
                      {formData.subLocation && (requiresRowSelection || availableRows.length > 0) && (
                        <>
                          {/* Step 1: Enter total pallets needed FIRST */}
                          <label>
                            <span>Total Pallets Needed {requiredStar}</span>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              <input
                                type="number"
                                name="pallets"
                                value={formData.pallets}
                                onChange={(e) => {
                                  handleChange(e);
                                  // Clear row selections when pallet count changes
                                  setFormData(prev => ({ ...prev, storageRowId: "" }));
                                  setRawMaterialRowAllocations([]);
                                }}
                                min="1"
                                step="1"
                                required={requiresRowSelection}
                                style={{ flex: 1 }}
                                placeholder="Enter total pallet count"
                              />
                            </div>
                            <div className="form-hint" style={{ marginTop: '4px', color: '#666', fontSize: '0.875rem' }}>
                              {isUnlimitedStorage
                                ? "Unlimited storage – no row selection needed. Enter total pallets and submit."
                                : "Enter the total number of pallets you need to store. Then select one or more rows below."}
                            </div>
                          </label>

                          {/* Step 2: Select rows (only when sub location has rows; 0/0 = unlimited, no selection) */}
                          {formData.pallets && Number(formData.pallets) > 0 && !isUnlimitedStorage && (
                            <div>
                              <label style={{ display: 'block', marginBottom: '8px' }}>
                                <span>Select Row(s) {requiredStar}</span>
                              </label>
                              
                              {availableRows.length === 0 ? (
                                <div className="form-error" style={{ padding: '12px', borderRadius: '4px', backgroundColor: '#fee', border: '1px solid #fcc' }}>
                                  No rows available with sufficient capacity for {formData.pallets} pallets.
                                  Please add more rows in Master Data or reduce the pallet count.
                                </div>
                              ) : (
                                <div style={{ 
                                  border: '1px solid #ddd', 
                                  borderRadius: '4px', 
                                  padding: '12px',
                                  maxHeight: '200px',
                                  overflowY: 'auto',
                                  backgroundColor: '#fafafa'
                                }}>
                                  {availableRows.map((row) => {
                                    const isSelected = rawMaterialRowAllocations.some(alloc => alloc.rowId === row.value);
                                    const canFitAll = row.available !== null && row.available >= Number(formData.pallets);
                                    
                                    return (
                                      <label 
                                        key={row.value} 
                                        style={{ 
                                          display: 'flex', 
                                          alignItems: 'center', 
                                          padding: '8px',
                                          marginBottom: '4px',
                                          cursor: 'pointer',
                                          backgroundColor: isSelected ? '#e8f5e9' : 'transparent',
                                          borderRadius: '4px',
                                          border: isSelected ? '2px solid #4caf50' : '1px solid transparent'
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelected}
                                          onChange={(e) => {
                                            if (e.target.checked) {
                                              // Calculate how many pallets are already allocated to other rows
                                              const alreadyAllocated = rawMaterialRowAllocations.reduce(
                                                (sum, a) => sum + (Number(a.pallets) || 0), 0
                                              );
                                              const totalNeeded = Number(formData.pallets) || 0;
                                              const remainingToAllocate = Math.max(0, totalNeeded - alreadyAllocated);
                                              
                                              // For the new row, assign remaining pallets (capped by row capacity)
                                              const palletsForThisRow = Math.min(remainingToAllocate, row.available || 0);
                                              
                                              // Add row allocation
                                              const newAlloc = {
                                                id: `raw-alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                                                rowId: row.value,
                                                rowName: row.rowData.name,
                                                pallets: palletsForThisRow,
                                                available: row.available,
                                                capacity: row.capacity,
                                              };
                                              setRawMaterialRowAllocations(prev => [...prev, newAlloc]);
                                            } else {
                                              // Remove row allocation
                                              setRawMaterialRowAllocations(prev => prev.filter(alloc => alloc.rowId !== row.value));
                                            }
                                          }}
                                          style={{ marginRight: '8px' }}
                                        />
                                        <div style={{ flex: 1 }}>
                                          <div style={{ fontWeight: isSelected ? 'bold' : 'normal' }}>
                                            {row.label}
                                          </div>
                                          {row.fitStatus && (
                                            <div style={{ fontSize: '0.875rem', color: canFitAll ? '#4caf50' : '#ff9800', marginTop: '2px' }}>
                                              {row.fitStatus}
                                            </div>
                                          )}
                                        </div>
                                      </label>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Step 3: Distribution panel when multiple rows selected */}
                              {rawMaterialRowAllocations.length > 1 && (
                                <div style={{ 
                                  marginTop: '16px', 
                                  padding: '12px', 
                                  backgroundColor: '#f5f5f5', 
                                  borderRadius: '4px',
                                  border: '1px solid #ddd'
                                }}>
                                  <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
                                    Distribute Pallets Across Selected Rows
                                  </div>
                                  {rawMaterialRowAllocations.map((alloc) => {
                                    const row = availableRows.find(r => r.value === alloc.rowId);
                                    // Use the original available capacity (stored at selection time), not the reduced available
                                    // The reduced 'row?.available' incorrectly subtracts current allocations from this form
                                    const maxPallets = alloc.available || row?.capacity || alloc.capacity || 0;
                                    
                                    return (
                                      <div key={alloc.id} style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <label style={{ minWidth: '100px', fontWeight: '500' }}>
                                          {alloc.rowName}:
                                        </label>
                                        <input
                                          type="number"
                                          value={alloc.pallets}
                                          onChange={(e) => {
                                            const newPallets = Math.max(0, Math.min(Number(e.target.value), maxPallets));
                                            setRawMaterialRowAllocations(prev =>
                                              prev.map(a => a.id === alloc.id ? { ...a, pallets: newPallets } : a)
                                            );
                                          }}
                                          min="0"
                                          max={maxPallets}
                                          step="1"
                                          style={{ width: '80px', padding: '4px 8px' }}
                                        />
                                        <span style={{ fontSize: '0.875rem', color: '#666' }}>
                                          (max: {maxPallets})
                                        </span>
                                      </div>
                                    );
                                  })}
                                  <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#fff', borderRadius: '4px' }}>
                                    <strong>Total: </strong>
                                    <span style={{ 
                                      color: rawMaterialRowAllocations.reduce((sum, a) => sum + (Number(a.pallets) || 0), 0) === Number(formData.pallets) 
                                        ? '#4caf50' 
                                        : '#f44336',
                                      fontWeight: 'bold'
                                    }}>
                                      {rawMaterialRowAllocations.reduce((sum, a) => sum + (Number(a.pallets) || 0), 0)} / {formData.pallets}
                                    </span>
                                    {rawMaterialRowAllocations.reduce((sum, a) => sum + (Number(a.pallets) || 0), 0) !== Number(formData.pallets) && (
                                      <div style={{ fontSize: '0.875rem', color: '#f44336', marginTop: '4px' }}>
                                        Total must equal {formData.pallets} pallets
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Single row selected - show confirmation */}
                              {rawMaterialRowAllocations.length === 1 && (
                                <div style={{ 
                                  marginTop: '12px', 
                                  padding: '8px', 
                                  backgroundColor: '#e8f5e9', 
                                  borderRadius: '4px',
                                  border: '1px solid #4caf50'
                                }}>
                                  <div style={{ fontSize: '0.875rem', color: '#2e7d32' }}>
                                    ✓ {rawMaterialRowAllocations[0].rowName} will store {formData.pallets} pallets
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {formData.subLocation && availableRows.length === 0 && !formData.pallets && requiresRowSelection && (
                            <div className="form-hint" style={{ marginTop: '4px', color: '#666', fontSize: '0.875rem' }}>
                              {isUnlimitedStorage
                                ? "Unlimited storage – enter total pallets above and submit."
                                : "Enter pallet count above to see available rows."}
                            </div>
                          )}
                        </>
                      )}
                    </React.Fragment>
                  )}

                  {showPackagingFields && null}

                  {isIngredient && (
                    <React.Fragment>
                      <label>
                        <span>BOL (Bill of Lading)</span>
                        <input
                          type="text"
                          name="bol"
                          value={formData.bol}
                          onChange={handleChange}
                        />
                      </label>

                      <label>
                        <span>Purchase Order</span>
                        <input
                          type="text"
                          name="purchaseOrder"
                          value={formData.purchaseOrder}
                          onChange={handleChange}
                        />
                      </label>

                      <label className="full-width optional">
                        <span>Description / Notes</span>
                        <textarea
                          name="note"
                          value={formData.note}
                          onChange={handleChange}
                          rows={3}
                        />
                      </label>
                    </React.Fragment>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>Cases per Pallet {requiredStar}</span>
                      <input
                        type="number"
                        name="casesPerPallet"
                        min="1"
                        value={formData.casesPerPallet}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>Full Pallets {requiredStar}</span>
                      <input
                        type="number"
                        name="fullPallets"
                        min="0"
                        step="1"
                        value={formData.fullPallets}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}

                  {isFinishedGood && (
                    <div className="partial-layout">
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          name="hasPartialPallet"
                          checked={formData.hasPartialPallet}
                          onChange={handleChange}
                        />
                        <span>Include partial pallet</span>
                      </label>

                      {formData.hasPartialPallet && (
                        <label className="partial-cases">
                          <span>Cases on Partial Pallet {requiredStar}</span>
                          <input
                            type="number"
                            name="partialCases"
                            min="0"
                            step="1"
                            value={formData.partialCases}
                            onChange={handleChange}
                            disabled={!formData.hasPartialPallet}
                            required={formData.hasPartialPallet}
                          />
                        </label>
                      )}
                    </div>
                  )}

                  {isFinishedGood && (
                    <label>
                      <span>Quantity Produced {requiredStar}</span>
                      <div className="unit-label">
                        <input
                          type="number"
                          name="quantity"
                          value={formData.quantity}
                          onChange={handleChange}
                          placeholder={autoQuantity ? formatNumber(autoQuantity) : ""}
                          required
                        />
                        <span className="unit-badge">Cases</span>
                      </div>
                    </label>
                  )}

                  {isFinishedGood && (
                    <section className="manual-allocation-panel full-width">
                      <div className="panel-header-line">
                        <div>
                          <h4>Actual Pallet Placements</h4>
                          <p className="muted small">
                            Enter the exact rack row and pallet counts from the forklift log. Use decimals for partial pallets. Remaining pallets can be recorded as floor staging.
                          </p>
                        </div>
                        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span>Warehouse</span>
                          <select value={fgWarehouseFilter} onChange={(e) => setFgWarehouseFilter(e.target.value)}>
                            <option value="">All locations</option>
                            {fgLocationsWithAreas.map((loc) => (
                              <option key={loc.id} value={loc.id}>{loc.name}</option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={addManualAllocation}
                        >
                          Add Location
                        </button>
                      </div>

                      {manualAllocations.length === 0 && (
                        <div className="manual-allocation-empty">
                          No rack placements added yet.
                        </div>
                      )}

                      {manualAllocations.map((entry, idx) => {
                        const area = storageAreaLookup.get(entry.areaId);
                        const row = area?.rows.find((rowItem) => rowItem.id === entry.rowId);

                        // Calculate available pallets accounting for:
                        // 1. Stored occupied pallets in the database
                        // 2. Other placements to the same row in the current form
                        let availablePallets = null;
                        if (row) {
                          const storedOccupied = Number(row.occupiedPallets || 0);
                          const capacity = Number(row.palletCapacity || 0);

                          // Sum up pallets from other manual allocations to this same row (excluding current entry)
                          const palletsFromOtherPlacements = manualAllocations
                            .filter(otherEntry =>
                              otherEntry.rowId === entry.rowId &&
                              otherEntry.id !== entry.id &&
                              otherEntry.rowId !== ""
                            )
                            .reduce((sum, otherEntry) => sum + Number(otherEntry.pallets || 0), 0);

                          // Don't subtract current entry's pallets - they're being added, not already occupied
                          availablePallets = Math.max(0, capacity - storedOccupied - palletsFromOtherPlacements);
                        }

                        const areaOptions = activeStorageAreas
                          .filter((a) => !fgWarehouseFilter || a.locationId === fgWarehouseFilter)
                          .map((areaOption) => ({
                            value: areaOption.id,
                            label: areaOption.name,
                          }));

                        const rowOptions = area
                          ? area.rows
                            .map((rowItem) => {
                              // Calculate available for each row option
                              const storedOccupied = Number(rowItem.occupiedPallets || 0);
                              const capacity = Number(rowItem.palletCapacity || 0);

                              // Sum pallets from other placements to this row in current form
                              const palletsFromCurrentForm = manualAllocations
                                .filter(otherEntry =>
                                  otherEntry.rowId === rowItem.id &&
                                  otherEntry.id !== entry.id
                                )
                                .reduce((sum, otherEntry) => sum + Number(otherEntry.pallets || 0), 0);

                              const available = Math.max(0, capacity - storedOccupied - palletsFromCurrentForm);

                              return {
                                value: rowItem.id,
                                label: `${rowItem.name} (${available.toFixed(0)} available)`,
                                available
                              };
                            })
                            .filter(opt => opt.available > 0)
                          : [];

                        // Compare fullPallets (not pallets) against available capacity
                        const entryPallets = Number(entry.fullPallets || 0);
                        const overCapacity =
                          availablePallets !== null && entryPallets > 0 && entryPallets > availablePallets;
                        return (
                          <div key={entry.id} className="manual-allocation-entry">
                            <div className="allocation-header">
                              <div className="allocation-title">
                                <span className="allocation-label">Placement {idx + 1}</span>
                                <span className="allocation-location">
                                  {area?.name || "Select Area"} - {row?.name || "Select Row"}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="remove-allocation-btn"
                                onClick={() => removeManualAllocation(entry.id)}
                                title="Remove this placement"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <line x1="18" y1="6" x2="6" y2="18"></line>
                                  <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                              </button>
                            </div>

                            <div className="allocation-fields">
                              <label>
                                <span>Storage Area {requiredStar}</span>
                                <SearchableSelect
                                  options={areaOptions}
                                  value={entry.areaId}
                                  onChange={(areaId) => updateManualAllocation(entry.id, { areaId, rowId: "" })}
                                  placeholder="Select area"
                                  searchPlaceholder="Search areas..."
                                  required
                                />
                              </label>

                              {availablePallets !== null && availablePallets === 0 && (
                                <div className="manual-allocation-warning">
                                  Row is full. Please select a different row or remove other placements to this row.
                                </div>
                              )}

                              {availablePallets !== null &&
                                availablePallets > 0 &&
                                Number.isFinite(Number(entry.fullPallets)) &&
                                Number(entry.fullPallets) >= availablePallets && (
                                  <div className="manual-allocation-warning">
                                    Row filled. Press Enter or click Add Location to continue. Remaining pallets will still be shown below.
                                  </div>
                                )}

                              <label>
                                <span>Row {requiredStar}</span>
                                <SearchableSelect
                                  options={rowOptions}
                                  value={entry.rowId}
                                  onChange={(rowId) => updateManualAllocation(entry.id, { rowId })}
                                  placeholder="Select row"
                                  searchPlaceholder="Search rows..."
                                  disabled={!entry.areaId}
                                  required
                                />
                              </label>

                              <label>
                                <span>Full Pallets {requiredStar}</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={entry.fullPallets}
                                  onChange={(e) => updateManualAllocation(entry.id, { fullPallets: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      addManualAllocation();
                                    }
                                  }}
                                  onWheel={(e) => e.currentTarget.blur()}
                                  required
                                />
                                <p className="muted small">
                                  {availablePallets !== null ? `Available: ${formatNumber(availablePallets)} pallets` : 'Select a row to view capacity'}
                                </p>
                              </label>
                            </div>
                            {overCapacity && (
                              <div className="manual-allocation-warning">
                                Row capacity exceeded. Only {availablePallets.toFixed(0)} pallets available. Reduce pallets or choose another row.
                              </div>
                            )}
                          </div>
                        );
                      })}

                      <div className="manual-allocation-summary">
                        <div className="summary-stats">
                          <div>
                            <strong>Total rack cases:</strong> {formatNumber(manualTotals.rackCases)}
                          </div>
                          <div>
                            <strong>Total rack pallets:</strong> {formatNumber(manualTotals.rackPallets)}
                          </div>
                        </div>

                        <div className="floor-input">
                          <label>
                            <span>Floor Pallets</span>
                            <div className="floor-pallets-control">
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={floorPallets}
                                onChange={(event) => setFloorPallets(event.target.value)}
                                onWheel={(e) => e.currentTarget.blur()}
                              />
                              {Number(manualTotals.remainingFloorPallets) > 0 && (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() =>
                                    setFloorPallets(
                                      formatInputValue(manualTotals.remainingFloorPallets, 4),
                                    )
                                  }
                                >
                                  Use remaining ({formatNumber(manualTotals.remainingFloorPallets)})
                                </button>
                              )}
                            </div>
                          </label>
                          <p className="muted small">
                            Floor cases: {formatNumber(manualTotals.floorCases)}
                          </p>
                        </div>
                      </div>
                    </section>
                  )}
                </React.Fragment>
              )}
            </div>

            {feedback && (
              <div className={`alert ${feedback.type}`}>{feedback.message}</div>
            )}

            <div className="form-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={!formData.categoryId || !formData.productId || isSubmitting}
              >
                {isSubmitting ? 'Submitting...' : 'Submit for Approval'}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setFormData(defaultFormState);
                  setAutoQuantity(null);
                  setLotNumberManuallyEdited(false);
                }}
              >
                Clear
              </button>
            </div>
          </form>
        </section>

        <ReceiptConfirmModal
          open={confirmation.open}
          summary={confirmation.summary}
          isSubmitting={isSubmitting}
          onConfirm={finalizeFinishedGoodReceipt}
          onCancel={cancelConfirmation}
          formatNumber={formatNumber}
        />

        {/* Removed auto allocation card because placements are now manual */}

      </div>
    </div>
  );
};

export default ReceiptPage;
