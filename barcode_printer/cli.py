from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Optional

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


def _config_path() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / "BarcodePrinter"
    d.mkdir(parents=True, exist_ok=True)
    return d / "config.json"


def _load_config() -> dict:
    p = _config_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_config(cfg: dict) -> None:
    try:
        _config_path().write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except OSError:
        pass


def _clean_path_input(raw: str) -> str:
    """Strips quotes Explorer adds when you drag & drop a file/folder into the console."""
    return raw.strip().strip('"').strip("'")


def _prompt(message: str) -> str:
    try:
        return input(message)
    except EOFError:
        return ""


def run(order: str, labels: List[str], printer: Optional[str], cache: Optional[str], dry_run: bool) -> int:
    order_path = Path(order)
    label_files = _collect_label_files(labels)
    if not label_files:
        print("No label workbooks found.", file=sys.stderr)
        return 1

    cache_path = Path(cache) if cache else label_files[0].parent / ".label_index_cache.json"

    print(f"Reading order: {order_path}")
    order_doc = parse_order_file(order_path)
    print(f"Order ID: {order_doc.order_id or '(not found)'}")
    print(f"Order lines: {len(order_doc.lines)}")

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
    for line in order_doc.lines:
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
    print(f"Matched: {len(matched)}/{len(order_doc.lines)} lines, {total_sheets} label sheet(s) to print.")

    if dry_run:
        print("Dry run: nothing was sent to the printer.")
        return 0

    if not matched:
        print("Nothing to print.")
        return 0

    from .printer import PrintSession  # Windows-only import, deferred

    with PrintSession(printer_name=printer) as session:
        for line, loc in matched:
            print(f"Printing {line.sheets_needed} sheet(s) of {loc.sheet} ({line.barcode})...")
            session.print_sheet(loc.workbook, loc.sheet, line.sheets_needed)

    print("Done.")
    return 0


def run_interactive(order_hint: Optional[str] = None) -> int:
    cfg = _load_config()

    order = order_hint
    if not order:
        order = _clean_path_input(_prompt("Order file (PDF or Excel) - drag & drop it here, then press Enter: "))
    if not order:
        print("No order file given.")
        return 1

    labels_default = cfg.get("labels_dir")
    prompt = "Folder with the label workbooks (.xlsx)"
    prompt += f" [{labels_default}]: " if labels_default else ": "
    labels_dir = _clean_path_input(_prompt(prompt)) or labels_default
    if not labels_dir:
        print("A label workbooks folder is required.")
        return 1
    cfg["labels_dir"] = labels_dir

    printer_default = cfg.get("printer")
    printer_prompt = "Printer name (leave blank for the Windows default"
    printer_prompt += f", last used: {printer_default}): " if printer_default else "): "
    printer = _clean_path_input(_prompt(printer_prompt)) or printer_default
    if printer:
        cfg["printer"] = printer

    _save_config(cfg)

    rc = run(order=order, labels=[labels_dir], printer=printer or None, cache=None, dry_run=True)
    if rc != 0:
        return rc

    proceed = _prompt("\nActually print the above now? (y/n): ").strip().lower()
    if proceed == "y":
        return run(order=order, labels=[labels_dir], printer=printer or None, cache=None, dry_run=False)

    print("Nothing was printed.")
    return 0


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
    argv = sys.argv[1:] if argv is None else argv
    interactive = not argv or (len(argv) == 1 and not argv[0].startswith("-"))

    rc = 1
    try:
        if not argv:
            rc = run_interactive()
        elif len(argv) == 1 and not argv[0].startswith("-"):
            # Someone dragged a file straight onto the exe: argv[0] is the order file.
            rc = run_interactive(order_hint=argv[0])
        else:
            args = build_arg_parser().parse_args(argv)
            rc = run(
                order=args.order,
                labels=args.labels,
                printer=args.printer,
                cache=args.cache,
                dry_run=args.dry_run,
            )
    except Exception:
        # Never let the window vanish on a crash: print the full error so it
        # can be read (and reported) instead of the console just closing.
        import traceback

        traceback.print_exc()
        rc = 1
    finally:
        if interactive and getattr(sys, "frozen", False):
            _prompt("\nPress Enter to exit...")

    return rc


if __name__ == "__main__":
    raise SystemExit(main())
