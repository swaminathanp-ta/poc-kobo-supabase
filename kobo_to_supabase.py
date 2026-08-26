#!/usr/bin/env python3
"""Compatibility launcher for the packaged Kobo to Supabase sync command."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from bvl_registration.sync import main


if __name__ == "__main__":
    main()
