from pathlib import Path

import openpyxl
import pytest

from barcode_printer.order_parser import (
    find_order_id,
    parse_order_text,
    parse_order_file,
)

SAMPLE_TEXT = (
    "20,00 KOM 3873515228446 T. OPSAV ZA DIMNJAK DONJI 0,50mm 40x40cm RAL 8019 CIVIC KOM 20,000 1\n"
    "350,00 KOM 3873515115340 KUKA ZA POLUKRUZNI OLUK 333 PB, RAL 8019 SMEDA KOM 35,000 2\n"
)


def test_find_order_id():
    text = "Narudzba br./Order nr.:        26-0200-001305"
    assert find_order_id(text) == "26-0200-001305"


def test_find_order_id_missing():
    assert find_order_id("no order number here") is None


def test_find_order_id_no_trailing_separator():
    # real PDFs often run the order number straight into the next word
    text = "Narudzba br./Order nr.:        26-0200-001305Bosna Bank International"
    assert find_order_id(text) == "26-0200-001305"


def test_parse_order_text():
    lines = parse_order_text(SAMPLE_TEXT)
    assert len(lines) == 2
    assert lines[0].barcode == "3873515228446"
    assert lines[0].quantity == 20.0
    assert lines[0].name == "T. OPSAV ZA DIMNJAK DONJI 0,50mm 40x40cm RAL 8019 CIVIC"
    assert lines[1].barcode == "3873515115340"
    assert lines[1].quantity == 35.0


@pytest.mark.parametrize(
    "quantity,expected_sheets",
    [(1, 1), (65, 1), (66, 2), (130, 2), (131, 3), (0, 0)],
)
def test_sheets_needed_rounds_up(quantity, expected_sheets):
    lines = parse_order_text(
        f"10,00 KOM 1234567890123 TEST PRODUCT KOM {quantity:.0f},000 1\n"
    )
    assert lines[0].sheets_needed == expected_sheets


def test_parse_excel_order(tmp_path: Path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Pozicija", "Barcode", "Naziv", "Kolicina"])
    ws.append([1, "1111111111111", "Product A", 100])
    ws.append([2, "2222222222222", "Product B", 65])
    xlsx_path = tmp_path / "order.xlsx"
    wb.save(xlsx_path)

    order = parse_order_file(xlsx_path)
    assert len(order.lines) == 2
    assert order.lines[0].barcode == "1111111111111"
    assert order.lines[0].quantity == 100
    assert order.lines[0].sheets_needed == 2
    assert order.lines[1].sheets_needed == 1


def test_parse_excel_order_missing_columns(tmp_path: Path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Foo", "Bar"])
    ws.append([1, 2])
    xlsx_path = tmp_path / "bad_order.xlsx"
    wb.save(xlsx_path)

    with pytest.raises(ValueError):
        parse_order_file(xlsx_path)
