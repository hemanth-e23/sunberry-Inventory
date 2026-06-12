"""
Regression test — Phase 2 Task 2.4.

The adjustments audit report used to sum cases + lbs + units into one
total_quantity. It now carries a unit per row and groups totals by unit.
"""
import pytest
from app.models import Category, CategoryGroup, Product, Receipt, InventoryAdjustment
from app.services.report_builders import build_adjustments_report


@pytest.mark.integration
def test_adjustments_report_groups_totals_by_unit(db_session):
    db_session.add(CategoryGroup(id="grp", name="G"))
    db_session.add(Category(id="cat-fg", name="FG", type="finished", parent_id="grp"))
    db_session.add(Category(id="cat-raw", name="Raw", type="raw", parent_id="grp"))
    db_session.add(Product(id="p-fg", name="Boxed", category_id="cat-fg"))
    db_session.add(Product(id="p-raw", name="Concentrate", category_id="cat-raw"))
    db_session.add(Receipt(id="r-fg", product_id="p-fg", category_id="cat-fg",
                           quantity=100, unit="cases", status="approved"))
    db_session.add(Receipt(id="r-raw", product_id="p-raw", category_id="cat-raw",
                           quantity=5000, unit="lbs", status="approved"))
    db_session.add(InventoryAdjustment(
        id="a-fg", receipt_id="r-fg", product_id="p-fg",
        adjustment_type="damage-reduction", quantity=10, reason="x",
        status="approved",
    ))
    db_session.add(InventoryAdjustment(
        id="a-raw", receipt_id="r-raw", product_id="p-raw",
        adjustment_type="damage-reduction", quantity=500, reason="x",
        status="approved",
    ))
    db_session.commit()

    report = build_adjustments_report(db_session)

    # Per-row unit present.
    units = {r["adjustment_id"]: r["unit"] for r in report["rows"]}
    assert units["a-fg"] == "cases"
    assert units["a-raw"] == "lbs"

    # Totals grouped by unit — never a single mixed number.
    assert report["totals"]["total_by_unit"] == {"cases": 10, "lbs": 500}
    assert "total_quantity" not in report["totals"]
    assert report["totals"]["by_type_unit"]["damage-reduction"] == {"cases": 10, "lbs": 500}
