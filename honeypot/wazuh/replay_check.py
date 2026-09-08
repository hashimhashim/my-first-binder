#!/usr/bin/env python3
"""
Offline replay checker for honey-bit_rules.xml.

This is NOT Wazuh. It emulates the subset of Wazuh rule semantics these rules
use so the rule file can be sanity-checked without a manager:
  - decoded_as json, <field name=..> regex match (OS_Regex subset or pcre2)
  - if_sid (parent must have matched this event)
  - if_matched_sid / if_matched_group + frequency + timeframe with
    same_field / different_field. As in Wazuh, the current event must itself
    match the referenced rule/group; the count includes the current event.
  - the highest-numbered (most specific) matching rule wins the alert.
Always confirm on a real manager with wazuh-logtest before relying on it.

Usage: python3 replay_check.py [events.jsonl]   (default ../samples/events.jsonl)
"""
import collections, json, re, sys, xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULES = HERE / "honey-bit_rules.xml"
EVENTS = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "samples" / "events.jsonl"


def os_regex_to_py(pat: str) -> str:
    return pat.replace(r"\S", r"[^ ]").replace(r"\s", " ")


def ids(text):
    return [int(x) for x in (text or "").replace(" ", "").split(",") if x]


root = ET.fromstring("<root>" + RULES.read_text() + "</root>")
top_groups = {g for g in root.find("group").get("name").split(",") if g}
rules = []
for r in root.iter("rule"):
    rule = dict(
        id=int(r.get("id")), level=int(r.get("level")),
        frequency=int(r.get("frequency", 0)), timeframe=int(r.get("timeframe", 0)),
        if_sid=ids(r.findtext("if_sid")), if_matched_sid=ids(r.findtext("if_matched_sid")),
        if_matched_group=r.findtext("if_matched_group"),
        same_field=r.findtext("same_field"), different_field=r.findtext("different_field"),
        decoded_as=r.findtext("decoded_as"), desc=r.findtext("description") or "",
        fields=[(f.get("name"), re.compile(f.text if f.get("type") == "pcre2" else os_regex_to_py(f.text)))
                for f in r.findall("field")],
        groups=set(top_groups),
    )
    for g in r.findall("group"):
        rule["groups"] |= {x for x in g.text.split(",") if x}
    rules.append(rule)
by_id = {r["id"]: r for r in rules}


def fields_ok(rule, ev):
    return all(ev.get(n) is not None and rx.search(str(ev[n])) for n, rx in rule["fields"])


events = [json.loads(l) for l in EVENTS.read_text().splitlines()]
history = []            # (ts, alert_rule_id, groups, event) for events that produced an alert
fired = collections.Counter()

for ev in events:
    ts = ev["ts_epoch"]
    matched = set()     # rules this event satisfies (parents included)
    for rule in rules:  # file order: parents before children
        if rule["decoded_as"] and rule["decoded_as"] != "json":
            continue
        if rule["if_sid"] and not matched.intersection(rule["if_sid"]):
            continue
        if not fields_ok(rule, ev):
            continue
        if rule["frequency"]:
            if rule["if_matched_sid"] and not matched.intersection(rule["if_matched_sid"]):
                continue
            cur_groups = set().union(*(by_id[m]["groups"] for m in matched)) if matched else set()
            if rule["if_matched_group"] and rule["if_matched_group"] not in cur_groups:
                continue
            prev = [h for h in history
                    if ts - h[0] <= rule["timeframe"]
                    and ((rule["if_matched_sid"] and (h[1] in rule["if_matched_sid"] or h[4].intersection(rule["if_matched_sid"])))
                         or (rule["if_matched_group"] and rule["if_matched_group"] in h[2]))
                    and (not rule["same_field"] or h[3].get(rule["same_field"]) == ev.get(rule["same_field"]))
                    and (not rule["different_field"] or h[3].get(rule["different_field"]) != ev.get(rule["different_field"]))]
            if len(prev) + 1 < rule["frequency"]:
                continue
        matched.add(rule["id"])
    if matched:
        final = by_id[max(matched)]
        fired[final["id"]] += 1
        history.append((ts, final["id"], final["groups"], ev, matched))

expected = {  # seed-42 Phase 1 run: 18 connections, 10 logins (5 telnet + 5 ftp), 7 http (4 with indicators)
    100801: ("==", 1), 100802: ("==", 1),
    100810: (">=", 7),   # connections not absorbed by the scan rule
    100812: (">=", 1),   # first login attempts before brute-force / multi-service kick in
    100814: (">=", 1), 100815: ("==", 1), 100816: ("==", 1),
    100830: (">=", 1), 100831: (">=", 1), 100832: (">=", 1), 100833: (">=", 1),
}
print(f"{'rule':6} {'lvl':>3} {'count':>5}  description")
for rid in sorted(fired):
    print(f"{rid:6} {by_id[rid]['level']:>3} {fired[rid]:>5}  {by_id[rid]['desc'][:72]}")
print()
ok = True
for rid, (op, n) in expected.items():
    c = fired[rid]
    good = (c == n) if op == "==" else (c >= n)
    ok &= good
    print(f"{'PASS' if good else 'FAIL'}  rule {rid}: expected {op} {n}, got {c}")
print("\nlogin attempts total:", sum(fired[r] for r in (100812, 100830, 100833)),
      "| connections total:", fired[100810] + fired[100831],
      "| http total:", fired[100813] + fired[100814] + fired[100832])
print("OVERALL:", "PASS" if ok else "FAIL", "(emulation only; confirm with wazuh-logtest)")
sys.exit(0 if ok else 1)
