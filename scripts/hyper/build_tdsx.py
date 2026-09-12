#!/usr/bin/env python3
"""
Build a packaged Tableau datasource (.tdsx) from a caller-supplied .tds plus a
locally materialized .hyper extract.

This is the ONLY place the project touches the Tableau Hyper API. It is invoked as
a subprocess by the Node server (src/tableau/publishing/hyperPackager.ts); all
Salesforce access, .tds authoring, and publishing stay in TypeScript. The script:

  1. reads a column schema (schema.json) and streamed rows (data.ndjson),
  2. writes an extract .hyper with one table  Extract."<object>",
  3. zips the provided .tds + that .hyper into a .tdsx (Tableau's package layout),

and prints a small JSON summary ({"rows": N, "out": "..."} ) to stdout on success.

Inputs are plain files so no secrets are passed on argv. Row values are coerced by
the declared column category; a value that cannot be coerced becomes NULL rather
than failing the whole extract.

Schema JSON shape:  [{"name": "Id", "type": "text"}, {"name": "Amount", "type": "double"}, ...]
  type in: text | int | double | bool | date | timestamp
Data NDJSON:        one JSON array per line, aligned to the schema column order.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import zipfile
from datetime import date, datetime
from typing import Any, Callable, List, Tuple

try:
    from tableauhyperapi import (
        Connection,
        CreateMode,
        HyperProcess,
        Inserter,
        SqlType,
        TableDefinition,
        TableName,
        Telemetry,
    )
except Exception as exc:  # pragma: no cover - environment/setup error
    sys.stderr.write(
        "tableauhyperapi is not available. Run `npm run setup:hyper` to create the "
        "virtualenv and install it.\nUnderlying import error: %s\n" % exc
    )
    sys.exit(3)


def _sql_type(category: str):
    cat = (category or "text").lower()
    if cat == "int":
        return SqlType.big_int()
    if cat == "double":
        return SqlType.double()
    if cat == "bool":
        return SqlType.bool()
    if cat == "date":
        return SqlType.date()
    if cat == "timestamp":
        return SqlType.timestamp()
    return SqlType.text()


def _to_bool(value: Any):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    s = str(value).strip().lower()
    if s in ("true", "1", "yes"):
        return True
    if s in ("false", "0", "no"):
        return False
    return None


def _to_int(value: Any):
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def _to_double(value: Any):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_date(value: Any):
    if value is None:
        return None
    s = str(value)
    # Salesforce dates are 'YYYY-MM-DD'.
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _to_timestamp(value: Any):
    if value is None:
        return None
    s = str(value)
    # Salesforce datetimes look like '2024-01-15T10:30:00.000+0000'.
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def _to_text(value: Any):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value)


def _coercer(category: str) -> Callable[[Any], Any]:
    cat = (category or "text").lower()
    return {
        "int": _to_int,
        "double": _to_double,
        "bool": _to_bool,
        "date": _to_date,
        "timestamp": _to_timestamp,
    }.get(cat, _to_text)


def _load_schema(path: str) -> List[Tuple[str, str]]:
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    cols: List[Tuple[str, str]] = []
    for col in raw:
        name = str(col["name"])
        cat = str(col.get("type", "text"))
        cols.append((name, cat))
    if not cols:
        raise ValueError("schema.json contained no columns")
    return cols


def _write_hyper(hyper_path: str, object_name: str, columns: List[Tuple[str, str]], data_path: str) -> int:
    table = TableName("Extract", object_name)
    table_def = TableDefinition(
        table_name=table,
        columns=[TableDefinition.Column(name, _sql_type(cat)) for (name, cat) in columns],
    )
    coercers = [_coercer(cat) for (_, cat) in columns]
    ncols = len(columns)
    rows = 0

    with HyperProcess(telemetry=Telemetry.DO_NOT_SEND_USAGE_DATA_TO_TABLEAU) as hyper:
        with Connection(
            endpoint=hyper.endpoint, database=hyper_path, create_mode=CreateMode.CREATE_AND_REPLACE
        ) as connection:
            connection.catalog.create_schema("Extract")
            connection.catalog.create_table(table_def)
            with Inserter(connection, table) as inserter:
                if os.path.exists(data_path):
                    with open(data_path, "r", encoding="utf-8") as fh:
                        for line in fh:
                            line = line.strip()
                            if not line:
                                continue
                            values = json.loads(line)
                            # Align to schema (pad/truncate defensively).
                            row = [
                                coercers[i](values[i] if i < len(values) else None)
                                for i in range(ncols)
                            ]
                            inserter.add_row(row)
                            rows += 1
                inserter.execute()
    return rows


def _build_tdsx(out_path: str, tds_path: str, hyper_path: str, hyper_name: str) -> None:
    tds_arcname = os.path.splitext(os.path.basename(out_path))[0] + ".tds"
    # Tableau packages store the extract under Data/Extracts/. Use ZIP_DEFLATED so the
    # (potentially large) .hyper is compressed on the wire.
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(tds_path, arcname=tds_arcname)
        zf.write(hyper_path, arcname="Data/Extracts/%s" % hyper_name)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a .tdsx from a .tds + local Salesforce extract")
    parser.add_argument("--tds", required=True, help="Path to the generated .tds XML")
    parser.add_argument("--schema", required=True, help="Path to schema.json (column name/type list)")
    parser.add_argument("--data", required=True, help="Path to data.ndjson (row-aligned JSON arrays)")
    parser.add_argument("--object", required=True, help="Salesforce object / extract table name")
    parser.add_argument("--hyper-name", required=True, help="Extract .hyper filename inside Data/Extracts/")
    parser.add_argument("--out", required=True, help="Output .tdsx path")
    args = parser.parse_args()

    columns = _load_schema(args.schema)

    tmp_dir = tempfile.mkdtemp(prefix="tp_hyper_")
    hyper_path = os.path.join(tmp_dir, args.hyper_name)
    try:
        rows = _write_hyper(hyper_path, args.object, columns, args.data)
        _build_tdsx(args.out, args.tds, hyper_path, args.hyper_name)
    finally:
        try:
            if os.path.exists(hyper_path):
                os.remove(hyper_path)
            os.rmdir(tmp_dir)
        except OSError:
            pass

    json.dump({"rows": rows, "out": args.out}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
