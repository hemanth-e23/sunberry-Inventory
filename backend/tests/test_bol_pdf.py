"""The BOL PDF is filled from Sunberry's own form template, not laid out by us.

These tests guard the two things that can silently break it: a field name in the
template drifting away from the mapping (values land nowhere and the BOL prints
blank), and the /NeedAppearances flag going missing (values are in the file but
no viewer draws them — a sheet of empty boxes at the loading dock).
"""
import pytest
from pypdf import PdfReader
from io import BytesIO

from app.services import bol_pdf_service
from app.exceptions import ValidationError


SNAPSHOT = {
    "bol_number": "08500395250050001",
    "ship_from": {
        "name": "SUNBERRY PAW PAW BEVERAGES LIMITED LLC",
        "address": "815 S KALAMAZOO ST", "city_state_zip": "PAW PAW, MI 49079",
    },
    "bill_to": {"name": "SUNBERRY LIMITED, LLC", "lines": ["PO BOX 426", "BRIGHTON MI 48116 US"]},
    "ship_to": {
        "customer_name": "MEIJER DISTRIBUTION CENTER", "location_name": "Lansing DC #7",
        "address_line1": "3737 Lake Lansing Road", "address_line2": "Dock 14",
        "city": "Lansing", "state": "MI", "zip_code": "48912",
    },
    "order_number": "07-12782", "po_number": "10520612207", "carrier": "IIK TRANSPORT",
    "appointment_time": "01:00 PM", "ship_date": "2026-08-11",
    "total_cases": 1100, "pallet_count": 22,
    "weight": {"product": 41250, "pallets": 1320, "total": 42570},
    "nmfc": "73227", "freight_class": "60",
    "freight_description": "FOODSTUFF OTHER THAN FROZEN",
    "driver_name": "Hemanth Egk", "driver_license": "68246",
    "truck_license": "456", "trailer_license": "821",
    "trailer_number": "TR-4402", "seal_number": "SL0099431",
    "time_in": "2026-08-11T10:50:51", "time_out": "2026-08-11T13:33:00",
    "ship_short": False,
}


def _fields(pdf_bytes):
    return {k: (v.get("/V") or "") for k, v in PdfReader(BytesIO(pdf_bytes)).get_fields().items()}


def test_template_exists_and_is_blank():
    """A template shipped with last order's data would leak it onto every BOL."""
    assert bol_pdf_service.TEMPLATE_PATH.exists(), "BOL template missing from app/assets"
    blank = PdfReader(str(bol_pdf_service.TEMPLATE_PATH)).get_fields()
    filled = {k: v.get("/V") for k, v in blank.items() if str(v.get("/V") or "").strip()}
    assert filled == {}, f"template ships with data in it: {filled}"


def test_renders_a_single_page_pdf():
    pdf = bol_pdf_service.render_bol_pdf(SNAPSHOT)
    assert pdf.startswith(b"%PDF"), "not a PDF"
    reader = PdfReader(BytesIO(pdf))
    assert len(reader.pages) == 1, "the BOL must never be more than one page"


def test_every_mapped_field_exists_in_the_template():
    """Catches a mapping key that no longer matches a field name — otherwise the
    value is silently dropped and that box prints empty."""
    template_names = set(PdfReader(str(bol_pdf_service.TEMPLATE_PATH)).get_fields())
    mapped = set(bol_pdf_service.build_field_values(SNAPSHOT))
    unknown = mapped - template_names
    assert not unknown, f"mapping targets fields the template does not have: {sorted(unknown)}"


def test_key_values_land_on_the_document():
    got = _fields(bol_pdf_service.render_bol_pdf(SNAPSHOT))
    assert got["bolNo"] == "08500395250050001"
    assert got["carrierName"] == "IIK TRANSPORT"
    assert got["sealNo"] == "SL0099431"
    assert got["orderNo1"] == "07-12782"
    assert got["driverName"] == "Hemanth Egk"
    assert got["additionalInfo1"] == "PO: 10520612207"
    assert got["shipToCityStateZip"] == "Lansing, MI, 48912"
    assert "MEIJER DISTRIBUTION CENTER" in got["shipToName"]
    # Whole numbers must not print as "1100.0" on a legal document.
    assert got["qty1"] == "1100"
    assert got["huWeightTotal"] == "42570"
    assert got["dateShipped"] == "8/11/2026"
    assert got["timeIn"] == "10:50:51"


def test_need_appearances_is_set():
    """Without it, several viewers render the form blank."""
    reader = PdfReader(BytesIO(bol_pdf_service.render_bol_pdf(SNAPSHOT)))
    acro = reader.trailer["/Root"]["/AcroForm"]
    assert bool(acro.get("/NeedAppearances")) is True


def test_ship_short_is_called_out():
    got = _fields(bol_pdf_service.render_bol_pdf({**SNAPSHOT, "ship_short": True}))
    assert "SHORT" in got["specialInstructions"].upper()


def test_missing_optional_data_does_not_crash():
    """A scheduled order created with only the required fields still prints."""
    bare = {
        "bol_number": "08500395250050002", "order_number": "07-99999",
        "ship_date": "2026-08-11", "total_cases": 40, "pallet_count": 1,
        "weight": {}, "ship_to": None, "ship_from": {},
    }
    got = _fields(bol_pdf_service.render_bol_pdf(bare))
    assert got["bolNo"] == "08500395250050002"
    assert got["shipToName"] == ""          # blank, not "None"
    assert got["additionalInfo1"] == ""     # no PO -> no stray "PO: " label


def test_empty_snapshot_is_rejected():
    with pytest.raises(ValidationError):
        bol_pdf_service.render_bol_pdf({})
