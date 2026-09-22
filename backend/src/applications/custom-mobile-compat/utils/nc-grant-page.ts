import { escapeHtml } from './nc-html'

// The authorisation step of NC Login Flow v2.
//
// Deliberately NOT a bare redirect and NOT an auto-submitting form: the whole
// point is that a human reads WHO is asking and decides. Rendered by both the
// password path and the OIDC callback, because both of them authenticate a
// user without establishing that the user wanted to authorise *this* client.
//
// `clientName` is the requesting app's User-Agent, captured at initiate. If it
// says something the person does not recognise, that is exactly the signal
// that someone else started the flow and sent them the link.
export function renderGrantPage(loginToken: string, grantToken: string, login: string, clientName: string): string {
  const safeToken = escapeHtml(loginToken)
  const safeGrant = escapeHtml(grantToken)
  const safeLogin = escapeHtml(login)
  const safeClient = escapeHtml(clientName)
  return `<h1>Authorize this app?</h1>
<p>You are signed in as <strong>${safeLogin}</strong>.</p>
<p><strong>${safeClient}</strong> is asking for access to your Sync-in account — all your files, on this account, until you revoke it.</p>
<div class="err">If you did not just start signing in from this app, close this page. Someone else may have sent you this link.</div>
<form method="post" action="/login/v2/grant/${safeToken}">
  <input type="hidden" name="grantToken" value="${safeGrant}" />
  <button type="submit">Grant access</button>
</form>
<div class="brand">Sync-in · Nextcloud-compatible login</div>`
}
