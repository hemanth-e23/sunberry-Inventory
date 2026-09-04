import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../../context/AppDataContext";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { isDateInPast, isDateValid, getTodayDateKey } from "../../utils/dateUtils";
import { generateLotNumberFromLine } from "../../utils/lotNumber";
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
  // Blank for barrels; 50 for bags that arrive wrapped fifty to a pallet.
  // Decides whether stickers print per pallet or per container.
  unitsPerPallet: "",
  // Palletised material is entered as FULL PALLETS + whatever is loose on top,
  // because that is what a person sees on a truck. Two full pallets and a
  // partial with thirty bags on it is 130 bags — neither 100 nor 150 — so a
  // pallet count alone cannot express a real delivery. `quantity` is derived
  // from these two and stays the container count underneath.
  palletCount: "",
  looseCount: "",
  // Pre-filled: pounds is the only unit this system stores. See
  // weightUnitOptions for why there is no longer a choice.
  weightUnits: "lbs",
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

export const buildLicenceNote = (receipt, products = []) => {
  // Prefer the exact range the backend reports — it knows the real
  // sequence start (which appends to any existing pallets of the same
  // lot+product) and uses the same product_code resolution rules as the
  // create endpoint.
  const first = receipt?.generated_licence_first || receipt?.generatedLicenceFirst;
  const last = receipt?.generated_licence_last || receipt?.generatedLicenceLast;
  const count = receipt?.generated_licence_count ?? receipt?.generatedLicenceCount;
  if (first && last && count) {
    if (first === last) {
      return `${count} pallet licence number generated (${first})`;
    }
    return `${count} pallet licence numbers generated (${first} through ${last})`;
  }

  // Fallback (e.g. preview before submit): derive from the receipt's plan.
  // Note this can't know about existing pallets in the same (lot, product),
  // so it shows 001..N — acceptable for the pre-submit preview only.
  const lot = receipt?.lotNo || receipt?.lot_number;
  const prodId = receipt?.productId || receipt?.product_id;
  if (!receipt?.allocation?.plan?.length || !lot || !prodId) return null;
  const plan = receipt.allocation.plan;
  const totalPallets = plan.reduce((s, i) => s + (parseInt(i.pallets, 10) || 0), 0);
  if (totalPallets < 1) return null;
  const product = products.find((p) => p.id === prodId) || {};
  const productCode = (product.short_code || product.shortCode || product.fcc || product.name || "PRD")
    .slice(0, 10)
    .replace(/\s/g, "")
    .toUpperCase();
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

/**
 * "How many ride one pallet" is a CONTAINER question, not a bags question.
 *
 * This was originally restricted to bags and boxes, on the reasoning that a
 * drum IS the thing carried. That was wrong, and the warehouse's own data said
 * so: four drums logged as sitting on two pallets. Drums ride pallets too, just
 * two or four to a pallet instead of fifty.
 *
 * The cost of getting it wrong was silent. `_pallet_footprint` falls back to
 * the unit count when this is unset, so a rack holding two pallets of drums
 * reported four slots — double — and there was no way to correct it, because
 * the footprint is derived and the figure it derives from was never collected.
 *
 * So it is asked for EVERY container now. The difference is only whether it
 * must be answered:
 *
 *   REQUIRED for bags, bottles, cases, pails — always many to a pallet, and a
 *   blank here misprints five hundred stickers instead of ten.
 *
 *   OPTIONAL for drums, barrels, totes — often genuinely one per slot, which is
 *   what blank means. Gallons and litres are measures rather than containers,
 *   and `pallets` is already the pallet, so those are skipped entirely.
 */
export const PALLETISED_UNITS = new Set(["bags", "bottles", "cases", "pails"]);

// Containers where a pallet count is meaningless: measures, and the pallet itself.
const NOT_A_CONTAINER = new Set(["gallons", "liters", "pallets"]);

/** Must this be answered? Bags and boxes always ride pallets. */
export const isPalletisedUnit = (unit) =>
  PALLETISED_UNITS.has(String(unit || "").toLowerCase());

/** Should we ask at all? Everything that is a physical container. */
export const asksPerPallet = (unit) => {
  const u = String(unit || "").toLowerCase();
  return Boolean(u) && !NOT_A_CONTAINER.has(u);
};

/**
 * POUNDS, AND ONLY POUNDS.
 *
 * This used to offer kg, g, oz and metric tons. Nothing downstream converts:
 * `weight_per_container` becomes `MaterialLot.weight_per_unit`, and every pound
 * in the system is derived from it as `full_units * weight_per_unit`. So a drum
 * entered as 200 kg was stored as 200 and read as 200 lb — out by 2.2x in every
 * availability number production schedules against, with nothing to flag it.
 *
 * A mixed store is worse than either unit on its own: every aggregate has to
 * know which row is which, and one missed conversion is silent. One canonical
 * unit removes the question. Existing data agrees — 9 receipts in lbs, none in
 * anything else.
 *
 * Kept as a list rather than deleted so the select, its `required` validation
 * and the weight summary all keep working unchanged.
 */
export const weightUnitOptions = [
  { value: "lbs", label: "Pounds" },
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
  // The receipt that was just saved, when it is one whose units get stickered.
  // THE WALK-IN PATH: material turns up with no incoming order, the worker logs
  // it here off the driver's BOL, then prints stickers and scans the units in on
  // the gun. Printing is not receiving — nothing is in stock until it is scanned
  // into a rack — so this is an offer, never an automatic step.
  const [justLogged, setJustLogged] = useState(null);
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

  const generateLotNumber = useCallback((productionDate, lineId) => {
    const line = productionLines.find(l => l.id === lineId);
    if (!line) return "";
    return generateLotNumberFromLine(productionDate, line.name);
  }, [productionLines]);

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

        // Capacity is a planning hint, never a gate. Every branch below leaves
        // the row selectable — a full or over-full row still gets picked, it
        // just says so. Hiding it was worse than useless: the counter only ever
        // increments, so a drifted row (ROW 1 sat at 501 against a capacity of
        // 22) disappeared from the form permanently, and the entry that would
        // have corrected it was the very thing being refused.
        let fitStatus = '';
        if (totalPalletsNeeded > 0 && available !== null) {
          if (available >= totalPalletsNeeded) {
            fitStatus = 'Can fit all';
          } else if (available > 0) {
            fitStatus = `${available} of ${totalPalletsNeeded} within capacity`;
          } else {
            fitStatus = `Already at ${occupied} of ${capacity} — over capacity`;
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
          canFit: true,
          fitStatus: fitStatus,
        };
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

      // Containers = full pallets x per-pallet + loose. Recomputed on every
      // keystroke in any of the three, so `quantity` — the number every
      // downstream reader uses — is never stale.
      if (["palletCount", "looseCount", "unitsPerPallet", "quantityUnits"].includes(name)) {
        const per = Number(next.unitsPerPallet) || 0;
        if (isPalletisedUnit(next.quantityUnits) && per > 1) {
          const full = Number(next.palletCount) || 0;
          const loose = Number(next.looseCount) || 0;
          next.quantity = String(full * per + loose);
          next.quantityTouched = true;
        } else if (name === "quantityUnits") {
          // Switched to a container that is not palletised — the pallet inputs
          // no longer mean anything, and leaving them would silently keep
          // driving `quantity` from numbers nobody can see.
          next.palletCount = "";
          next.looseCount = "";
        }
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
    if (isIngredient) {
      if (!formData.weightPerUnit || parseFloat(formData.weightPerUnit) <= 0) {
        setFeedback({ type: "error", message: "Weight per container is required for raw material receipts." });
        return;
      }
      if (!formData.weightUnits) {
        setFeedback({ type: "error", message: "Weight unit is required for raw material receipts." });
        return;
      }

      // THE LOT KEY IS `SID.VENDOR.THEIRLOT.BBD`, and two of its four segments
      // were optional here. Both failures are silent and both are expensive.
      //
      // No vendor: `build_lot_key` falls back to an empty segment, so two
      // DIFFERENT suppliers each calling a lot "001" of the same product with
      // the same best-by collapse into ONE lot — and every container of both
      // wears the same sticker. A recall would then trace to the wrong vendor.
      if (!formData.vendorId) {
        setFeedback({
          type: "error",
          message: "Vendor is required — it is part of what makes this lot "
            + "different from another supplier's lot with the same number.",
        });
        return;
      }
      // No best-by: `can_print_labels` refuses outright, so the receipt saves
      // and the stickers cannot be printed. Better to be stopped here, at a
      // keyboard, than at the printer with a pallet waiting.
      if (!formData.expiration) {
        setFeedback({
          type: "error",
          message: "Best-by date is required — stickers cannot be printed "
            + "for a lot without one.",
        });
        return;
      }
      // The BOL is how a delivery is found again in the paperwork when
      // somebody queries it months later.
      if (!(formData.bol && formData.bol.trim())) {
        setFeedback({
          type: "error",
          message: "BOL number is required.",
        });
        return;
      }
      // Only asked for containers that actually ride a pallet — see
      // PALLETISED_UNITS. Required there rather than optional, because a blank
      // silently prints one sticker per bag and reports the rack fifty times
      // over. Loose bags are entered as 1.
      if (isPalletisedUnit(formData.quantityUnits)) {
        const per = Number(formData.unitsPerPallet);
        if (!per || per < 1 || !Number.isInteger(per)) {
          setFeedback({
            type: "error",
            message: `How many ${formData.quantityUnits} come on one pallet? `
              + "Enter 1 if they arrive loose rather than wrapped.",
          });
          return;
        }
        // `quantity` is DERIVED here from full pallets plus loose, so neither
        // input carries the browser's `required` — an empty entry would sail
        // past it as a silent zero-container receipt.
        if (!(Number(formData.quantity) > 0)) {
          setFeedback({
            type: "error",
            message: `How many arrived? Enter the full pallets, the loose `
              + `${formData.quantityUnits}, or both.`,
          });
          return;
        }
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

        // Capacity is deliberately NOT checked here. It is a planning hint, the
        // warehouse decides what fits, and refusing an over-capacity row made a
        // drifted counter permanent by blocking the correction.

        // Containers per row, on the other hand, must add up — a placement
        // counts units, and a wrong split puts real drums on the wrong rack.
        // Only asked when several rows share the load; one row holds everything.
        if (rawMaterialRowAllocations.length > 1 && Number(formData.quantity) > 0) {
          const totalUnits = rawMaterialRowAllocations.reduce(
            (sum, alloc) => sum + (Number(alloc.units) || 0), 0
          );
          if (totalUnits !== Number(formData.quantity)) {
            const word = formData.quantityUnits || "units";
            setFeedback({
              type: "error",
              message: `The ${word} placed across the rows (${totalUnits}) must equal the total received (${formData.quantity}).`,
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
      // Only sent when it means something. A 1 would claim "one bag per pallet",
      // which is what a barrel already is, and would switch on pallet stickers
      // for material that does not come on pallets.
      unitsPerPallet: Number(formData.unitsPerPallet) > 1
        ? parseInt(formData.unitsPerPallet, 10)
        : null,
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
            // How many containers sit on THIS row — what a placement counts.
            // Pallets describe the footprint and cannot stand in for it: a row
            // holding 4 pallets of drums says nothing about whether that is 40
            // drums or 70. Left at 0 when a single row holds everything, where
            // the backend takes the whole container count and is exact.
            units: Number(alloc.units) || 0,
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
      // Offer stickers when this receipt counts UNITS — drums, bags, totes. The
      // count comes from what the worker typed, not from the weight: weight is
      // derived from units and never the other way round, because different
      // vendors ship different weights per drum.
      // camelCase — `submitReceipt` returns the receipt already mapped by
      // ReceiptContext.mapReceipt, which has no snake_case keys at all. Reading
      // `container_count` here yields undefined -> NaN -> 0, so the offer would
      // never render, and since printing is the only thing that resolves the
      // lot, the walk-in path would silently have no way to produce stickers.
      const loggedCount = Number(
        result.receipt?.containerCount ?? result.receipt?.container_count,
      ) || 0;
      setJustLogged(
        result.receipt?.id && loggedCount > 0
          ? {
              receiptId: result.receipt.id,
              count: loggedCount,
              unitLabel: result.receipt.containerUnit
                || result.receipt.container_unit || 'unit',
              // Carried so the print dialog can offer pallet stickers straight
              // away for bags, rather than only ever the per-container run.
              unitsPerPallet: result.receipt.unitsPerPallet
                || result.receipt.units_per_pallet || null,
              productName: result.receipt.productName || '',
            }
          : null,
      );
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
    justLogged,
    setJustLogged,
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
