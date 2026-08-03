"""Category predicates shared across services.

Before 2026-08-03 `_is_finished_goods` was duplicated verbatim in
transfer_service.py:18 and inter_warehouse_transfer_service.py:17, and there was
NO ingredient predicate anywhere in the backend — `CATEGORY_INGREDIENT` was
referenced by zero lines of app code. That made every rule in
INGREDIENT-SERIALIZATION-SPEC.md scoped to "ingredients only" literally
inexpressible, so the predicates live here now.

Two spelling hazards this module exists to absorb:

* Raw materials appear in production data as BOTH ``'raw'`` (dominant) and the
  legacy ``'raw-material'``. See routers/service.py:87, which already does
  ``Category.type.in_(["raw", "raw-material"])``. CLAUDE.md has this backwards.
* ``parent_id == "group-finished"`` is a LEGACY fallback. Those type-based groups
  (``group-raw`` / ``group-finished`` / ``group-packaging``) were folded into a
  single client group by scripts/migrate_to_client_groups.py, so `type` is the
  reliable signal and `parent_id` only still matches on un-migrated rows. There
  was never a ``group-ingredient``, which is why the ingredient predicate below
  tests `type` alone.
"""

from sqlalchemy.orm import Session

from app.constants import (
    CATEGORY_FINISHED,
    CATEGORY_INGREDIENT,
    CATEGORY_PACKAGING,
    CATEGORY_RAW_MATERIAL,
)

# Both spellings of raw material found in production data.
RAW_MATERIAL_TYPES = frozenset({"raw", CATEGORY_RAW_MATERIAL})


def is_finished_goods_category(category) -> bool:
    """True for a finished-goods Category row (None-safe)."""
    if category is None:
        return False
    return bool(
        category.parent_id == "group-finished" or category.type == CATEGORY_FINISHED
    )


def is_ingredient_category(category) -> bool:
    """True for an ingredient Category row (None-safe).

    Deliberately does NOT include raw materials. Ingredients are the serialized
    tier (barrels/bags); raw materials keep the legacy receipt/allocation flow.
    """
    if category is None:
        return False
    return category.type == CATEGORY_INGREDIENT


def is_raw_material_category(category) -> bool:
    """True for a raw-material Category row, either spelling (None-safe)."""
    if category is None:
        return False
    return category.type in RAW_MATERIAL_TYPES


def is_packaging_category(category) -> bool:
    if category is None:
        return False
    return category.type == CATEGORY_PACKAGING


def _category_for_receipt(db: Session, receipt):
    from app.models import Category

    if receipt is None or receipt.category_id is None:
        return None
    return db.query(Category).filter(Category.id == receipt.category_id).first()


def _category_for_product(db: Session, product_id: str):
    from app.models import Category, Product

    if not product_id:
        return None
    product = db.query(Product).filter(Product.id == product_id).first()
    if product is None or product.category_id is None:
        return None
    return db.query(Category).filter(Category.id == product.category_id).first()


def is_finished_goods(db: Session, receipt) -> bool:
    """Receipt-level finished-goods check.

    Behaviourally identical to the two copies it replaced — do not "fix" the
    parent_id fallback without checking un-migrated rows first.
    """
    return is_finished_goods_category(_category_for_receipt(db, receipt))


def is_ingredient(db: Session, receipt) -> bool:
    """Receipt-level ingredient check."""
    return is_ingredient_category(_category_for_receipt(db, receipt))


def is_ingredient_product(db: Session, product_id: str) -> bool:
    """Product-level ingredient check.

    Containers carry `product_id` and never a `category_id`, so this is the entry
    point the serialization code paths use.
    """
    return is_ingredient_category(_category_for_product(db, product_id))
