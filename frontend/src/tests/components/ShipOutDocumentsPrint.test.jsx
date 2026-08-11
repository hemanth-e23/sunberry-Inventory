/**
 * The BOL must print on ONE A4 page. Not "usually" — on the warehouse's actual
 * printer, whose margins are not the 8mm the CSS politely asks for.
 *
 * This is a real print test: it renders the real component with the real CSS,
 * drives headless Chrome to produce an actual A4 PDF, and counts the pages in
 * it. jsdom cannot do this — it has no layout engine, so it cannot tell you a
 * document is 3mm too tall.
 *
 * Why it exists: `.sod-bol { zoom }` was previously tuned by eye against one
 * sample document and hardcoded. It fit with 19px to spare, so any printer
 * taking slightly more margin than 8mm pushed the last row onto page 2 — and
 * every attempt to fix it by nudging the number regressed later for the same
 * reason. The margin sweep below turns "it fits on my machine" into a number.
 *
 * Skips (does not fail) when Chrome is absent, so it never blocks a machine
 * that cannot run it. Set CHROME_PATH to point at a different binary.
 */
/* global process, __dirname */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ShipOutDocuments from '../../components/ShipOutDocuments.jsx';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));

// The worst printer we promise to support. Raised from 18mm to 24mm after a
// real Kyocera on "Margins: Default" still produced 2 pages at a zoom that
// passed the 18mm check — the browser's print dialog reserves space for
// headers/footers on top of the paper's own unprintable area, so the real
// budget is well below what @page asks for. 24mm leaves a 941px-tall box.
const WORST_CASE_MARGIN_MM = 24;

const SNAPSHOT = {
  bol_number: '08500395250036147',
  // Shapes mirror _SHIP_FROM / _BILL_TO in backend/app/services/ship_out_service.py
  // — these are the widest real values, so the test measures the tallest header.
  ship_from: {
    name: 'SUNBERRY PAW PAW BEVERAGES LIMITED LLC',
    address: '815 S KALAMAZOO ST', city_state_zip: 'PAW PAW, MI 49079',
  },
  bill_to: {
    name: 'SUNBERRY LIMITED, LLC',
    lines: ['PO BOX 426', 'BRIGHTON MI 48116 US'],
  },
  ship_to: {
    customer_name: 'MEIJER DISTRIBUTION CENTER', location_name: 'Lansing DC #7',
    address_line1: '3737 Lake Lansing Road', address_line2: 'Dock 14, Receiving Gate B',
    city: 'Lansing', state: 'MI', zip_code: '48912',
  },
  order_number: '07-12782', po_number: '10520612207', carrier: 'IIK TRANSPORT',
  appointment_time: '08:30', ship_date: '2026-08-07',
  total_cases: 1290, pallet_count: 33,
  weight: { product: 15996, pallets: 1980, total: 17976 },
  nmfc: '150340', freight_class: '85', freight_description: 'FROZEN FRUIT PRODUCTS, NOI',
  driver_name: 'Marcus Ellery', driver_license: 'MI-D4471982',
  truck_number: 'T-118', truck_license: 'MI 88213F',
  trailer_number: 'TR-4402', trailer_license: 'MI 55190T', seal_number: 'SL0099431',
  time_in: '2026-08-07T08:34:00Z', time_out: '2026-08-07T11:02:00Z', ship_short: false,
  slip_lines: Array.from({ length: 9 }, (_, i) => ({
    order_number: '07-12782', po_number: '10520612207',
    item: `GVN128${i}`, description: `Guava Nectar 12/8oz — Batch ${i}`,
    quantity: 120 + i * 7, uom: 'CS', lot_number: `MP14${i}26L1`,
  })),
};


