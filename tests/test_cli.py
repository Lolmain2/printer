from pathlib import Path

from barcode_printer.cli import _clean_path_input


def test_clean_path_input_strips_quotes():
    assert _clean_path_input('  "C:\\Orders\\order.pdf"  ') == "C:\\Orders\\order.pdf"
    assert _clean_path_input("'/home/user/order.pdf'") == "/home/user/order.pdf"
    assert _clean_path_input("no_quotes.pdf") == "no_quotes.pdf"


def test_run_interactive_persists_config(tmp_path: Path, monkeypatch):
    import barcode_printer.cli as cli

    monkeypatch.setattr(cli, "_config_path", lambda: tmp_path / "config.json")

    responses = iter(["/some/labels/dir", "MyPrinter", "n"])
    monkeypatch.setattr(cli, "_prompt", lambda _msg: next(responses))
    monkeypatch.setattr(cli, "run", lambda **kwargs: 0)

    rc = cli.run_interactive(order_hint="/some/order.pdf")

    assert rc == 0
    cfg = cli._load_config()
    assert cfg["labels_dir"] == "/some/labels/dir"
    assert cfg["printer"] == "MyPrinter"
