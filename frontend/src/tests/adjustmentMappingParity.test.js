/**
 * The two adjustment mappings must agree on their fields.
 *
 * InventoryContext builds an adjustment object twice: once from the list fetch
 * on page load, and once from the create response. They drifted — the list
 * mapping dropped `pallet_licence_ids` while the create mapping kept it.
 *
 * The result was a state that depended on how you got there. Submit an
 * adjustment and it had its pallets; reload the page and the same adjustment
 * did not. The approvals card uses that field to tell a pallet-based Finished
 * Goods adjustment from a lot-based one, so after a reload every FG card lost
 * its lot, its quantity panel, and its product name.
 *
 * This is the kind of bug component tests cannot catch: the card was correct
 * and well covered, but was handed data missing a field. Comparing the two
 * mappings catches the drift at its source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, '../context/domains/InventoryContext.jsx'),
  'utf8'
);

/** Keys of the first object literal inside `block`. */
const keysIn = (block) => {
  const keys = new Set();
  for (const m of block.matchAll(/^\s{6,}(\w+):/gm)) keys.add(m[1]);
  return keys;
};

const between = (start, end) => {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to, `end anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('adjustment API → state mapping', () => {
  const listBlock = between(
    "apiClient.get('/inventory/adjustments')",
    'setInventoryAdjustments(adjustments)'
  );
  const createBlock = between('const newAdjustment = {', 'setInventoryAdjustments((prev)');

  it('the list mapping carries pallet ids', () => {
    // The field this bug turned on. Named explicitly so a future edit that
    // removes it fails with an obvious message rather than a set difference.
    expect(keysIn(listBlock)).toContain('palletLicenceIds');
  });

  it('the create mapping carries pallet ids', () => {
    expect(keysIn(createBlock)).toContain('palletLicenceIds');
  });

  it('neither mapping has a field the other lacks', () => {
    const list = keysIn(listBlock);
    const create = keysIn(createBlock);

    const missingFromList = [...create].filter((k) => !list.has(k));
    const missingFromCreate = [...list].filter((k) => !create.has(k));

    expect(missingFromList, 'list mapping is missing fields the create mapping sets').toEqual([]);
    expect(missingFromCreate, 'create mapping is missing fields the list mapping sets').toEqual([]);
  });
});
