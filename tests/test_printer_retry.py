import sys
import types

import pytest


@pytest.fixture
def fake_pywintypes(monkeypatch):
    """printer.py does `import pywintypes` lazily; fake it out so the retry
    logic can be exercised on non-Windows test runners."""

    class FakeComError(Exception):
        pass

    module = types.ModuleType("pywintypes")
    module.com_error = FakeComError
    monkeypatch.setitem(sys.modules, "pywintypes", module)
    return module


def _com_error(module, code):
    return module.com_error(code, "message", None, None)


def test_retries_on_transient_error_then_succeeds(fake_pywintypes, monkeypatch):
    from barcode_printer.printer import _retry_transient_com_errors, _RPC_E_CALL_REJECTED

    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    calls = {"count": 0}

    def action():
        calls["count"] += 1
        if calls["count"] < 3:
            raise _com_error(fake_pywintypes, _RPC_E_CALL_REJECTED)
        return "ok"

    result = _retry_transient_com_errors(action, attempts=5, delay=0)
    assert result == "ok"
    assert calls["count"] == 3


def test_gives_up_after_max_attempts(fake_pywintypes, monkeypatch):
    from barcode_printer.printer import _retry_transient_com_errors, _RPC_E_SERVERCALL_RETRYLATER

    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    def action():
        raise _com_error(fake_pywintypes, _RPC_E_SERVERCALL_RETRYLATER)

    with pytest.raises(fake_pywintypes.com_error):
        _retry_transient_com_errors(action, attempts=3, delay=0)


def test_non_transient_error_is_not_retried(fake_pywintypes, monkeypatch):
    from barcode_printer.printer import _retry_transient_com_errors

    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    calls = {"count": 0}

    def action():
        calls["count"] += 1
        raise _com_error(fake_pywintypes, -12345)

    with pytest.raises(fake_pywintypes.com_error):
        _retry_transient_com_errors(action, attempts=5, delay=0)
    assert calls["count"] == 1
