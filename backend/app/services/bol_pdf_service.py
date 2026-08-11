"""Render the Bill of Lading as a PDF by filling Sunberry's own form template.

WHY A TEMPLATE AND NOT A LAYOUT
The BOL used to be printed from the browser (ShipOutDocuments.jsx + window.print).
That makes the document's geometry depend on things we do not control: the
printer's unprintable margin, whether the print dialog has headers/footers on,
how long the consignee's address happens to be. The form is a fixed-height
design, so any of those pushed the last row onto a second page — the failure the
warehouse hit for months, and which no amount of tuning the CSS `zoom` could
fix, because a shape mismatch is not a size problem.

`assets/bol_template.pdf` is Sunberry's actual BOL — an AcroForm with 69 named
fields — with its values cleared. Filling it means the output IS the original
form: identical geometry on every machine, every browser, every printer, and
byte-reproducible for a reprint of a document that has already shipped.

The template is US Letter, matching every BOL Sunberry has issued.
"""
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject

from app.exceptions import ValidationError

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "assets" / "bol_template.pdf"

# The template has fixed row slots: 3 customer-order rows, 2 handling-unit rows.
# Orders with more products than that collapse into one summary row — which is
# what the reference BOL (Orders.pdf) does: 22 PAL / 1100 CS on a single line,
# with the per-lot detail living on the packing slip that travels with it.
MAX_ORDER_ROWS = 3


def _fmt_date(iso: Optional[str]) -> str:
    """ISO date -> M/D/YYYY, the format every previous BOL used."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return f"{d.month}/{d.day}/{d.year}"


def _fmt_time(iso: Optional[str]) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return str(iso)
    return d.strftime("%H:%M:%S")


def _num(v) -> str:
    """Whole numbers print without a trailing .0 — the form is not a spreadsheet."""
    if v in (None, ""):
        return ""
    f = float(v)
    return str(int(f)) if f == int(f) else f"{f:.1f}"


def build_field_values(snapshot: dict) -> dict:
    """Map a frozen document_snapshot onto the template's field names."""
    ship_to = snapshot.get("ship_to") or {}
    ship_from = snapshot.get("ship_from") or {}
    weight = snapshot.get("weight") or {}

    city_state_zip = ", ".join(
        p for p in (ship_to.get("city"), ship_to.get("state"), ship_to.get("zip_code")) if p
    )
    address = ", ".join(
        p for p in (ship_to.get("address_line1"), ship_to.get("address_line2")) if p
    )
    # Customer name is the consignee; the location name disambiguates which of
    # their sites, so both belong on the document.
    consignee = " — ".join(
        p for p in (ship_to.get("customer_name"), ship_to.get("location_name")) if p
    )

    total_cases = snapshot.get("total_cases") or 0
    pallets = snapshot.get("pallet_count") or 0
    po = (snapshot.get("po_number") or "").strip()

    values = {
        "bolDate": _fmt_date(snapshot.get("ship_date")),
        "bolNo": snapshot.get("bol_number") or "",

        "shipperName": ship_from.get("name", ""),
        "shipperAddress": ship_from.get("address", ""),
        "shipperCityStateZip": ship_from.get("city_state_zip", ""),

        "shipToName": consignee,
        "shipToAddress": address,
        "shipToCityStateZip": city_state_zip,

        "carrierName": snapshot.get("carrier") or "",
        "trailerNo": snapshot.get("trailer_number") or "",
        "sealNo": snapshot.get("seal_number") or "",

        # One summary row: the packing slip carries the per-lot breakdown.
        "orderNo1": snapshot.get("order_number") or "",
        "qty1": _num(total_cases),
        "weight1": _num(weight.get("product")),
        "additionalInfo1": f"PO: {po}" if po else "",
        "qtyTotal": _num(total_cases),
        "weightTotal": _num(weight.get("product")),

        # Handling units: pallets on row 1, cases on row 2 (mirrors the original).
        "huQty1": _num(pallets),
        "huType1": "PAL" if pallets else "",
        "huWeight1": _num(weight.get("pallets")),
        "packQty2": _num(total_cases),
        "packType2": "CS" if total_cases else "",
        "huWeight2": _num(weight.get("product")),
        "huWeightTotal": _num(weight.get("total")),
        "descArticles2": snapshot.get("freight_description") or "",
        "nmfcNo1": snapshot.get("nmfc") or "",
        "nmfcNo2": snapshot.get("nmfc") or "",
        "nmfcClass1": snapshot.get("freight_class") or "",
        "nmfcClass2": snapshot.get("freight_class") or "",

        # Carrier info validation stamp.
        "dateShipped": _fmt_date(snapshot.get("ship_date")),
        "appointmentTime": snapshot.get("appointment_time") or "",
        "timeIn": _fmt_time(snapshot.get("time_in")),
        "timeOut": _fmt_time(snapshot.get("time_out")),
        "tractorLicenseNo": snapshot.get("truck_license") or "",
        "trailerLicenseNo": snapshot.get("trailer_license") or "",
        "driversLicenseNo": snapshot.get("driver_license") or "",
        "driverName": snapshot.get("driver_name") or "",
        "totalCasesShipped": _num(total_cases),
        "carrierOther": snapshot.get("carrier") or "",

        "specialInstructions": (
            "SHIPPED SHORT OF ORDERED QUANTITY." if snapshot.get("ship_short") else ""
        ),
    }
    return {k: (v if v is not None else "") for k, v in values.items()}


def render_bol_pdf(snapshot: dict) -> bytes:
    """Fill the template from a frozen snapshot and return PDF bytes."""
    if not snapshot:
        raise ValidationError("This order has no generated documents to print.")
    if not TEMPLATE_PATH.exists():
        raise ValidationError(f"BOL template missing at {TEMPLATE_PATH}")

    reader = PdfReader(str(TEMPLATE_PATH))
    writer = PdfWriter(clone_from=reader)

    # Without /NeedAppearances, viewers that don't build appearance streams
    # themselves show a form that looks blank — the values are in the file but
    # nobody draws them. This is the difference between a working BOL and a
    # sheet of empty boxes at the loading dock.
    acro = writer._root_object.get("/AcroForm")
    if acro is not None:
        acro[NameObject("/NeedAppearances")] = BooleanObject(True)

    values = build_field_values(snapshot)
    for page in writer.pages:
        writer.update_page_form_field_values(page, values, auto_regenerate=False)

    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()
