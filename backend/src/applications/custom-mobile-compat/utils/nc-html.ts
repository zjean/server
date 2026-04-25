// Minimal, dependency-free HTML rendering for the NC mobile login pages.
// Deliberately no external assets — safe behind any reverse proxy,
// theme-agnostic, and keeps the module dependency-free on the frontend side.

export function renderHtml({ title, body, headExtras }: { title: string; body: string; headExtras?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${headExtras ?? ''}
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#f1f5f9; --muted:#94a3b8; --accent:#0082c9; --border:#334155; --err:#ef4444; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  .card { width:100%; max-width:360px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px; box-shadow:0 10px 30px rgba(0,0,0,.3); }
  h1 { margin:0 0 8px; font-size:18px; }
  p { margin:0 0 16px; color:var(--muted); font-size:14px; line-height:1.5; }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:10px 12px; font-size:14px; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:8px; outline:none; }
  input:focus { border-color:var(--accent); }
  button, .btn { width:100%; margin-top:18px; padding:11px; font-size:14px; font-weight:500; border:none; border-radius:8px; background:var(--accent); color:white; cursor:pointer; text-align:center; text-decoration:none; display:block; }
  .err { color:var(--err); font-size:13px; margin-top:12px; }
  .brand { font-size:12px; color:var(--muted); text-align:center; margin-top:18px; }
  .divider { display:flex; align-items:center; gap:12px; margin:20px 0 0; color:var(--muted); font-size:12px; }
  .divider::before, .divider::after { content:''; flex:1; border-top:1px solid var(--border); }
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// Builds the Nextcloud client deep link the iOS / Android apps register a URL
// scheme for: `nc://login/server:<server>&user:<login>&password:<appPassword>`.
// Each value is URL-encoded; the surrounding `&` separators are part of the
// path (not query) — matches the format documented at
// https://docs.nextcloud.com/desktop/3.13/installing.html#configuring-the-desktop-client.
export function buildNcLoginRedirectUrl({ server, loginName, appPassword }: { server: string; loginName: string; appPassword: string }): string {
  const enc = encodeURIComponent
  return `nc://login/server:${enc(server)}&user:${enc(loginName)}&password:${enc(appPassword)}`
}

// Body fragment for the Login Flow v2 success page. Emits both a meta-refresh
// (so the OS hands the credentials to the NC app immediately) AND a tappable
// fallback link, so the user is never stuck if the OS blocks the auto-redirect.
export function renderNcSuccessBody(creds: { server: string; loginName: string; appPassword: string }): { body: string; headExtras: string } {
  const url = buildNcLoginRedirectUrl(creds)
  const safeUrl = escapeHtml(url)
  return {
    headExtras: `<meta http-equiv="refresh" content="0;url=${safeUrl}">`,
    body: `<h1>All set!</h1>
<p>You can return to the app — it will finish signing in automatically.</p>
<p><a class="btn" href="${safeUrl}">Tap here if the app didn't open</a></p>`
  }
}
