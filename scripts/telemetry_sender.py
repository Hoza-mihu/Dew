#!/usr/bin/env python3
"""
Example: Send telemetry to DEW API from Python (e.g. simulate Plant Bot or use from another service).
Run with venv active: python scripts/telemetry_sender.py
"""
import os
import sys

try:
    import requests
    from dotenv import load_dotenv
except ImportError:
    print("Activate venv and install deps: pip install -r requirements.txt")
    sys.exit(1)

load_dotenv()
API_URL = os.getenv("DEW_API_URL", "http://localhost:3000")
# Preferred: device token from dashboard (Plant Fleet → device token). Auto-created per account.
DEW_INGEST_TOKEN = os.getenv("DEW_INGEST_TOKEN", "").strip()
# Legacy: Firebase user id string (same as dashboard “uid” copy).
DEW_UID = os.getenv("DEW_UID", "").strip()

def send_telemetry(plant_id: str, moisture: float, temp: float, lux: int, humidity: float = None):
    payload = {
        "plantId": plant_id,
        "moisture": moisture,
        "temp": temp,
        "lux": lux,
    }
    if humidity is not None:
        payload["humidity"] = humidity
    if DEW_INGEST_TOKEN:
        payload["ingestToken"] = DEW_INGEST_TOKEN
    elif DEW_UID:
        payload["uid"] = DEW_UID
    r = requests.post(f"{API_URL}/api/telemetry", json=payload, timeout=5)
    r.raise_for_status()
    return r.json()

if __name__ == "__main__":
    # Example: update pothos with mock readings
    result = send_telemetry("pothos", moisture=72.5, temp=23.2, lux=2100, humidity=52)
    print("OK:", result.get("plant", result))
