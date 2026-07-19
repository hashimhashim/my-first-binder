const BASE = window.__API_BASE__ || "";
let token = localStorage.getItem("iam_token") || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("iam_token", t);
  else localStorage.removeItem("iam_token");
}
export function getToken() {
  return token;
}

export async function api(path, options = {}) {
  const headers = {"Content-Type": "application/json", ...(options.headers || {})};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {...options, headers});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}