// Long real-world values. The form's tables have fixed blank rows, so line
// COUNT does not change its height — but long text WRAPS, and a wrapped cell
// grows the row. That is the one way live data can push this to page 2, so it
// gets its own case rather than being assumed away.
const LONG = {
  ...SNAPSHOT,
  order_number: '07-12782-REVISED-SUPERSEDES-07-12604',
  po_number: '10520612207 / 10520612208 / 10520612209',
  carrier: 'DOUBLE G LOGISTICS AND REFRIGERATED TRANSPORT SERVICES LLC',
  ship_to: {
    customer_name: 'MEIJER DISTRIBUTION CENTER — MIDWEST REGIONAL COLD STORAGE FACILITY',
    location_name: 'Lansing Distribution Center #7, Refrigerated Receiving Annex B',
    address_line1: '3737 Lake Lansing Road, Building C, Loading Dock Complex North',
    address_line2: 'Gate 14 — Refrigerated Receiving, Appointment Required, Ask for Foreman',
    city: 'Lansing Charter Township', state: 'MI', zip_code: '48912-4471',
  },
  driver_name: 'Bartholomew Fitzgerald-Understein Jr.',
  driver_license: 'MI-D4471982-CDL-CLASS-A-HAZMAT',
  trailer_number: 'TR-4402-REEFER-53FT', seal_number: 'SL0099431-VERIFIED',
  slip_lines: Array.from({ length: 9 }, (_, i) => ({
    order_number: '07-12782', po_number: '10520612207',
    item: `GVN128${i}`,
    description: `Guava Nectar 12/8oz Glass Bottle Case — Organic Cold Pressed Batch ${i} (Retail Ready Display Pack)`,
    quantity: 120 + i * 7, uom: 'CS', lot_number: `MP14${i}26L1-EXTENDED`,
  })),
};

const pdfPageCount = (bytes) => (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

/** Mount the component, switch to the BOL tab the way a user does, return its HTML. */
async function bolMarkup() {
  const { container, unmount } = render(<ShipOutDocuments snapshot={SNAPSHOT} />);
  await userEvent.click(screen.getByRole('button', { name: /bill of lading/i }));
  const bol = container.querySelector('.sod-bol');
  if (!bol) throw new Error('BOL tab did not render — has the markup changed?');
  // The component emits its own `<style>@page { ... margin: 8mm }</style>`
  // (ShipOutDocuments.jsx). Left in place it lands AFTER the test's page rule
  // and silently wins, so every margin we "tested" would really be 8mm and the
  // test would pass even against a layout that overflows on a real printer.
  // Strip it here and let the test own the page box.
  const html = container.innerHTML.replace(/<style>[^<]*@page[^<]*<\/style>/g, '');
  if (html.includes('@page')) throw new Error('component @page rule not stripped');
  unmount();
  return html;
}

function renderBolPdf(markup, marginMm) {
  const dir = mkdtempSync(join(tmpdir(), 'bol-print-'));
  const css = readFileSync(
    resolve(__dirname, '../../components/ShipOutDocuments.css'), 'utf8',
  );
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif}</style>
<style>@page { size: A4 portrait; margin: ${marginMm}mm; }</style>
<style>${css}</style></head><body>${markup}</body></html>`;

  const htmlPath = join(dir, 'bol.html');
  const pdfPath = join(dir, 'bol.pdf');
  writeFileSync(htmlPath, html);
  execFileSync(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=3000',
    `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], { stdio: 'ignore' });
  return readFileSync(pdfPath);
}

describe.skipIf(!chrome)('Bill of Lading print layout', () => {
  it(`fits one A4 page even with ${WORST_CASE_MARGIN_MM}mm printer margins`, async () => {
    const markup = await bolMarkup();
    // Guard: an empty render would sail through a "is it 1 page" assertion.
    expect(markup).toContain(SNAPSHOT.bol_number);
    expect(markup).toContain('BILL OF LADING');

    const pages = pdfPageCount(renderBolPdf(markup, WORST_CASE_MARGIN_MM));
    expect(pages).toBe(1);
  }, 60_000);

  it('still fits one page when every field holds a long value', async () => {
    const { container, unmount } = render(<ShipOutDocuments snapshot={LONG} />);
    await userEvent.click(screen.getByRole('button', { name: /bill of lading/i }));
    const markup = container.innerHTML.replace(/<style>[^<]*@page[^<]*<\/style>/g, '');
    unmount();
    expect(markup).toContain('DOUBLE G LOGISTICS');
    expect(pdfPageCount(renderBolPdf(markup, WORST_CASE_MARGIN_MM))).toBe(1);
  }, 60_000);

  it('still fits at the 8mm the stylesheet asks for', async () => {
    expect(pdfPageCount(renderBolPdf(await bolMarkup(), 8))).toBe(1);
  }, 60_000);
});
