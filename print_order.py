"""Convenience entry point: `python print_order.py --order ... --labels ...`"""
from barcode_printer.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
