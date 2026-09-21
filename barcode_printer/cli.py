from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List

from .label_index import build_label_index
from .order_parser import parse_order_file


def _collect_label_files(paths: List[str]) -> List[Path]:
    files = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(p.glob("*.xlsx")))
        else:
            files.append(p)
    return files


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Match order-list barcodes against label workbooks and print the "
            "right number of label sheets (ceil(quantity / 65) per product)."
        )
    )
    parser.add_argument("--order", required=True, help="Order document (.pdf or .xlsx)")
    parser.add_argument(
        "--labels",
        required=True,
        nargs="+",
        help="One or more label workbooks (.xlsx), or a directory containing them",
    )
    parser.add_argument("--printer", help="Printer name to print to (default: system default)")
    parser.add_argument(
        "--cache",
        help="Path to a label-index cache file (speeds up repeated runs). "
        "Defaults to .label_index_cache.json next to the first label file.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only show what would be printed; don't send anything to the printer.",
    )
    return parser


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)

    order_path = Path(args.order)
    label_files = _collect_label_files(args.labels)
    if not label_files:
        print("No label workbooks found.", file=sys.stderr)
        return 1

    cache_path = Path(args.cache) if args.cache else label_files[0].parent / ".label_index_cache.json"

    print(f"Reading order: {order_path}")
    order = parse_order_file(order_path)
    print(f"Order ID: {order.order_id or '(not found)'}")
    print(f"Order lines: {len(order.lines)}")

    print(f"Indexing {len(label_files)} label workbook(s)...")
    index_result = build_label_index(label_files, cache_path=cache_path)
    print(f"Indexed {len(index_result.index)} product labels.")
    if index_result.unmapped_sheets:
        print(f"  ({len(index_result.unmapped_sheets)} sheets had no readable barcode image)")
    if index_result.duplicate_barcodes:
        print(f"  WARNING: {len(index_result.duplicate_barcodes)} barcode(s) appear on multiple sheets:")
        for barcode, locations in index_result.duplicate_barcodes.items():
            print(f"    {barcode}: {[f'{l.workbook}::{l.sheet}' for l in locations]}")

    matched = []
    unmatched = []
    for line in order.lines:
        loc = index_result.index.get(line.barcode)
        if loc:
            matched.append((line, loc))
        else:
            unmatched.append(line)

    print()
    print(f"{'Barcode':<16} {'Qty':>8} {'Sheets':>7}  Product / Label")
    for line, loc in matched:
        print(
            f"{line.barcode:<16} {line.quantity:>8.0f} {line.sheets_needed:>7}  "
            f"{line.name} -> {Path(loc.workbook).name}::{loc.sheet}"
        )
    if unmatched:
        print()
        print("No matching label found for:")
        for line in unmatched:
            print(f"  {line.barcode:<16} {line.quantity:>8.0f}  {line.name}")

    total_sheets = sum(line.sheets_needed for line, _ in matched)
    print()
    print(f"Matched: {len(matched)}/{len(order.lines)} lines, {total_sheets} label sheet(s) to print.")

    if args.dry_run:
        print("Dry run: nothing was sent to the printer.")
        return 0

    if not matched:
        print("Nothing to print.")
        return 0

    from .printer import PrintSession  # Windows-only import, deferred

    with PrintSession(printer_name=args.printer) as session:
        for line, loc in matched:
            print(f"Printing {line.sheets_needed} sheet(s) of {loc.sheet} ({line.barcode})...")
            session.print_sheet(loc.workbook, loc.sheet, line.sheets_needed)

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
