"""Finishing a receiving line is an action, not an inference.

`open_sessions` deliberately does NOT hide a line once scanned >= expected:
over-receiving is legal, and auto-hiding at the paperwork count would strand the
81st drum of an expected 80. The consequence was that a line with all its drums
in stayed on the gun forever, indistinguishable from one still waiting for a
truck.

So completion is explicit. These tests pin the three things that makes true:
a matching count submits straight through, a mismatch asks first and goes
through on confirmation, and a submitted line leaves the gun while STAYING in
the office approvals queue.
"""
import pytest

from app.models import IntakeLot, IngredientIntake, MaterialLot, Receipt
from app.services import lot_receiving_service as lrs
from app.services import lot_placement_service as lps


def _build_session(db, seed_data, *, expected, scanned, row_id="row-1", suffix="a"):
    """A receiving line with `expected` drums on paper and `scanned` counted in."""
    lot = MaterialLot(
        id=f"mlot-{suffix}",
        lot_code=f"S1.VENDOR-1.{suffix}.20280101",
        lot_key=f"key-{suffix}",
        product_id=seed_data["product"].id,
        unit_label="drum",
        weight_per_unit=570,
        weight_unit="lbs",
    )
    db.add(lot)

    receipt = Receipt(
        id=f"rcpt-{suffix}",
        product_id=seed_data["product"].id,
        category_id=seed_data["category"].id,
        quantity=expected * 570,
        unit="lbs",
        container_count=expected,
        container_unit="drum",
        weight_per_container=570,
        weight_unit="lbs",
        lot_number=f"LOT-{suffix}",
        status="recorded",
        material_lot_id=lot.id,
    )
    db.add(receipt)
    db.commit()

    for _ in range(scanned):
        lps.apply_delta(
            db, lot, row_id,
            event_type=lps.EVENT_RECEIVED,
            full_units_delta=1,
            actor_id=None,
            ref_type=lrs.REF_TYPE_RECEIVING,
            ref_id=receipt.id,
        )
    db.commit()
    return receipt


@pytest.mark.unit
class TestSubmitSession:

    def test_matching_count_submits_straight_through(self, db_session, seed_data, admin_user):
        receipt = _build_session(db_session, seed_data, expected=3, scanned=3, suffix="ok")

        result = lrs.submit_session(db_session, receipt_id=receipt.id, user_id=admin_user.id)
        db_session.commit()

        assert result["status"] == "submitted"
        assert result["difference"] == 0
        assert receipt.forklift_submitted_at is not None
        assert receipt.forklift_submitted_by == admin_user.id

    def test_short_count_asks_before_finishing(self, db_session, seed_data, admin_user):
        receipt = _build_session(db_session, seed_data, expected=13, scanned=11, suffix="short")

        result = lrs.submit_session(db_session, receipt_id=receipt.id, user_id=admin_user.id)

        assert result["status"] == "needs_confirm"
        assert result["difference"] == -2
        # The worker has to be told WHAT disagrees, not just that something does.
        assert "2 drums short of the paperwork" in result["message"]
        assert receipt.forklift_submitted_at is None, "must not close without confirmation"

    def test_over_count_asks_too_and_is_allowed(self, db_session, seed_data, admin_user):
        """An over-receipt is a fact, not a failure. Blocking it would teach
        workers to make the number fit rather than report what they counted."""
        receipt = _build_session(db_session, seed_data, expected=9, scanned=11, suffix="over")

        asked = lrs.submit_session(db_session, receipt_id=receipt.id, user_id=admin_user.id)
        assert asked["status"] == "needs_confirm"
        assert asked["difference"] == 2
        assert "2 more drums than the paperwork" in asked["message"]

        done = lrs.submit_session(
            db_session, receipt_id=receipt.id, user_id=admin_user.id, confirmed=True
        )
        db_session.commit()
        assert done["status"] == "submitted"
        assert receipt.forklift_submitted_at is not None

    def test_submitted_line_leaves_the_gun_but_stays_pending_approval(
        self, db_session, seed_data, admin_user
    ):
        """The two must not be coupled. Clearing the gun by moving `status`
        would also drop the receipt out of the office approvals queue."""
        receipt = _build_session(db_session, seed_data, expected=3, scanned=3, suffix="gun")

        open_before = [s["receipt_id"] for s in lrs.open_sessions(db_session)]
        assert receipt.id in open_before

        lrs.submit_session(db_session, receipt_id=receipt.id, user_id=admin_user.id)
        db_session.commit()

        open_after = [s["receipt_id"] for s in lrs.open_sessions(db_session)]
        assert receipt.id not in open_after, "should have left the gun"
        assert receipt.status == "recorded", "must still be pending the office check"

    def test_submitting_twice_is_harmless(self, db_session, seed_data, admin_user, test_user):
        receipt = _build_session(db_session, seed_data, expected=3, scanned=3, suffix="twice")

        lrs.submit_session(db_session, receipt_id=receipt.id, user_id=admin_user.id)
        db_session.commit()
        first_at = receipt.forklift_submitted_at

        again = lrs.submit_session(db_session, receipt_id=receipt.id, user_id=test_user.id)
        db_session.commit()

        assert again["status"] == "already_submitted"
        assert receipt.forklift_submitted_at == first_at, "must not be re-stamped"
        assert receipt.forklift_submitted_by == admin_user.id
