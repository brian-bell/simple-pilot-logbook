"""Pytest fixtures for database tests.

Requires DATABASE_URL environment variable pointing to a Postgres instance.
"""

import os
import sys

import psycopg2
import pytest

# Allow imports from backend/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture(scope="session", autouse=True)
def db_pool():
    """Initialise the database pool once for the entire test session."""
    import database

    database.init_db()
    yield
    # Tear down: drop the flights table and close the pool.
    conn = database._get_conn()
    try:
        conn.execute("DROP TABLE IF EXISTS flights")
        conn.commit()
    finally:
        database._put_conn(conn)
    database.close_pool()


@pytest.fixture(autouse=True)
def clean_table():
    """Truncate the flights table before each test for isolation."""
    import database

    conn = database._get_conn()
    try:
        conn.execute("TRUNCATE flights RESTART IDENTITY")
        conn.commit()
    finally:
        database._put_conn(conn)
