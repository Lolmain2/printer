"""Drives Excel (via COM) to print specific label sheets on Windows.

This module only works on Windows with Microsoft Excel and pywin32
installed. It is imported lazily by the CLI so that parsing / matching
can still be exercised (and tested) on other platforms.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional, TypeVar

T = TypeVar("T")

# Transient "Excel is still busy" COM errors. These happen a lot when
# automating Office right after opening a big workbook (these label
# workbooks embed thousands of barcode images) — the call arrives before
# Excel has fully settled and gets bounced instead of queued, so the fix
# is to just retry with backoff rather than treat it as a real failure.
_RPC_E_CALL_REJECTED = -2147418111
_RPC_E_SERVERCALL_RETRYLATER = -2147417846
_TRANSIENT_COM_ERRORS = {_RPC_E_CALL_REJECTED, _RPC_E_SERVERCALL_RETRYLATER}


class PrintError(RuntimeError):
    """Raised when Excel/COM printing fails, with context about what was being printed."""


def _retry_transient_com_errors(action: Callable[[], T], attempts: int = 20, delay: float = 0.5) -> T:
    import pywintypes

    last_exc = None
    for attempt in range(attempts):
        try:
            return action()
        except pywintypes.com_error as exc:
            if exc.args[0] not in _TRANSIENT_COM_ERRORS:
                raise
            last_exc = exc
            time.sleep(delay)
    raise last_exc


class PrintSession:
    """Keeps one Excel COM instance open across several print jobs."""

    def __init__(self, printer_name: Optional[str] = None, visible: bool = False):
        import pythoncom
        import win32com.client  # noqa: F401  (import here: Windows-only)

        self._pythoncom = pythoncom
        self._win32com = win32com.client
        self.printer_name = printer_name
        self._app = None
        self._workbooks = {}
        self._com_initialized = False

    def __enter__(self) -> "PrintSession":
        # Frozen (PyInstaller) executables don't always get COM initialized
        # on the main thread automatically; do it explicitly to avoid
        # "CoInitialize has not been called" style failures.
        self._pythoncom.CoInitialize()
        self._com_initialized = True
        try:
            self._app = self._win32com.Dispatch("Excel.Application")
        except Exception as exc:
            raise PrintError(
                "Could not start Microsoft Excel via COM automation. "
                "Make sure Excel is installed on this PC. "
                f"Underlying error: {exc}"
            ) from exc
        self._app.Visible = False
        self._app.DisplayAlerts = False
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        for wb in self._workbooks.values():
            try:
                wb.Close(SaveChanges=False)
            except Exception:
                pass
        self._workbooks.clear()
        if self._app is not None:
            try:
                self._app.Quit()
            except Exception:
                pass
            self._app = None
        if self._com_initialized:
            self._pythoncom.CoUninitialize()
            self._com_initialized = False

    def _get_workbook(self, path: str):
        resolved = str(Path(path).resolve())
        if resolved not in self._workbooks:
            try:
                self._workbooks[resolved] = _retry_transient_com_errors(
                    lambda: self._app.Workbooks.Open(resolved, ReadOnly=True)
                )
            except Exception as exc:
                raise PrintError(f"Could not open label workbook '{resolved}': {exc}") from exc
        return self._workbooks[resolved]

    def print_sheet(self, workbook_path: str, sheet_name: str, copies: int) -> None:
        if copies <= 0:
            return
        wb = self._get_workbook(workbook_path)
        try:
            sheet = _retry_transient_com_errors(lambda: wb.Sheets(sheet_name))
        except Exception as exc:
            raise PrintError(
                f"Could not access sheet '{sheet_name}' in '{workbook_path}': {exc}"
            ) from exc
        kwargs = {"Copies": copies}
        if self.printer_name:
            kwargs["ActivePrinter"] = self.printer_name
        try:
            _retry_transient_com_errors(lambda: sheet.PrintOut(**kwargs))
        except Exception as exc:
            raise PrintError(
                f"Printing sheet '{sheet_name}' from '{workbook_path}' failed: {exc}. "
                "Check that the printer name is correct and the printer is online."
            ) from exc


def list_printers():
    """Returns the names of printers installed on this Windows machine."""
    import win32print

    return [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL)]
