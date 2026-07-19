"""Vantage GRC — demo instance.

A minimal, standalone stand-in for a real Vantage GRC, implementing the REST
contract the IAM VantageGrcConnector drives (see
backend/app/connectors/vantage_grc.py). Deliberately shaped differently from
the Aegis SIEM demo — PUT-upsert identities, a status string, entitlements —
so the two demo targets prove the connector framework generalizes, not just
that it works once.

Lets you watch IAM provision identities into "the GRC tool" live: hire
someone in IAM, refresh this page, see the identity appear; terminate them,
see it go disabled.

Not part of the IAM product — it's a demo target so the integration can be
seen end to end without a real GRC platform. Point the connector at your real
Vantage GRC (or any GRC exposing this shape) by changing the application's
base_url in IAM.

State is in-memory (resets on restart). Run: uvicorn app:app --port 9600
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

app = FastAPI(title="Vantage GRC (demo)")
IDENTITIES: dict[str, dict] = {}


class UpsertIdentity(BaseModel):
    email: str | None = None
    fullName: str | None = None
    riskDomain: str | None = None
    externalId: str | None = None
    status: str = "enabled"


class StatusBody(BaseModel):
    status: str


# --- REST contract (consumed by the IAM connector) ---------------------------
@app.get("/v1/ping")
def ping():
    return {"status": "ok", "identities": len(IDENTITIES)}


@app.get("/v1/identities")
def list_identities():
    return {"identities": list(IDENTITIES.values()), "nextCursor": None}


@app.put("/v1/identities/{ident}")
def upsert_identity(ident: str, body: UpsertIdentity):
    existing = IDENTITIES.get(ident, {"entitlements": []})
    IDENTITIES[ident] = {**existing, **body.model_dump(), "id": ident,
                         "entitlements": existing["entitlements"]}
    return IDENTITIES[ident]


@app.get("/v1/identities/{ident}")
def get_identity(ident: str):
    if ident not in IDENTITIES:
        raise HTTPException(404, "not found")
    return IDENTITIES[ident]


@app.patch("/v1/identities/{ident}/status")
def set_status(ident: str, body: StatusBody):
    if ident not in IDENTITIES:
        raise HTTPException(404, "not found")
    IDENTITIES[ident]["status"] = body.status
    return IDENTITIES[ident]


@app.delete("/v1/identities/{ident}", status_code=204)
def delete_identity(ident: str):
    if ident not in IDENTITIES:
        raise HTTPException(404, "not found")
    del IDENTITIES[ident]


@app.put("/v1/identities/{ident}/entitlements/{name}")
def grant_entitlement(ident: str, name: str):
    if ident not in IDENTITIES:
        raise HTTPException(404, "not found")
    ents = IDENTITIES[ident]["entitlements"]
    if name not in ents:
        ents.append(name)
    return IDENTITIES[ident]


@app.delete("/v1/identities/{ident}/entitlements/{name}", status_code=204)
def revoke_entitlement(ident: str, name: str):
    if ident not in IDENTITIES or name not in IDENTITIES[ident]["entitlements"]:
        raise HTTPException(404, "not found")
    IDENTITIES[ident]["entitlements"].remove(name)


# --- viewer (so you can SEE the GRC tool in a browser) ------------------------
@app.get("/", response_class=HTMLResponse)
def viewer():
    return """<!doctype html><html><head><meta charset="utf-8"><title>Vantage GRC (demo)</title>
<style>
  :root{--bg:#171310;--surface:#211b16;--surface2:#2a221b;--ink:#efe6db;--muted:#a89a86;
    --line:#3a2f26;--accent:#e0a63a;--good:#e0a63a;--good-bg:#332813;--neutral:#2a221b;
    --mono:ui-monospace,Menlo,monospace;--sans:"Segoe UI",system-ui,sans-serif}
  @media(prefers-color-scheme:light){:root{--bg:#f6f2ec;--surface:#fff;--surface2:#efe7db;
    --ink:#241d15;--muted:#6b5d4a;--line:#e0d5c2;--accent:#8a5a10;--good:#8a5a10;--good-bg:#f4e6c8;--neutral:#efe7db}}
  body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 var(--sans)}
  header{padding:20px 24px;border-bottom:1px solid var(--line);background:var(--surface);display:flex;align-items:center;gap:12px}
  .logo{font-weight:700}.logo b{color:var(--accent)}
  .sub{color:var(--muted);font-size:12.5px}
  main{max-width:960px;margin:24px auto;padding:0 20px}
  .bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .count{font:600 13px var(--mono);color:var(--muted)}
  table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th{text-align:left;font:600 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
    padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface2)}
  td{padding:11px 16px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:none}
  .pill{display:inline-block;padding:1px 9px 2px;border-radius:999px;font:600 10.5px var(--mono)}
  .pill.on{background:var(--good-bg);color:var(--good)}.pill.off{background:var(--neutral);color:var(--muted)}
  .ent{font:11px var(--mono);padding:1px 8px;border:1px solid var(--line);border-radius:999px;margin-right:4px}
  .empty{padding:30px;text-align:center;color:var(--muted)}
  .mono{font-family:var(--mono);font-size:12px}.muted{color:var(--muted)}
</style></head><body>
<header><div class="logo"><b>&#9671;</b> Vantage GRC <span class="sub">demo instance</span></div>
  <div style="flex:1"></div><div class="sub">managed by IAM &middot; auto-refreshing</div></header>
<main>
  <div class="bar"><h2 style="margin:0;font-size:18px">Identities &amp; Entitlements</h2><div class="count" id="count"></div></div>
  <table><thead><tr><th>Identity</th><th>Full name</th><th>Risk domain</th><th>Status</th><th>Entitlements</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="sub" style="margin-top:14px">This table is written to <em>only</em> by IAM's provisioning connector.
     Hire or terminate a user in IAM (localhost:8010) and watch it change here.</p>
</main>
<script>
async function refresh(){
  try{
    const {identities}=await (await fetch('/v1/identities')).json();
    document.getElementById('count').textContent=identities.length+' identit'+(identities.length===1?'y':'ies');
    document.getElementById('rows').innerHTML = identities.length ? identities.map(u=>`
      <tr><td class="mono"><b>${esc(u.id)}</b></td><td>${esc(u.fullName||'')}</td>
      <td>${esc(u.riskDomain||'—')}</td>
      <td><span class="pill ${u.status==='enabled'?'on':'off'}">${(u.status||'').toUpperCase()}</span></td>
      <td>${(u.entitlements||[]).map(r=>`<span class="ent">${esc(r)}</span>`).join('')||'<span class="muted">—</span>'}</td></tr>
    `).join('') : '<tr><td colspan="5" class="empty">No identities yet. Hire someone in IAM to provision one here.</td></tr>';
  }catch(e){}
}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
refresh(); setInterval(refresh, 2000);
</script></body></html>"""
