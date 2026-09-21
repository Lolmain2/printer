import io
from pathlib import Path

import barcode as barcode_lib
import openpyxl
from barcode.writer import ImageWriter
from openpyxl.drawing.image import Image as XLImage

from barcode_printer.label_index import build_label_index


def _barcode_png_bytes(value: str) -> bytes:
    code = barcode_lib.get("code128", value, writer=ImageWriter())
    buf = io.BytesIO()
    code.write(buf, options={"write_text": False})
    return buf.getvalue()


def _make_label_workbook(path: Path, products: dict):
    """products: {sheet_name: barcode_value}"""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for sheet_name, value in products.items():
        ws = wb.create_sheet(title=sheet_name)
        png_path = path.parent / f"_tmp_{sheet_name}.png"
        png_path.write_bytes(_barcode_png_bytes(value))
        for row in range(1, 4):
            img = XLImage(str(png_path))
            img.anchor = f"A{row}"
            ws.add_image(img)
    wb.save(path)


def test_build_label_index_maps_barcodes_to_sheets(tmp_path: Path):
    workbook_path = tmp_path / "labels.xlsx"
    _make_label_workbook(
        workbook_path,
        {"Product A": "1111111111111", "Product B": "2222222222222"},
    )

    result = build_label_index([workbook_path])

    assert result.index["1111111111111"].sheet == "Product A"
    assert result.index["2222222222222"].sheet == "Product B"
    assert not result.unmapped_sheets
    assert not result.duplicate_barcodes


def test_build_label_index_uses_cache(tmp_path: Path, monkeypatch):
    workbook_path = tmp_path / "labels.xlsx"
    _make_label_workbook(workbook_path, {"Product A": "1111111111111"})
    cache_path = tmp_path / "cache.json"

    result1 = build_label_index([workbook_path], cache_path=cache_path)
    assert result1.index["1111111111111"].sheet == "Product A"
    assert cache_path.exists()

    calls = []
    import barcode_printer.label_index as li

    original = li._scan_workbook

    def spy(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(li, "_scan_workbook", spy)

    result2 = build_label_index([workbook_path], cache_path=cache_path)
    assert result2.index["1111111111111"].sheet == "Product A"
    assert calls == []  # cache hit: workbook was not re-scanned
