#!/usr/bin/env python3
"""
Demo of the 'analyzing-indicators-of-compromise' cybersecurity skill.

Run:   python3 demo/ioc_demo.py
       python3 demo/ioc_demo.py --live   (requires real API keys in env vars)

Skill source: skills/analyzing-indicators-of-compromise/SKILL.md
"""

import re
import json
import hashlib
import argparse
import os
from dataclasses import dataclass, field
from typing import Literal

# ── Types ─────────────────────────────────────────────────────────────────────

IOCType = Literal["ip", "domain", "url", "hash", "email"]
Disposition = Literal["BLOCK", "MONITOR", "INVESTIGATE", "WHITELIST"]

@dataclass
class IOC:
    value: str
    ioc_type: IOCType
    vt_detections: int = 0
    vt_total: int = 0
    abuse_score: int = 0
    malware_family: str = ""
    campaign: str = ""
    confidence: int = 0
    disposition: Disposition = "INVESTIGATE"
    notes: list[str] = field(default_factory=list)

# ── Step 1: Classify IOCs ─────────────────────────────────────────────────────

def classify(value: str) -> IOCType:
    value = value.strip()
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", value):
        return "ip"
    if re.match(r"^[a-fA-F0-9]{32,64}$", value):
        return "hash"
    if re.match(r"^https?://", value):
        return "url"
    if re.match(r"^[^@]+@[^@]+\.[^@]+$", value):
        return "email"
    return "domain"

def defang(value: str) -> str:
    return value.replace(".", "[.]").replace("://", "[://]")

# ── Step 2: Mock enrichment (mirrors real API shape) ──────────────────────────

MOCK_THREAT_DB = {
    "185.220.101.45":   {"vt": (52, 70), "abuse": 97,  "family": "TorExitNode",    "campaign": "APT29-Infrastructure"},
    "8.8.8.8":          {"vt": (0,  70), "abuse": 0,   "family": "",               "campaign": ""},
    "evil-login[.]xyz": {"vt": (38, 70), "abuse": 85,  "family": "PhishKit",       "campaign": "CredHarvest-2024"},
    "microsoft[.]com":  {"vt": (0,  70), "abuse": 0,   "family": "",               "campaign": ""},
    "a3f2c9d1" + "0"*56:{"vt": (61, 70), "abuse": 0,  "family": "Emotet",         "campaign": "Emotet-Wave-7"},
    "d41d8cd98f00b204e9800998ecf8427e": {"vt": (0, 70),"abuse": 0, "family": "",   "campaign": ""},  # MD5 of empty
}

def _lookup(value: str) -> dict:
    key = defang(value) if classify(value) in ("domain", "url") else value
    return MOCK_THREAT_DB.get(key, {"vt": (2, 70), "abuse": 10, "family": "", "campaign": ""})

def enrich_mock(ioc: IOC) -> IOC:
    data = _lookup(ioc.value)
    ioc.vt_detections, ioc.vt_total = data["vt"]
    ioc.abuse_score = data["abuse"]
    ioc.malware_family = data["family"]
    ioc.campaign = data["campaign"]
    return ioc

def enrich_live(ioc: IOC) -> IOC:
    """Real enrichment — requires VT_API_KEY and ABUSE_API_KEY env vars."""
    import requests

    vt_key = os.environ["VT_API_KEY"]
    abuse_key = os.environ["ABUSE_API_KEY"]

    endpoint_map = {
        "ip":     f"https://www.virustotal.com/api/v3/ip_addresses/{ioc.value}",
        "domain": f"https://www.virustotal.com/api/v3/domains/{ioc.value}",
        "url":    f"https://www.virustotal.com/api/v3/urls/{hashlib.sha256(ioc.value.encode()).hexdigest()}",
        "hash":   f"https://www.virustotal.com/api/v3/files/{ioc.value}",
    }

    if ioc.ioc_type in endpoint_map:
        r = requests.get(endpoint_map[ioc.ioc_type], headers={"x-apikey": vt_key}, timeout=10)
        if r.ok:
            stats = r.json()["data"]["attributes"]["last_analysis_stats"]
            ioc.vt_detections = stats.get("malicious", 0)
            ioc.vt_total = sum(stats.values())

    if ioc.ioc_type == "ip":
        r = requests.get(
            "https://api.abuseipdb.com/api/v2/check",
            headers={"Key": abuse_key, "Accept": "application/json"},
            params={"ipAddress": ioc.value, "maxAgeInDays": 90},
            timeout=10,
        )
        if r.ok:
            ioc.abuse_score = r.json()["data"]["abuseConfidenceScore"]

    return ioc

# ── Step 3: Score & disposition ───────────────────────────────────────────────

