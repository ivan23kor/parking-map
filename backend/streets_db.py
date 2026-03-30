"""
Query local SpatiaLite streets database.
Returns same shape as Overpass API for drop-in replacement.
"""

import json
import sqlite3
from pathlib import Path



DB_PATH = Path(__file__).parent / "data" / "streets.db"

_conn = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        if not DB_PATH.exists():
            raise FileNotFoundError(
                f"Streets DB not found: {DB_PATH}. "
                "Run: python backend/ingest_osm.py <file.osm.pbf>"
            )
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


def query_streets(south: float, west: float, north: float, east: float) -> list[dict]:
    """Query ways within bounding box. Returns same shape as Overpass response."""
    conn = _get_conn()
    rows = conn.execute(
        """SELECT id, name, highway, oneway, lanes, geometry
           FROM ways
           WHERE max_lat >= ? AND min_lat <= ?
             AND max_lon >= ? AND min_lon <= ?""",
        (south, north, west, east),
    ).fetchall()

    ways = []
    for row in rows:
        geometry = json.loads(row["geometry"])
        ways.append({
            "id": row["id"],
            "geometry": geometry,
            "tags": {
                "name": row["name"] or None,
                "highway": row["highway"],
                "oneway": row["oneway"] or None,
                "lanes": row["lanes"] or None,
            },
        })

    return ways
