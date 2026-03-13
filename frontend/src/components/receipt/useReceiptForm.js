import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../../context/AppDataContext";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { isDateInPast, isDateValid, getTodayDateKey } from "../../utils/dateUtils";
import { validateLotNumber } from "../../utils/sanitizeUtils";
import { CATEGORY_TYPES } from "../../constants";

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
  pallets: "",
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

export const buildLicenceNote = (receipt, products = []) => {
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

export const getProductLabel = (product) => {
  if (!product) return "";
  const code = product.fcc || product.sid || "";
  return code ? `${product.name} (${code})` : product.name;
};

export const formatNumber = (num) => {
  if (!Number.isFinite(num)) return "-";
  return Number(num).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
};

export const formatInputValue = (value, decimals = 4) => {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
  return trimmed === "" ? "0" : trimmed;
};

// Container-type units only (how many, not how much weight)
export const unitOptions = [
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

export const weightUnitOptions = [
  { value: "kg", label: "Kilograms" },
  { value: "lbs", label: "Pounds" },
  { value: "g", label: "Grams" },
  { value: "oz", label: "Ounces" },
  { value: "mt", label: "Metric Tons" },
];

const useReceiptForm = () => {
  const navigate = useNavigate();
  const { user, isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { confirm } = useConfirm();
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
  const [rawMaterialRowAllocations, setRawMaterialRowAllocations] = useState([]);
  const [fgWarehouseFilter, setFgWarehouseFilter] = useState("");

  // --- Derived values ---

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
  const isPackaging = selectedCategory?.type === CATEGORY_TYPES.PACKAGING;
  const showPackagingFields = isPackaging;
  const isIngredient = selectedCategory?.type === "raw" && !isPackaging;
  const requiresRowSelection = isIngredient || isPackaging;

  // --- Helper functions ---

  const extractLineNumber = useCallback((lineId) => {
    if (!lineId) return null;
    const line = productionLines.find(l => l.id === lineId);
    if (!line) return null;
    const match = line.name.match(/\d+/);
    return match ? match[0] : null;
  }, [productionLines]);

  const generateLotNumber = useCallback((productionDate, lineNumber) => {
    if (!productionDate || !lineNumber) return "";
    const dayOfYear = getDayOfYear(productionDate);
    if (!dayOfYear) return "";
    const lineNum = extractLineNumber(lineNumber);
    if (!lineNum) return "";
    const date = new Date(productionDate);
    const year = date.getFullYear().toString().slice(-2);
    return `MP${String(dayOfYear).padStart(3, '0')}${year}L${lineNum}`;
  }, [extractLineNumber]);

  // --- Computed/memoized values ---

  const totalWeight = useMemo(() => {
    const qty = parseFloat(formData.quantity || 0);
    const perUnit = parseFloat(formData.weightPerUnit || 0);
    const total = qty * perUnit;
    return Number.isFinite(total) ? total : 0;
  }, [formData.quantity, formData.weightPerUnit]);

  const activeStorageAreas = useMemo(
    () => storageAreas.filter((area) => area.active),
    [storageAreas],
  );

  const fgLocationsWithAreas = useMemo(() => {
    const ids = new Set();
    activeStorageAreas.forEach((area) => {
      if (area.locationId) ids.add(area.locationId);
    });
    return locations.filter((loc) => ids.has(loc.id));
  }, [activeStorageAreas, locations]);

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

  const availableRows = useMemo(() => {
    if (!formData.subLocation || !formData.location) return [];

    const location = locations.find(loc => loc.id === formData.location);
    const subLoc = location?.subLocations?.find(sub => sub.id === formData.subLocation);
    const subLocFromMap = subLocationMap[formData.location]?.find(sub => sub.id === formData.subLocation);
    const finalSubLoc = subLoc || subLocFromMap;

    if (!finalSubLoc) {
      console.warn('Sub-location not found:', formData.subLocation, 'in location:', formData.location);
      return [];
    }

    const rows = Array.isArray(finalSubLoc.rows) ? finalSubLoc.rows : [];
    if (rows.length === 0) return [];

    const totalPalletsNeeded = Number(formData.pallets) || 0;

    return rows
      .filter(row => row && row.active !== false)
      .map(row => {
        const capacity = row.palletCapacity || 0;
        const occupied = row.occupiedPallets || 0;
        const available = capacity > 0 ? Math.max(0, capacity - occupied) : null;

        let canFit = true;
        let fitStatus = '';
        if (totalPalletsNeeded > 0 && available !== null) {
          if (available >= totalPalletsNeeded) {
            fitStatus = 'Can fit all';
            canFit = true;
          } else if (available > 0) {
            fitStatus = `Can fit ${available} of ${totalPalletsNeeded}`;
            canFit = true;
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
          available: available,
          capacity: capacity,
          canFit: canFit,
          fitStatus: fitStatus,
        };
      })
      .filter(row => {
        if (totalPalletsNeeded > 0 && row.available !== null && row.available === 0) {
          return false;
        }
        return true;
      });
  }, [formData.location, formData.subLocation, formData.pallets, locations, subLocationMap]);

  const isUnlimitedStorage = requiresRowSelection && formData.subLocation && availableRows.length === 0;

  const finishedGoodOptions = useMemo(() => {
    if (!formData.categoryId) return [];
    return products
      .filter((product) => product.categoryId === formData.categoryId && product.status === "active")
      .map((product) => ({ value: product.id, label: getProductLabel(product) }));
  }, [products, formData.categoryId]);

  const ingredientOptions = useMemo(() => {
    if (!formData.categoryId) return [];
    return products
      .filter((product) => {
        const category = productCategories.find((cat) => cat.id === product.categoryId);
        return category?.type === "raw"
          && product.categoryId === formData.categoryId
          && product.status === "active";
      })
      .map((product) => ({ value: product.id, label: getProductLabel(product) }));
  }, [products, productCategories, formData.categoryId]);

  const packagingOptions = useMemo(() => {
    if (!formData.categoryId) return [];
    return products
      .filter((product) => {
        return product.categoryId === formData.categoryId
          && (product.status === "active" || product.active !== false);
      })
      .map((product) => ({ value: product.id, label: getProductLabel(product) }));
  }, [products, formData.categoryId]);

  // --- Handlers ---

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target;
    const parsedValue = type === "checkbox" ? checked : value;

    if (name === "lotNo") {
      setLotNumberManuallyEdited(true);
    }

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

  const handleProductSelect = (productId) => {
    const product = products.find((item) => item.id === productId);
    setFormData((prev) => ({
      ...prev,
      productId,
      sid: product?.sid || "",
      fccCode: product?.fcc || "",
      casesPerPallet: product?.defaultCasesPerPallet ?? "",
      quantityUnits: product?.quantityUom || prev.quantityUnits || "",
      expireYears: product?.expireYears ?? null,
      expirationTouched: false,
      expiration: prev.expirationTouched ? prev.expiration : "",
    }));
    setManualAllocations([]);
    setFloorPallets("0");
    setLotNumberManuallyEdited(false);
  };

  const handleLocationChange = (locationValue) => {
    setFormData((prev) => ({
      ...prev,
      location: locationValue,
      subLocation: "",
      storageRowId: "",
      pallets: "",
    }));
  };

  const handleSubLocationChange = (subLocationValue) => {
    setFormData((prev) => ({
      ...prev,
      subLocation: subLocationValue,
      storageRowId: "",
      pallets: "",
    }));
  };

  const handlePalletsChange = (event) => {
    handleChange(event);
    setFormData(prev => ({ ...prev, storageRowId: "" }));
    setRawMaterialRowAllocations([]);
  };

  // --- Manual allocation handlers (FG) ---

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

  // --- Effects ---

  useEffect(() => {
    const next = totalWeight > 0 ? String(totalWeight) : "";
    setFormData((prev) => prev.weight === next ? prev : { ...prev, weight: next });
  }, [totalWeight]);

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

  // --- Submission ---

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formData.categoryId || !formData.productId) {
      setFeedback({
        type: "error",
        message: "Select category and product before submitting.",
      });
      return;
    }

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

    if (requiresRowSelection && formData.subLocation) {
      if (!formData.pallets || Number(formData.pallets) <= 0) {
        setFeedback({
          type: "error",
          message: "Please enter the total number of pallets needed.",
        });
        return;
      }

      if (!isUnlimitedStorage) {
        if (rawMaterialRowAllocations.length === 0) {
          setFeedback({
            type: "error",
            message: "Please select at least one row to store the pallets.",
          });
          return;
        }

        const totalAllocated = rawMaterialRowAllocations.reduce((sum, alloc) => sum + (Number(alloc.pallets) || 0), 0);
        const totalNeeded = Number(formData.pallets);

        if (totalAllocated !== totalNeeded) {
          setFeedback({
            type: "error",
            message: `Total pallets allocated (${totalAllocated}) must equal total pallets needed (${totalNeeded}).`,
          });
          return;
        }

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

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this receipt to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
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

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this receipt to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

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

  const clearForm = () => {
    setFormData(defaultFormState);
    setAutoQuantity(null);
    setLotNumberManuallyEdited(false);
  };

  return {
    // Navigation
    navigate,
    user,

    // Context data
    categoryGroups,
    categoryOptions,
    products,
    vendors,
    locations,
    subLocationMap,
    productionShifts,
    productionLines,
    storageAreas,

    // Form state
    formData,
    setFormData,
    formRef,
    feedback,
    autoQuantity,
    isSubmitting,
    confirmation,

    // Derived values
    selectedCategory,
    productLabel,
    isFinishedGood,
    isPackaging,
    showPackagingFields,
    isIngredient,
    requiresRowSelection,
    isUnlimitedStorage,
    totalWeight,
    totalCasesExpected,
    casesMismatch,

    // Product options
    finishedGoodOptions,
    ingredientOptions,
    packagingOptions,

    // Location / row
    availableRows,

    // FG placement state
    manualAllocations,
    manualTotals,
    floorPallets,
    setFloorPallets,
    fgWarehouseFilter,
    setFgWarehouseFilter,
    fgLocationsWithAreas,
    activeStorageAreas,
    storageAreaLookup,

    // RM/packaging row allocations
    rawMaterialRowAllocations,
    setRawMaterialRowAllocations,

    // Handlers
    handleChange,
    handleCategoryGroupChange,
    handleCategoryChange,
    handleProductSelect,
    handleLocationChange,
    handleSubLocationChange,
    handlePalletsChange,
    handleSubmit,
    addManualAllocation,
    updateManualAllocation,
    removeManualAllocation,
    finalizeFinishedGoodReceipt,
    cancelConfirmation,
    clearForm,
  };
};

export default useReceiptForm;
