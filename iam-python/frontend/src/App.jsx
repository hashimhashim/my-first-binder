import React, {useCallback, useEffect, useState} from "react";
import {api, getToken, setToken} from "./api.js";

const NAV = [
  ["dashboard", "Dashboard"],
  ["employees", "Employees"],
  ["requests", "Requests"],
  ["approvals", "Approvals"],
  ["directory", "Directory"],
  ["applications", "Applications"],
  ["audit", "Audit"],
];

function Pill({status}) {
  const map = {
    ACTIVE: "good", COMPLETED: "good", HEALTHY: "good", APPROVED: "good", PROVISIONED: "good",
    PENDING: "warn", PENDING_APPROVAL: "warn", MANUAL_PENDING: "warn", QUEUED: "warn", TRANSFER: "warn",
    DISABLED: "neutral", TERMINATED: "neutral", REVOKED: "neutral", PRE_HIRE: "neutral",
    FAILED: "crit", REJECTED: "crit", DOWN: "crit",
  };
  return <span className={`pill ${map[status] || "neutral"}`}>{status}</span>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState(null);
  const [counts, setCounts] = useState({});

  const flash = useCallback((msg, err = false) => {
    setToast({msg, err});
    setTimeout(() => setToast(null), 3600);
  }, []);

  const loadCounts = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [inbox, dash] = await Promise.all([api("/api/requests/inbox"), api("/api/dashboard")]);
      setCounts({approvals: inbox.length, requests: dash.open_requests});
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (getToken()) api("/api/auth/me").then(setUser).catch(() => setToken(null));
  }, []);
  useEffect(() => { if (user) loadCounts(); }, [user, view, loadCounts]);

  if (!user) return <Login onLogin={setUser} flash={flash} />;

  const Views = {
    dashboard: Dashboard, employees: Employees, requests: Requests, approvals: Approvals,
    directory: Directory, applications: Applications, audit: Audit,
  };
  const Active = Views[view];

  return (
    <>
      <div className="topbar">
        <div className="brand"><span className="mark">◆</span> Enterprise IAM<small>identity &amp; access</small></div>
        <nav>
          {NAV.map(([id, label]) => (
            <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
              {label}{counts[id] ? <span className="badge">{counts[id]}</span> : null}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <span className="muted mono">{user.name}{user.admin ? " · admin" : ""}</span>
        <button className="action sec" onClick={() => { setToken(null); setUser(null); }}>Sign out</button>
      </div>
      <main><Active flash={flash} user={user} reloadCounts={loadCounts} /></main>
      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </>
  );
}

function Login({onLogin, flash}) {
  const [email, setEmail] = useState("admin@contoso.com");
  const [password, setPassword] = useState("Passw0rd!");
  const submit = async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/auth/login", {method: "POST", body: JSON.stringify({email, password})});
      if (res.mfa_required) { flash("MFA required — not enabled for demo users", true); return; }
      setToken(res.access_token);
      onLogin(res.user);
    } catch (err) { flash(err.message, true); }
  };
  return (
    <div className="login">
      <div className="panel">
        <h1 style={{marginBottom: 4}}>Enterprise IAM</h1>
        <p className="lede" style={{marginBottom: 16}}>Sign in to the identity platform.</p>
        <form onSubmit={submit}>
          <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="action" style={{width: "100%"}}>Sign in</button>
        </form>
        <p className="muted mono" style={{marginTop: 12, fontSize: 11}}>
          demo: admin@contoso.com / mona@contoso.com — Passw0rd!
        </p>
      </div>
    </div>
  );
}

function useAsync(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const reload = useCallback(() => { fn().then(setData).catch((e) => setErr(e.message)); }, deps);
  useEffect(() => { reload(); }, [reload]);
  return {data, err, reload};
}

function Dashboard() {
  const {data} = useAsync(() => api("/api/dashboard"), []);
  if (!data) return <p className="lede">Loading…</p>;
  const kpis = [
    [data.employees.total, "Employees"],
    [data.pending_approvals, "Pending approvals"],
    [data.open_requests, "Open requests"],
    [data.active_accounts, "Active app accounts"],
    [data.provisioning.failed, "Failed jobs"],
    [data.provisioning.manual_pending, "Manual queue"],
    [`${data.applications.healthy}/${data.applications.total}`, "Connectors healthy"],
  ];
  return (
    <>
      <div><h1>Dashboard</h1><p className="lede">Live platform state.</p></div>
      <div className="grid">
        {kpis.map(([n, l]) => (
          <div className="kpi" key={l}><div className="num">{n}</div><div className="lbl">{l}</div></div>
        ))}
      </div>
      <div className="panel"><h3>Employees by status</h3><div className="tablewrap"><table><tbody>
        {Object.entries(data.employees.by_status).map(([s, n]) => (
          <tr key={s}><td><Pill status={s} /></td><td className="mono">{n}</td></tr>
        ))}
      </tbody></table></div></div>
      <div className="panel"><h3>Provisioning jobs by status</h3><div className="tablewrap"><table><tbody>
        {Object.entries(data.provisioning.by_status).map(([s, n]) => (
          <tr key={s}><td><Pill status={s} /></td><td className="mono">{n}</td></tr>
        ))}
      </tbody></table></div></div>
    </>
  );
}

