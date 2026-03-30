"""
Ingest OSM PBF file into SpatiaLite streets database.

Usage:
    python backend/ingest_osm.py path/to/region-latest.osm.pbf

Outputs: backend/data/streets.db
"""

import json
import sqlite3
import sys
from pathlib import Path

import osmium

# Same highway types as the Overpass query
VALID_HIGHWAYS = {"primary", "secondary", "tertiary", "residential", "unclassified"}
TAGS_TO_EXTRACT = ("name", "highway", "oneway", "lanes")

DB_DIR = Path(__file__).parent / "data"
DB_PATH = DB_DIR / "streets.db"


class WayHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []

    def way(self, w):
        highway = w.tags.get("highway", "")
        if highway not in VALID_HIGHWAYS:
            return

        tags = {}
        for key in TAGS_TO_EXTRACT:
            val = w.tags.get(key)
            if val:
                tags[key] = val

        # Collect node coordinates
        coords = []
        try:
            for n in w.nodes:
                coords.append((n.lat, n.lon))
        except osmium.InvalidLocationError:
            return

        if len(coords) < 2:
            return

        geometry = [{"lat": lat, "lon": lon} for lat, lon in coords]

        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]

        self.ways.append({
            "id": w.id,
            "name": tags.get("name", ""),
            "highway": tags.get("highway", highway),
            "oneway": tags.get("oneway", ""),
            "lanes": tags.get("lanes", ""),
            "geometry": json.dumps(geometry),
            "min_lat": min(lats),
            "max_lat": max(lats),
            "min_lon": min(lons),
            "max_lon": max(lons),
        })


def create_db(db_path: Path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE ways (
            id INTEGER PRIMARY KEY,
            name TEXT,
            highway TEXT NOT NULL,
            oneway TEXT,
            lanes TEXT,
            geometry TEXT NOT NULL,
            min_lat REAL,
            max_lat REAL,
            min_lon REAL,
            max_lon REAL
        )
    """)
    conn.execute("""
        CREATE INDEX idx_ways_bbox
        ON ways(min_lat, max_lat, min_lon, max_lon)
    """)
    conn.commit()
    return conn


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path/to/file.osm.pbf>")
        sys.exit(1)

    pbf_path = sys.argv[1]
    if not Path(pbf_path).exists():
        print(f"File not found: {pbf_path}")
        sys.exit(1)

    print(f"Ingesting {pbf_path} ...")
    handler = WayHandler()
    handler.apply_file(pbf_path, locations=True)
    print(f"Extracted {len(handler.ways)} ways")

    conn = create_db(DB_PATH)
    conn.executemany(
        """INSERT INTO ways (id, name, highway, oneway, lanes, geometry,
                             min_lat, max_lat, min_lon, max_lon)
           VALUES (:id, :name, :highway, :oneway, :lanes, :geometry,
                   :min_lat, :max_lat, :min_lon, :max_lon)""",
        handler.ways,
    )
    conn.commit()

    count = conn.execute("SELECT count(*) FROM ways").fetchone()[0]
    conn.close()
    print(f"Wrote {count} ways to {DB_PATH}")
    size_mb = DB_PATH.stat().st_size / (1024 * 1024)
    print(f"DB size: {size_mb:.1f} MB")


if __name__ == "__main__":
    main()
