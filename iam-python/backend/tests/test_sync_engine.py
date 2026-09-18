"""Directory sync engine diff logic — pure, no I/O."""
from app.services.sync_engine import LedgerAccount, compute_diff


def _ledger():
    return [
        LedgerAccount(identifier="alice@x", email="alice@x", employee_id="e1",
                      employee_status="ACTIVE", groups={"Finance", "M365"}),
        LedgerAccount(identifier="bob@x", email="bob@x", employee_id="e2",
                      employee_status="TERMINATED", groups={"Sales"}),
    ]


def test_in_sync_has_no_findings():
    source = [
        {"identifier": "alice@x", "email": "alice@x", "status": "ACTIVE", "groups": ["Finance", "M365"]},
        {"identifier": "bob@x", "email": "bob@x", "status": "DISABLED", "groups": ["Sales"]},
    ]
    assert compute_diff(source, _ledger()).findings == []


def test_detects_all_drift_kinds():
    source = [
        # alice: rogue Domain-Admins, missing M365
        {"identifier": "alice@x", "email": "alice@x", "status": "ACTIVE", "groups": ["Finance", "Domain-Admins"]},
        # bob: still active at source but terminated in IAM
        {"identifier": "bob@x", "email": "bob@x", "status": "ACTIVE", "groups": ["Sales"]},
        # carol: exists at source, unknown to IAM
        {"identifier": "carol@x", "email": "carol@x", "status": "ACTIVE", "groups": []},
    ]
    diff = compute_diff(source, _ledger())
    assert diff.count("UNTRACKED_ACCOUNT") == 1   # carol
    assert diff.count("STATUS_DRIFT") == 1        # bob
    assert diff.count("GROUP_ADDED") == 1         # alice Domain-Admins
    assert diff.count("GROUP_MISSING") == 1       # alice M365
    assert diff.count("MISSING_AT_SOURCE") == 0


def test_detects_missing_at_source():
    # ledger expects bob but the source returns only alice
    source = [{"identifier": "alice@x", "email": "alice@x", "status": "ACTIVE", "groups": ["Finance", "M365"]}]
    diff = compute_diff(source, _ledger())
    assert diff.count("MISSING_AT_SOURCE") == 1
    assert next(f for f in diff.findings if f.kind == "MISSING_AT_SOURCE").identifier == "bob@x"


def test_matches_by_email_when_identifier_differs():
    ledger = [LedgerAccount(identifier="user-123", email="alice@x", employee_id="e1",
                            employee_status="ACTIVE", groups=set())]
    # source keys by email, ledger by an opaque id — still matched, no false untracked
    source = [{"identifier": "alice@x", "email": "alice@x", "status": "ACTIVE", "groups": []}]
    diff = compute_diff(source, ledger)
    assert diff.findings == []
