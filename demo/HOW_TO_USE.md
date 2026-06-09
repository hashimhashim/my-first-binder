# How to Use the Cybersecurity Skills

## What's in `skills/`

Each folder under `skills/` is one cybersecurity skill. Every skill contains:

```
skills/analyzing-indicators-of-compromise/
├── SKILL.md          ← human-readable workflow (steps, code, pitfalls)
├── scripts/
│   └── agent.py      ← ready-to-run agent script
└── references/
    └── api-reference.md
```

---

## 3 Ways to Use a Skill

### 1. Read the skill and follow the workflow manually

```bash
cat skills/analyzing-indicators-of-compromise/SKILL.md
```

Open it, follow the steps, copy the code snippets into your own scripts.

---

### 2. Run the bundled agent script directly

```bash
python3 skills/analyzing-cobalt-strike-beacon-configuration/scripts/agent.py
```

Each `agent.py` is a self-contained script. Some require API keys — check the
`## Prerequisites` section in the matching `SKILL.md`.

---

### 3. Run the demo (this folder)

The `demo/` folder contains polished, runnable demos of selected skills:

| File | Skill demonstrated |
|------|-------------------|
| `ioc_demo.py` | `analyzing-indicators-of-compromise` |

**Run with mock data (no API keys needed):**
```bash
python3 demo/ioc_demo.py
```

**Analyze your own IOCs:**
```bash
python3 demo/ioc_demo.py 1.2.3.4 evil-domain.xyz abc123hashvalue
```

**Run with real APIs:**
```bash
export VT_API_KEY=your_virustotal_key
export ABUSE_API_KEY=your_abuseipdb_key
python3 demo/ioc_demo.py --live 1.2.3.4 evil-domain.xyz
```

---

## Finding the Right Skill

**Search by topic:**
```bash
ls skills/ | grep ransomware
ls skills/ | grep phishing
ls skills/ | grep forensics
```

**Search by MITRE ATT&CK technique:**
```bash
grep -rl "T1566" skills/
```

**Search by NIST CSF function:**
```bash
grep -rl "DE.CM" skills/   # Detect > Continuous Monitoring
grep -rl "RS.AN" skills/   # Respond > Analysis
```

**Browse the full index:**
```bash
python3 -c "
import json
with open('index.json') as f:
    skills = json.load(f)
for s in skills[:10]:
    print(s.get('name'), '-', s.get('description','')[:60])
"
```

---

## Skill domains available

| Domain | Example skills |
|--------|---------------|
| threat-intelligence | IOC analysis, APT profiling, MITRE Navigator |
| digital-forensics | Disk imaging, memory forensics, email headers |
| malware-analysis | Ghidra, YARA rules, sandbox analysis |
| cloud-security | AWS/Azure/GCP log analysis, IAM review |
| web-application | SQL injection, XSS, API security |
| incident-response | Containment, eradication, recovery |
| network-security | PCAP analysis, DNS exfiltration, IDS tuning |
| identity-access | AD ACL abuse, privilege escalation |

754 skills total across 26 domains.
