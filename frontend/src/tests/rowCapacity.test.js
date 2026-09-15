/**
 * A rack's capacity means whatever its ROOM counts in.
 *
 * Apple Barn holds drums — `storage_unit = 'drum'`, `unit_capacity = 88` per
 * row — and its occupancy is counted in drums, because for a barrel the
 * container IS the thing on the shelf: one drum, one slot. Its rows also still
 * carry `pallet_capacity = 22` from when the barn was racked for pallets.
 *
 * Reading that leftover 22 while occupancy counts drums produced two visible
 * lies at once:
 *
 *   * every row in the transfer picker read "0 of 22 spaces free", including
 *     ROW 17 sitting at 32 of 88 with room for 56 more
 *   * the raw-materials utilisation card read ~94%, because the summary clamps
 *     occupancy to capacity and every drum rack clamped to "full"
 *
 * The numbers below are the real ones from Apple Barn on 2026-09-15.
 */
import { describe, it, expect } from 'vitest'
import { rowCapacityInfo, buildRowUnitLookup } from '../utils/rowSources'

const appleBarn = { storageUnit: 'drum', unitCapacity: 88 }
const palletRoom = { storageUnit: null, unitCapacity: null }

describe('rowCapacityInfo', () => {
  it('uses the room container capacity for a drum room, not the row pallet figure', () => {
    // ROW 17: 32 drums in, pallet_capacity still 22 from the pallet era.
    const info = rowCapacityInfo(appleBarn, { palletCapacity: 22, occupiedPallets: 32 })

    expect(info.capacity).toBe(88)
    expect(info.free).toBe(56)          // was reporting 0
    expect(info.unit).toBe('drums')
    expect(info.typed).toBe(true)
  })

  it('does not report an over-filled rack as negative', () => {
    // Over-filling is legal — capacity is a soft hint — but "-4 free" is not
    // something a warehouse can act on.
    const info = rowCapacityInfo(appleBarn, { palletCapacity: 22, occupiedPallets: 92 })
    expect(info.free).toBe(0)
  })

  it('leaves pallet rooms exactly as they were', () => {
    const info = rowCapacityInfo(palletRoom, { palletCapacity: 20, occupiedPallets: 8 })

    expect(info.capacity).toBe(20)
    expect(info.free).toBe(12)
    expect(info.unit).toBe('pallets')
    expect(info.typed).toBe(false)
  })

  it('returns null free when nothing states a capacity', () => {
    // The backend spells "no opinion" as pallet_capacity = 0. Showing a
    // fabricated zero would read as "full".
    const info = rowCapacityInfo(palletRoom, { palletCapacity: 0, occupiedPallets: 0 })
    expect(info.free).toBeNull()
  })

  it('pluralises the room unit without doubling an s', () => {
    expect(rowCapacityInfo({ storageUnit: 'drum', unitCapacity: 10 }, {}).unit).toBe('drums')
    expect(rowCapacityInfo({ storageUnit: 'drums', unitCapacity: 10 }, {}).unit).toBe('drums')
    expect(rowCapacityInfo({ storageUnit: 'bag', unitCapacity: 10 }, {}).unit).toBe('bags')
  })

  it('stops a nearly-full drum rack reporting as full', () => {
    // ROW 18 holds 84 of 88. Against the old 22 it clamped to "22 of 22",
    // which is what drove the headline utilisation to 94%.
    const info = rowCapacityInfo(appleBarn, { palletCapacity: 22, occupiedPallets: 84 })

    expect(Math.min(info.capacity, info.occupied)).toBe(84)   // was 22
    expect(info.free).toBe(4)
  })
})

describe('buildRowUnitLookup', () => {
  // The exact shape of `locationsTree` from LocationContext.
  const tree = [{
    id: 'loc-paw-paw',
    name: 'Sunberry Paw Paw',
    subLocations: [
      { id: 'sub-apple', name: 'Apple Barn', storageUnit: 'drum', unitCapacity: 88,
        rows: [{ id: 'row-14', name: 'ROW 14', palletCapacity: 22, occupiedPallets: 78 }] },
      { id: 'sub-dry', name: 'Dry Store', storageUnit: null, unitCapacity: null,
        rows: [{ id: 'row-d1', name: 'D1', palletCapacity: 20, occupiedPallets: 3 }] },
    ],
  }]

  it('resolves each rack to its room unit', () => {
    const map = buildRowUnitLookup(tree)
    expect(map['row-14']).toBe('drums')
    expect(map['row-d1']).toBe('pallets')
  })

  it('returns EMPTY for the flat dropdown list — the trap this exists to catch', () => {
    // `locations` on the same context is locationOptions: [{id, name}] with no
    // subLocations. Walking it throws nothing and finds nothing, so every rack
    // silently falls back to the default — which kept a drum room printing
    // "20 pallets" through three rounds of fixes aimed at the right code.
    const flat = [{ id: 'loc-paw-paw', name: 'Sunberry Paw Paw' }]
    expect(buildRowUnitLookup(flat)).toEqual({})
  })

  it('survives missing branches rather than throwing', () => {
    expect(buildRowUnitLookup()).toEqual({})
    expect(buildRowUnitLookup([{ id: 'l', subLocations: [{ id: 's' }] }])).toEqual({})
  })
})
