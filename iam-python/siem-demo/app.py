"""Aegis SIEM — demo instance.

A minimal, standalone stand-in for the real Aegis SIEM, implementing the REST
contract the IAM AegisSiemConnector drives (see
backend/app/connectors/aegis_siem.py). Lets you watch IAM provision users into
"the SIEM" live: hire someone in IAM, refresh this page, see the account
appear; terminate them, see it go disabled.

Not part of the IAM product — it's a demo target so the integration can be
seen end to end without a real SIEM. Point the connector at your real Aegis
SIEM by changing the application's base_url in IAM.

State is in-memory (resets on restart). Run: uvicorn app:app --port 9500
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

app = FastAPI(title="Aegis SIEM (demo)")
USERS: dict[str, dict] = {}


class CreateUser(BaseModel):
    username: str
    email: str | None = None
    displayName: str | None = None
    department: str | None = None
    externalId: str | None = None
    active: bool = True


class RoleBody(BaseModel):
    role: str


# --- REST contract (consumed by the IAM connector) ---------------------------
@app.get("/api/health")
def health():
    return {"status": "ok", "users": len(USERS)}


@app.get("/api/users")
def list_users():
    return {"users": list(USERS.values())}


@app.post("/api/users", status_code=201)
def create_user(body: CreateUser):
    if body.username in USERS:
        raise HTTPException(409, "user already exists")
    USERS[body.username] = {**body.model_dump(), "roles": []}
    return USERS[body.username]


@app.get("/api/users/{username}")
def get_user(username: str):
    if username not in USERS:
        raise HTTPException(404, "not found")
    return USERS[username]


@app.patch("/api/users/{username}")
def update_user(username: str, body: dict):
    if username not in USERS:
        raise HTTPException(404, "not found")
    USERS[username].update({k: v for k, v in body.items() if k != "roles"})
    return USERS[username]


@app.post("/api/users/{username}/disable")
def disable_user(username: str):
    if username not in USERS:
        raise HTTPException(404, "not found")
    USERS[username]["active"] = False
    return USERS[username]


@app.post("/api/users/{username}/enable")
def enable_user(username: str):
    if username not in USERS:
        raise HTTPException(404, "not found")
    USERS[username]["active"] = True
    return USERS[username]


@app.delete("/api/users/{username}", status_code=204)
def delete_user(username: str):
    if username not in USERS:
        raise HTTPException(404, "not found")
    del USERS[username]


@app.post("/api/users/{username}/roles", status_code=201)
def assign_role(username: str, body: RoleBody):
    if username not in USERS:
        raise HTTPException(404, "not found")
    if body.role in USERS[username]["roles"]:
        raise HTTPException(409, "role already assigned")
    USERS[username]["roles"].append(body.role)
    return USERS[username]


@app.delete("/api/users/{username}/roles/{role}", status_code=204)
def remove_role(username: str, role: str):
    if username not in USERS or role not in USERS[username]["roles"]:
        raise HTTPException(404, "not found")
    USERS[username]["roles"].remove(role)


# --- viewer (so you can SEE the SIEM in a browser) ---------------------------
@app.get("/", response_class=HTMLResponse)
def viewer():
    return """<!doctype html><html><head><meta charset="utf-8"><title>Aegis SIEM (demo)</title>
<style>
  :root{--bg:#0f1514;--surface:#171f1d;--surface2:#1e2825;--ink:#e2eae6;--muted:#93a39d;
    --line:#2b3733;--accent:#56bdcc;--good:#6cc493;--good-bg:#1a2f23;--neutral:#232e2b;
    --mono:ui-monospace,Menlo,monospace;--sans:"Segoe UI",system-ui,sans-serif}
  @media(prefers-color-scheme:light){:root{--bg:#f2f5f4;--surface:#fff;--surface2:#e9eeec;
    --ink:#1a2422;--muted:#5d6c67;--line:#d5ddda;--accent:#0e6e7e;--good:#2f7d4f;--good-bg:#e3f0e8;--neutral:#e7ebe9}}
  body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 var(--sans)}
  header{padding:20px 24px;border-bottom:1px solid var(--line);background:var(--surface);display:flex;align-items:center;gap:12px}
  .logo{font-weight:700}.logo b{color:var(--accent)}
  .sub{color:var(--muted);font-size:12.5px}
  main{max-width:900px;margin:24px auto;padding:0 20px}
  .bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .count{font:600 13px var(--mono);color:var(--muted)}
  table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th{text-align:left;font:600 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
    padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface2)}
  td{padding:11px 16px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:none}
  .pill{display:inline-block;padding:1px 9px 2px;border-radius:999px;font:600 10.5px var(--mono)}
  .pill.on{background:var(--good-bg);color:var(--good)}.pill.off{background:var(--neutral);color:var(--muted)}
  .role{font:11px var(--mono);padding:1px 8px;border:1px solid var(--line);border-radius:999px;margin-right:4px}
  .empty{padding:30px;text-align:center;color:var(--muted)}
  .mono{font-family:var(--mono);font-size:12px}.muted{color:var(--muted)}
</style></head><body>
<header><div class="logo"><b>&#9670;</b> Aegis SIEM <span class="sub">demo instance</span></div>
  <div style="flex:1"></div><div class="sub">managed by IAM &middot; auto-refreshing</div></header>
<main>
  <div class="bar"><h2 style="margin:0;font-size:18px">Users &amp; Roles</h2><div class="count" id="count"></div></div>
  <table><thead><tr><th>Username</th><th>Display name</th><th>Dept</th><th>Status</th><th>Roles</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="sub" style="margin-top:14px">This table is written to <em>only</em> by IAM's provisioning connector.
     Hire or terminate a user in IAM (localhost:8010) and watch it change here.</p>
</main>
<script>
async function refresh(){
  try{
    const {users}=await (await fetch('/api/users')).json();
    document.getElementById('count').textContent=users.length+' account'+(users.length===1?'':'s');
    document.getElementById('rows').innerHTML = users.length ? users.map(u=>`
      <tr><td class="mono"><b>${esc(u.username)}</b></td><td>${esc(u.displayName||'')}</td>
      <td>${esc(u.department||'—')}</td>
      <td><span class="pill ${u.active?'on':'off'}">${u.active?'ACTIVE':'DISABLED'}</span></td>
      <td>${(u.roles||[]).map(r=>`<span class="role">${esc(r)}</span>`).join('')||'<span class="muted">—</span>'}</td></tr>
    `).join('') : '<tr><td colspan="5" class="empty">No accounts yet. Hire someone in IAM to provision one here.</td></tr>';
  }catch(e){}
}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
refresh(); setInterval(refresh, 2000);
</script></body></html>"""