function Employees({flash, user, reloadCounts}) {
  const {data, reload} = useAsync(() => api("/api/employees"), []);
  const [form, setForm] = useState({display_name: "", email: "", department: "", title: ""});
  const act = async (id, op, body) => {
    try {
      await api(`/api/employees/${id}/${op}`, {method: "POST", body: JSON.stringify(body || {})});
      flash(`${op} completed`); reload(); reloadCounts();
    } catch (e) { flash(e.message, true); }
  };
  const create = async (e) => {
    e.preventDefault();
    try { await api("/api/employees", {method: "POST", body: JSON.stringify(form)});
      flash("Employee created"); setForm({display_name: "", email: "", department: "", title: ""}); reload();
    } catch (err) { flash(err.message, true); }
  };
  if (!data) return <p className="lede">Loading…</p>;
  return (
    <>
      <div><h1>Employees</h1><p className="lede">Directory and Joiner / Mover / Leaver actions.</p></div>
      {user.admin && (
        <div className="panel"><h3>Add employee</h3><div style={{padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
          <label>Name<input value={form.display_name} onChange={(e) => setForm({...form, display_name: e.target.value})} /></label>
          <label>Email<input value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} /></label>
          <label>Department<input value={form.department} onChange={(e) => setForm({...form, department: e.target.value})} /></label>
          <label>Title<input value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} /></label>
          <div><button className="action" onClick={create}>Create (Pre-Hire)</button></div>
        </div></div>
      )}
      <div className="panel"><div className="tablewrap"><table>
        <thead><tr><th>Name</th><th>Dept</th><th>Status</th>{user.admin && <th>Lifecycle</th>}</tr></thead>
        <tbody>{data.map((e) => (
          <tr key={e.id}>
            <td><b>{e.display_name}</b><div className="mono muted" style={{fontSize: 11}}>{e.email}</div></td>
            <td>{e.department || "—"}</td>
            <td><Pill status={e.status} /></td>
            {user.admin && <td><div className="row-actions">
              <button className="action sec" disabled={e.status !== "PRE_HIRE"} onClick={() => act(e.id, "joiner")}>Joiner</button>
              <button className="action sec" onClick={() => act(e.id, "mover", {department: prompt("New department?", e.department || "")})}>Mover</button>
              <button className="action danger" disabled={e.status === "TERMINATED"} onClick={() => act(e.id, "leaver")}>Leaver</button>
            </div></td>}
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}

function Requests({flash}) {
  const roles = useAsync(() => api("/api/roles"), []);
  const apps = useAsync(() => api("/api/applications"), []);
  const [form, setForm] = useState({target_type: "ROLE", role_id: "", application_id: "", justification: "", expires_at: ""});
  const submit = async (e) => {
    e.preventDefault();
    const body = {target_type: form.target_type, justification: form.justification};
    if (form.target_type === "ROLE") body.role_id = form.role_id;
    else { body.application_id = form.application_id; body.expires_at = form.expires_at ? new Date(form.expires_at).toISOString() : null; }
    try { const r = await api("/api/requests", {method: "POST", body: JSON.stringify(body)});
      flash(`Request ${r.status}`); } catch (err) { flash(err.message, true); }
  };
  if (!roles.data || !apps.data) return <p className="lede">Loading…</p>;
  return (
    <>
      <div><h1>Request access</h1><p className="lede">Requests route through the approval workflow. Direct application access needs an expiry.</p></div>
      <div className="panel"><div style={{padding: 16}}>
        <label>Type<select value={form.target_type} onChange={(e) => setForm({...form, target_type: e.target.value})}>
          <option value="ROLE">Business role</option><option value="APPLICATION">Application (temporary)</option>
        </select></label>
        {form.target_type === "ROLE" ? (
          <label>Role<select value={form.role_id} onChange={(e) => setForm({...form, role_id: e.target.value})}>
            <option value="">Select…</option>{roles.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
        ) : (
          <>
            <label>Application<select value={form.application_id} onChange={(e) => setForm({...form, application_id: e.target.value})}>
              <option value="">Select…</option>{apps.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
            <label>Expires<input type="date" value={form.expires_at} onChange={(e) => setForm({...form, expires_at: e.target.value})} /></label>
          </>
        )}
        <label>Justification<textarea value={form.justification} onChange={(e) => setForm({...form, justification: e.target.value})} /></label>
        <button className="action" onClick={submit}>Submit request</button>
      </div></div>
    </>
  );
}

function Approvals({flash, reloadCounts}) {
  const {data, reload} = useAsync(() => api("/api/requests/inbox"), []);
  const decide = async (id, decision) => {
    try { await api(`/api/requests/${id}/decision`, {method: "POST", body: JSON.stringify({decision})});
      flash(`Request ${decision.toLowerCase()}`); reload(); reloadCounts();
    } catch (e) { flash(e.message, true); }
  };
  if (!data) return <p className="lede">Loading…</p>;
  return (
    <>
      <div><h1>Approvals</h1><p className="lede">Requests awaiting your decision.</p></div>
      <div className="panel">{data.length ? <div className="tablewrap"><table>
        <thead><tr><th>Beneficiary</th><th>Target</th><th>Justification</th><th>Stage</th><th>Decision</th></tr></thead>
        <tbody>{data.map((a) => (
          <tr key={a.approval_id}>
            <td>{a.beneficiary}</td><td className="mono">{a.target_type}</td>
            <td className="muted">{a.justification}</td>
            <td><span className={`pill ${a.ready ? "warn" : "neutral"}`}>{a.stage}{a.ready ? "" : " · waiting"}</span></td>
            <td><div className="row-actions">
              <button className="action" disabled={!a.ready} onClick={() => decide(a.request_id, "APPROVED")}>Approve</button>
              <button className="action danger" disabled={!a.ready} onClick={() => decide(a.request_id, "REJECTED")}>Reject</button>
            </div></td>
          </tr>
        ))}</tbody>
      </table></div> : <p className="lede" style={{padding: 20}}>Nothing waiting on you. ✓</p>}</div>
    </>
  );
}

function Directory() {
  const {data} = useAsync(() => api("/api/directory"), []);
  if (!data) return <p className="lede">Loading…</p>;
  return (
    <>
      <div><h1>Directory</h1><p className="lede">Simulated AD / Entra ID state, provisioned by the connectors.</p></div>
      <div className="panel"><div className="tablewrap"><table>
        <thead><tr><th>Account</th><th>Status</th><th>Groups</th></tr></thead>
        <tbody>{data.map((d) => (
          <tr key={d.identifier}>
            <td><b>{d.display_name}</b><div className="mono muted" style={{fontSize: 11}}>{d.email}</div></td>
            <td><Pill status={d.status} /></td>
            <td className="mono">{(d.groups || []).join(", ") || "—"}</td>
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}

function Applications({flash, user}) {
  const {data, reload} = useAsync(() => api("/api/applications"), []);
  const test = async (id) => {
    try { const r = await api(`/api/applications/${id}/test`, {method: "POST"});
      flash(`${r.health}: ${r.detail}`, !r.ok); reload(); } catch (e) { flash(e.message, true); }
  };
  if (!data) return <p className="lede">Loading…</p>;
  return (
    <>
      <div><h1>Applications &amp; connectors</h1><p className="lede">Connected systems and their health.</p></div>
      <div className="panel"><div className="tablewrap"><table>
        <thead><tr><th>Application</th><th>Connector</th><th>Health</th>{user.admin && <th>Actions</th>}</tr></thead>
        <tbody>{data.map((a) => (
          <tr key={a.id}>
            <td><b>{a.name}</b></td><td className="mono">{a.connector_type}</td>
            <td><Pill status={a.health} /></td>
            {user.admin && <td><button className="action sec" onClick={() => test(a.id)}>Test connection</button></td>}
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}

function Audit() {
  const {data} = useAsync(() => api("/api/audit"), []);
  if (!data) return <p className="lede">Loading…</p>;
  return (
    <>
      <div><h1>Audit log</h1><p className="lede">Every sensitive action, newest first.</p></div>
      <div className="panel"><div className="tablewrap" style={{maxHeight: 500, overflowY: "auto"}}><table>
        <thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Actor</th></tr></thead>
        <tbody>{data.map((e, i) => (
          <tr key={i}>
            <td className="mono">{new Date(e.occurred_at).toLocaleString()}</td>
            <td className="mono">{e.action}</td><td className="mono">{e.entity_type}</td>
            <td className="mono muted">{e.actor}</td>
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}
