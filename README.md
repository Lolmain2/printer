# Barcode Order Label Printer

Reads a customer order (PDF or Excel), matches each ordered product's
barcode against the "Naljepnice" label workbooks, and prints the right
number of label sheets — each printed sheet holds 65 stickers, so the
number of sheets printed per product is `ceil(quantity / 65)`.

## How it works

1. **Order document** (`--order`): a `.pdf` order (like `26-0200-001305...pdf`)
   or an `.xlsx` order list. The order number is recognized by the
   pattern `YY-0200-NNNNNN` / `YY-0202-NNNNNN`. Each order line is read
   for its barcode and quantity.
2. **Label workbooks** (`--labels`): one or more `.xlsx` files (or a
   directory of them), each with one sheet per product. Every sheet is
   a 5x13 grid (65 cells) of the same barcode image — the actual
   barcode value is read straight out of that image (via `pyzbar`), so
   no manual barcode-to-sheet mapping has to be maintained.
3. For every order line whose barcode is found in a label workbook, that
   product's sheet is sent to the printer `ceil(quantity / 65)` times.
   Lines with no matching label are listed at the end instead of being
   silently skipped.

A cache file (`.label_index_cache.json`, next to the label workbooks by
default) avoids re-scanning every barcode image on repeat runs — a
workbook is only re-indexed if it has changed since the last scan.

## Setup (Windows)

Printing requires Microsoft Excel and `pywin32`, so run this on Windows,
in a Python 3.9+ environment:

```
pip install -r requirements.txt
```

## Usage

### The easy way: `BarcodePrinter.exe`

Download `BarcodePrinter.exe` (built by the `Build Windows exe` GitHub
Action — grab it from the repo's Actions run artifacts, or from a
Release once one is tagged) and put it anywhere on your work PC —
next to the `Naljepnice_*.xlsx` label files is a natural spot.

Then either:

- **Double-click it.** It will ask, in the console window that opens,
  for the order file (drag the order PDF/xlsx onto the console window
  and press Enter — Windows types its full path for you) and the
  folder containing the label workbooks. It remembers the label folder
  and printer choice for next time, so after the first run you can just
  press Enter to reuse them. It always shows a dry-run preview first
  and asks `Actually print the above now? (y/n)` before sending
  anything to the printer.
- **Drag an order file onto `BarcodePrinter.exe`** in Explorer. It
  skips the "which order file" question and goes straight to asking
  for the labels folder (or reuses the one from last time).

Its settings (last-used labels folder and printer name) are stored in
`%APPDATA%\BarcodePrinter\config.json`.

### The command-line way: `python print_order.py` / `BarcodePrinter.exe`

Preview what would be printed, without printing anything:

```
python print_order.py --order "C:\Orders\26-0200-001305.pdf" ^
    --labels "C:\Naljepnice\Naljepnice_galanterija_-_za_komade.xlsx" ^
              "C:\Naljepnice\Naljepnice_LIMARIJA_-_za_komade.xlsx" ^
              "C:\Naljepnice\Naljepnice_SNjEGOBRANI_-_za_komade.xlsx" ^
    --dry-run
```

Drop `--dry-run` to actually print. `--labels` also accepts a folder
(every `.xlsx` file in it is indexed):

```
python print_order.py --order "C:\Orders\26-0200-001305.pdf" ^
    --labels "C:\Naljepnice" ^
    --printer "Zebra ZD420"
```

`--printer` is optional; omit it to use the Windows default printer.
Run `python -c "from barcode_printer.printer import list_printers; print(list_printers())"`
to see the exact names Windows knows your printers by. The exe accepts
the exact same flags (`BarcodePrinter.exe --order ... --labels ...`).

## Testing

```
pip install pytest python-barcode
pytest
```

The test suite covers order parsing (PDF-text and Excel), the
quantity → sheet-count rounding, and barcode-image indexing — it does
not exercise the actual Windows printing step, which needs a real Excel
+ printer to verify.
