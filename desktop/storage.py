"""Small, local-only SQLite store for the desktop application's preferences and history."""
from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import threading
import time


def default_data_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "MyVideoApp" / "Desktop"
    return Path.home() / ".local" / "share" / "MyVideoApp" / "Desktop"


class Storage:
    """Connections belong to one operation, so GUI and worker threads can share this object."""

    def __init__(self, directory: Path | None = None):
        self.directory = Path(directory) if directory is not None else default_data_dir()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "desktop.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as database:
            database.execute("PRAGMA journal_mode=WAL")
            version = database.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise RuntimeError("This desktop history was created by a newer application.")
            database.executescript("""
                CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                    folder TEXT NOT NULL, quality TEXT NOT NULL, output TEXT NOT NULL,
                    stage TEXT NOT NULL, filepath TEXT, message TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    requires_url INTEGER NOT NULL DEFAULT 0, request_digest TEXT NOT NULL,
                    scan INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at DESC);
                PRAGMA user_version=1;
            """)
            # An earlier application process may have stopped without a final callback.
            database.execute("UPDATE jobs SET stage='error', message='이전 실행이 중단되었습니다. 다시 시도하면 안전하게 이어받습니다.' "
                             "WHERE stage IN ('queued','downloading','processing')")

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def settings(self) -> dict:
        with self.lock, self.connect() as database:
            return {row["key"]: json.loads(row["value"]) for row in database.execute("SELECT key,value FROM preferences")}

    def save_settings(self, values: dict):
        allowed = {"download_folder", "folder_confirmed", "theme", "concurrent_downloads", "scan_after_download", "quality", "output"}
        clean = {key: value for key, value in values.items() if key in allowed}
        if "download_folder" in clean and not isinstance(clean["download_folder"], str):
            raise ValueError("Download folder must be a path.")
        if "theme" in clean and clean["theme"] not in ("system", "dark", "light"):
            raise ValueError("Unknown theme.")
        if "concurrent_downloads" in clean and (type(clean["concurrent_downloads"]) is not int or not 1 <= clean["concurrent_downloads"] <= 3):
            raise ValueError("Choose one to three simultaneous downloads.")
        if "scan_after_download" in clean and type(clean["scan_after_download"]) is not bool:
            raise ValueError("Invalid scan preference.")
        if "folder_confirmed" in clean and type(clean["folder_confirmed"]) is not bool:
            raise ValueError("Invalid folder confirmation.")
        if "quality" in clean and clean["quality"] not in ("highest", "2160", "1440", "1080", "720", "480"):
            raise ValueError("Unknown quality.")
        if "output" in clean and clean["output"] not in ("original", "mp4", "webm", "mkv", "mp3", "m4a"):
            raise ValueError("Unknown output format.")
        with self.lock, self.connect() as database:
            database.executemany("INSERT INTO preferences(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                 [(key, json.dumps(value, ensure_ascii=False)) for key, value in clean.items()])

    def get(self, job_id: str) -> dict | None:
        with self.lock, self.connect() as database:
            row = database.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            return dict(row) if row else None

    def history(self) -> list[dict]:
        with self.lock, self.connect() as database:
            return [dict(row) for row in database.execute("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 200")]

    def insert(self, job: dict):
        now = time.time()
        value = {**job, "created_at": now, "updated_at": now}
        columns = tuple(value)
        with self.lock, self.connect() as database:
            database.execute(f"INSERT INTO jobs ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", tuple(value.values()))
            database.execute("DELETE FROM jobs WHERE job_id IN (SELECT job_id FROM jobs "
                             "WHERE stage IN ('complete','cancelled','error') ORDER BY updated_at DESC LIMIT -1 OFFSET 200)")

    def update(self, job_id: str, **values):
        if set(values) - {"title", "stage", "filepath", "message"}:
            raise ValueError("Unknown history field.")
        values["updated_at"] = time.time()
        with self.lock, self.connect() as database:
            database.execute("UPDATE jobs SET " + ",".join(f"{key}=?" for key in values) + " WHERE job_id=?",
                             (*values.values(), job_id))

    def remove(self, job_id: str):
        with self.lock, self.connect() as database:
            database.execute("DELETE FROM jobs WHERE job_id=? AND stage IN ('complete','cancelled','error')", (job_id,))
