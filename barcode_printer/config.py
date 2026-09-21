import re

# Each label sheet in the "Naljepnice" workbooks is a 5x13 grid of
# identical stickers for one product (65 stickers per printed page).
LABELS_PER_SHEET = 65

# Order documents are numbered like "26-0200-001305" or "26-0202-001305":
# two-digit year, then a 4-digit type code (0200 / 0202), then a sequence.
ORDER_ID_PATTERN = re.compile(r"\b(\d{2})-(0200|0202)-(\d{4,8})")

# One line of the order table, once PyPDF2 has flattened it to text, looks like:
#   "350,00 KOM 3873515115340 KUKA ZA POLUKRUZNI OLUK 333 PB, RAL 8019 SMEDA KOM 35,000 2"
# price / unit / barcode / product name / unit / quantity / position
ORDER_LINE_PATTERN = re.compile(
    r"^[\d.,]+\s+[A-ZČĆŽŠĐ]{1,6}\s+"
    r"(?P<barcode>\d{8,14})\s+"
    r"(?P<name>.+?)\s+"
    r"[A-ZČĆŽŠĐ]{1,6}\s+"
    r"(?P<qty>[\d.,]+)\s+"
    r"(?P<pos>\d+)$",
    re.MULTILINE,
)
