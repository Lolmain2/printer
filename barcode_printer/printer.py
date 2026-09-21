"""Drives Excel (via COM) to print specific label sheets on Windows.

This module only works on Windows with Microsoft Excel and pywin32
installed. It is imported lazily by the CLI so that parsing / matching
can still be exercised (and tested) on other platforms.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional


class PrintSession:
    """Keeps one Excel COM instance open across several print jobs."""

    def __init__(self, printer_name: Optional[str] = None, visible: bool = False):
        import win32com.client  # noqa: F401  (import here: Windows-only)

        self._win32com = win32com.client
        self.printer_name = printer_name
        self._app = None
        self._workbooks = {}

    def __enter__(self) -> "PrintSession":
        self._app = self._win32com.Dispatch("Excel.Application")
        self._app.Visible = False
        self._app.DisplayAlerts = False
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        for wb in self._workbooks.values():
            wb.Close(SaveChanges=False)
        self._workbooks.clear()
        if self._app is not None:
            self._app.Quit()
            self._app = None

    def _get_workbook(self, path: str):
        path = str(Path(path).resolve())
        if path not in self._workbooks:
            self._workbooks[path] = self._app.Workbooks.Open(path, ReadOnly=True)
        return self._workbooks[path]

    def print_sheet(self, workbook_path: str, sheet_name: str, copies: int) -> None:
        if copies <= 0:
            return
        wb = self._get_workbook(workbook_path)
        sheet = wb.Sheets(sheet_name)
        kwargs = {"Copies": copies}
        if self.printer_name:
            kwargs["ActivePrinter"] = self.printer_name
        sheet.PrintOut(**kwargs)


def list_printers():
    """Returns the names of printers installed on this Windows machine."""
    import win32print

    return [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL)]
