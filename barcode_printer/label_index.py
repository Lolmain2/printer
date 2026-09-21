"""Builds a barcode -> (workbook, sheet) lookup by decoding the barcode
images embedded in each sheet of the "Naljepnice" label workbooks.

Each sheet is a fixed 5x13 grid (65 stickers) for a single product, with
the same barcode image repeated in every cell, so only one image per
sheet needs to be decoded.
"""
from __future__ import annotations

import io
import json
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional

import openpyxl
from PIL import Image
from pyzbar.pyzbar import decode as zbar_decode


@dataclass(frozen=True)
class LabelLocation:
    workbook: str
    sheet: str


@dataclass
class LabelIndexResult:
    index: Dict[str, LabelLocation]
    unmapped_sheets: List[LabelLocation]
    duplicate_barcodes: Dict[str, List[LabelLocation]]


def _decode_sheet_barcode(ws) -> Optional[str]:
    for image in getattr(ws, "_images", []):
        try:
            pic = Image.open(io.BytesIO(image._data()))
            results = zbar_decode(pic)
        except Exception:
            continue
        if results:
            return results[0].data.decode("utf-8", errors="ignore")
    return None


def _scan_workbook(path: Path) -> Dict[str, LabelLocation]:
    found: Dict[str, LabelLocation] = {}
    unmapped: List[LabelLocation] = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # unsupported wmf images embedded alongside barcodes
        wb = openpyxl.load_workbook(path, data_only=False)
    try:
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            barcode = _decode_sheet_barcode(ws)
            loc = LabelLocation(workbook=str(path), sheet=sheet_name)
            if barcode:
                found[barcode] = loc
            else:
                unmapped.append(loc)
    finally:
        wb.close()
    return found, unmapped


def _cache_key(path: Path) -> dict:
    stat = path.stat()
    return {"path": str(path), "mtime": stat.st_mtime, "size": stat.st_size}


def build_label_index(
    label_files: List[Path], cache_path: Optional[Path] = None
) -> LabelIndexResult:
    label_files = [Path(p) for p in label_files]

    cache = {}
    if cache_path and Path(cache_path).exists():
        try:
            cache = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cache = {}

    index: Dict[str, LabelLocation] = {}
    duplicates: Dict[str, List[LabelLocation]] = {}
    unmapped: List[LabelLocation] = []
    new_cache = {}

    for path in label_files:
        key = _cache_key(path)
        cached_entry = cache.get(str(path))
        if cached_entry and cached_entry.get("mtime") == key["mtime"] and cached_entry.get(
            "size"
        ) == key["size"]:
            found = {bc: LabelLocation(**loc) for bc, loc in cached_entry["found"].items()}
            file_unmapped = [LabelLocation(**loc) for loc in cached_entry["unmapped"]]
        else:
            found, file_unmapped = _scan_workbook(path)

        new_cache[str(path)] = {
            **key,
            "found": {bc: asdict(loc) for bc, loc in found.items()},
            "unmapped": [asdict(loc) for loc in file_unmapped],
        }

        unmapped.extend(file_unmapped)
        for barcode, loc in found.items():
            if barcode in index:
                duplicates.setdefault(barcode, [index[barcode]]).append(loc)
            else:
                index[barcode] = loc

    if cache_path:
        Path(cache_path).write_text(json.dumps(new_cache, indent=2), encoding="utf-8")

    return LabelIndexResult(index=index, unmapped_sheets=unmapped, duplicate_barcodes=duplicates)
