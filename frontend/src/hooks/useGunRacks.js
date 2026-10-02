import { useCallback, useEffect, useState } from 'react';
import { listIngredientRows } from '../api/ingredientIntakeApi';
import { getRackFill } from '../api/lotReceivingApi';
import {
  RACK_FILL_CACHE_KEY, RACK_FILL_UNITS_CACHE_KEY, RACKS_CACHE_KEY, readCached, saveCached,
} from '../utils/gunCache';
import { rackFillMap } from '../utils/truckReceiving';
import { rackFillUnitsMap } from '../utils/stagingPull';

/**
 * The rack list and how full each rack is, for the gun's scan screens.
 *
 * Both are kept on the device: offline, the rack list is the only way to turn
 * a scanned rack label into a rack (barcode equality), and a reload while the
 * wifi was down used to leave it empty (browser test U1). The fill is what the
 * picker shows as "11/12 drums" (U10); it is refreshed whenever the picker
 * opens and after every booking the caller chooses to refresh on.
 */
export const useGunRacks = () => {
  const [rows, setRows] = useState(() => readCached(RACKS_CACHE_KEY)?.data || []);
  const [fill, setFill] = useState(() => readCached(RACK_FILL_CACHE_KEY)?.data || {});
  // Per container word ("3 drums · 12 bags") — PART 3, B9. Additive.
  const [fillByUnit, setFillByUnit] = useState(
    () => readCached(RACK_FILL_UNITS_CACHE_KEY)?.data || {},
  );
  const [fillSavedAt, setFillSavedAt] = useState(
    () => readCached(RACK_FILL_CACHE_KEY)?.savedAt || null,
  );

  useEffect(() => {
    let cancelled = false;
    listIngredientRows()
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setRows(data);
        saveCached(RACKS_CACHE_KEY, data);
      })
      .catch(() => { /* keep the cached list */ });
    return () => { cancelled = true; };
  }, []);

  const refreshFill = useCallback(() => getRackFill()
    .then((data) => {
      const map = rackFillMap(data);
      const byUnit = rackFillUnitsMap(data);
      setFill(map);
      setFillByUnit(byUnit);
      setFillSavedAt(Date.now());
      saveCached(RACK_FILL_CACHE_KEY, map);
      saveCached(RACK_FILL_UNITS_CACHE_KEY, byUnit);
    })
    .catch(() => { /* keep the last fill we saw */ }), []);

  useEffect(() => { refreshFill(); }, [refreshFill]);

  return {
    rows, setRows, fill, fillByUnit, fillSavedAt, refreshFill,
  };
};