def score(ioc: IOC) -> IOC:
    vt_ratio = ioc.vt_detections / ioc.vt_total if ioc.vt_total else 0
    points = 0

    # VirusTotal signal
    if ioc.vt_detections >= 15:
        points += 50
        ioc.notes.append(f"High VT detections: {ioc.vt_detections}/{ioc.vt_total}")
    elif ioc.vt_detections >= 5:
        points += 25
        ioc.notes.append(f"Moderate VT detections: {ioc.vt_detections}/{ioc.vt_total}")

    # AbuseIPDB signal
    if ioc.abuse_score >= 70:
        points += 30
        ioc.notes.append(f"High AbuseIPDB score: {ioc.abuse_score}%")
    elif ioc.abuse_score >= 30:
        points += 15

    # Known malware / campaign
    if ioc.malware_family:
        points += 15
        ioc.notes.append(f"Malware family: {ioc.malware_family}")
    if ioc.campaign:
        points += 10
        ioc.notes.append(f"Campaign: {ioc.campaign}")

    # Private / reserved IPs are never malicious externally
    if ioc.ioc_type == "ip" and ioc.value.startswith(("10.", "192.168.", "172.")):
        points = 0
        ioc.notes.append("RFC1918 private address — skip external enrichment")

    ioc.confidence = min(points, 100)

    if ioc.confidence >= 70:
        ioc.disposition = "BLOCK"
    elif ioc.confidence >= 40:
        ioc.disposition = "MONITOR"
    elif ioc.confidence >= 10:
        ioc.disposition = "INVESTIGATE"
    else:
        ioc.disposition = "WHITELIST"

    return ioc

# ── Step 4: Report ────────────────────────────────────────────────────────────

COLOUR = {
    "BLOCK":       "\033[91m",  # red
    "MONITOR":     "\033[93m",  # yellow
    "INVESTIGATE": "\033[96m",  # cyan
    "WHITELIST":   "\033[92m",  # green
    "RESET":       "\033[0m",
}

def report(iocs: list[IOC]) -> None:
    print("\n" + "=" * 62)
    print("  IOC ENRICHMENT REPORT")
    print("=" * 62)

    for ioc in iocs:
        colour = COLOUR[ioc.disposition]
        reset  = COLOUR["RESET"]

        print(f"\n  IOC      : {defang(ioc.value)}")
        print(f"  Type     : {ioc.ioc_type}")
        print(f"  VT Score : {ioc.vt_detections}/{ioc.vt_total} engines")
        if ioc.ioc_type == "ip":
            print(f"  AbuseIPDB: {ioc.abuse_score}% confidence")
        print(f"  Confidence: {ioc.confidence}%")
        print(f"  Decision : {colour}{ioc.disposition}{reset}")
        for note in ioc.notes:
            print(f"    ↳ {note}")

    print("\n" + "=" * 62)
    summary = {d: sum(1 for i in iocs if i.disposition == d)
               for d in ("BLOCK", "MONITOR", "INVESTIGATE", "WHITELIST")}
    print("  SUMMARY")
    for disposition, count in summary.items():
        if count:
            colour = COLOUR[disposition]
            reset  = COLOUR["RESET"]
            print(f"    {colour}{disposition:12}{reset} {count}")
    print("=" * 62 + "\n")

# ── Main ──────────────────────────────────────────────────────────────────────

SAMPLE_IOCS = [
    "185.220.101.45",                        # Tor exit node / APT infra
    "8.8.8.8",                               # Google DNS — benign
    "evil-login.xyz",                        # Phishing domain
    "microsoft.com",                         # Legitimate domain
    "a3f2c9d1" + "0" * 56,                  # Emotet hash (64-char SHA-256)
    "d41d8cd98f00b204e9800998ecf8427e",      # MD5 of empty file — benign
]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true",
                        help="Use real VirusTotal + AbuseIPDB APIs (set VT_API_KEY, ABUSE_API_KEY)")
    parser.add_argument("iocs", nargs="*", default=SAMPLE_IOCS,
                        help="IOC values to analyze (default: built-in sample set)")
    args = parser.parse_args()

    enricher = enrich_live if args.live else enrich_mock
    mode = "LIVE" if args.live else "DEMO (mock data)"
    print(f"\n  Skill: analyzing-indicators-of-compromise  [{mode}]")
    print(f"  IOCs : {len(args.iocs)}")

    results = []
    for raw in args.iocs:
        ioc = IOC(value=raw.strip(), ioc_type=classify(raw.strip()))
        ioc = enricher(ioc)
        ioc = score(ioc)
        results.append(ioc)

    report(results)

if __name__ == "__main__":
    main()
