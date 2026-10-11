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
import re
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject, TextStringObject

from app.exceptions import ValidationError
from app.utils.warehouse_time import zone

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


def _fmt_time(iso: Optional[str], tz_name: Optional[str] = None) -> str:
    """Wall-clock time at the warehouse. Snapshots store time_out as UTC
    (`datetime.now(timezone.utc).isoformat()`); printed raw it read 00:20 for
    a trailer that left at 7:20 PM. A naive value is printed as given."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return str(iso)
    if d.tzinfo is not None and tz_name:
        d = d.astimezone(zone(tz_name))
    return d.strftime("%H:%M:%S")


# Smallest font a value may shrink to before it is allowed to clip.
_MIN_FONT_SIZE = 5.0
_DA_SIZE_RE = re.compile(r"(/\S+)\s+([\d.]+)\s+Tf")


def _helvetica_bold_width(text: str, size: float) -> float:
    """Width in points of `text` in Helvetica-Bold (the template's /HeBo)."""
    try:
        from pypdf._codecs.core_font_metrics import CORE_FONT_METRICS
        widths = CORE_FONT_METRICS["Helvetica-Bold"].character_widths
        default = widths.get("default", 600)
        units = sum(widths.get(ch, default) for ch in text)
    except Exception:  # noqa: BLE001 — private pypdf table; estimate if it moves
        units = 611 * len(text)
    return units * size / 1000.0


def _fit_font_sizes(writer: PdfWriter, values: dict) -> None:
    """Shrink a field's font so its value fits the box instead of clipping.

    The template prints every field in 9pt bold. A shuttle line's "product
    (item code) · N PAL" or a long consignee name runs past the box edge and
    the viewer cuts it off mid-word. Only fields that would overflow change;
    everything that fits keeps the template's own size. Must run before the
    values are filled, because pypdf builds the appearance from /DA."""
    for page in writer.pages:
        for ref in page.get("/Annots") or []:
            annot = ref.get_object()
            name = annot.get("/T")
            text = values.get(name) if name else None
            da = annot.get("/DA")
            if not text or not da or "/Rect" not in annot:
                continue
            m = _DA_SIZE_RE.search(str(da))
            if not m:
                continue
            size = float(m.group(2))
            rect = [float(x) for x in annot["/Rect"]]
            room = abs(rect[2] - rect[0]) - 4  # the viewer's 2pt inner padding each side
            need = _helvetica_bold_width(str(text), size)
            if size <= 0 or room <= 0 or need <= room:
                continue
            fitted = max(_MIN_FONT_SIZE, round(size * room / need, 1))
            annot[NameObject("/DA")] = TextStringObject(
                _DA_SIZE_RE.sub(f"{m.group(1)} {fitted:g} Tf", str(da), count=1)
            )


def _num(v) -> str:
    """Whole numbers print without a trailing .0 — the form is not a spreadsheet."""
    if v in (None, ""):
        return ""
    f = float(v)
    return str(int(f)) if f == int(f) else f"{f:.1f}"


def build_field_values(snapshot: dict, tz_name: Optional[str] = None) -> dict:
    """Map a frozen document_snapshot onto the template's field names.
    tz_name: the shipping warehouse's timezone, for Time In / Time Out."""
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
        dict.fromkeys(
            p for p in (ship_to.get("customer_name"), ship_to.get("location_name")) if p
        )
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
        "timeIn": _fmt_time(snapshot.get("time_in"), tz_name),
        "timeOut": _fmt_time(snapshot.get("time_out"), tz_name),
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
    # Moyel shuttle snapshots carry their own customer-order rows: "Lot: <lot>"
    # as the order no, product + item code in additional info, up to the
    # template's 3 rows (FG-PALLET-LIFECYCLE-SPEC §1.1). Ship-out snapshots
    # have no `order_rows` and keep the single summary row above.
    order_rows = snapshot.get("order_rows")
    if order_rows:
        for i in range(1, MAX_ORDER_ROWS + 1):
            row = order_rows[i - 1] if i <= len(order_rows) else {}
            values[f"orderNo{i}"] = row.get("order_no") or ""
            values[f"qty{i}"] = _num(row.get("qty"))
            values[f"weight{i}"] = _num(row.get("weight"))
            values[f"additionalInfo{i}"] = row.get("info") or ""
    return {k: (v if v is not None else "") for k, v in values.items()}


def render_bol_pdf(snapshot: dict, tz_name: Optional[str] = None) -> bytes:
    """Fill the template from a frozen snapshot and return PDF bytes.
    tz_name: the shipping warehouse's timezone (Time In / Time Out)."""
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

    values = build_field_values(snapshot, tz_name)
    _fit_font_sizes(writer, values)
    for page in writer.pages:
        writer.update_page_form_field_values(page, values, auto_regenerate=False)

    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()
