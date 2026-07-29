import { configuration } from '../../../configuration/config.environment'
import type { OnlyOfficeConfig } from '../../files/editors/only-office/only-office.config'

// Which of the two OnlyOffice-protocol document servers is in play, and its
// secret.
//
// Euro-Office is not a second protocol — it is an OnlyOffice document server
// under another name — so `OnlyOfficeManager` picks between the two configs once
// at construction and everything downstream is identical
// (only-office-manager.service.ts:82-85). Any fork code that has to sign
// something the document server will verify needs the SAME choice, or a
// Euro-Office deployment signs with a secret the container does not hold and the
// failure surfaces as "the panel opens and then nothing renders".
//
// Why a fork-owned copy of a one-line expression instead of asking the manager:
// the same reason `only-office-doc-key.ts` gives. OnlyOfficeManager is provided
// by OnlyOfficeModule, which is imported ONLY when an office editor is enabled,
// and the manager already depends on VersioningService — so a versioning →
// manager call would be both conditional and a provider cycle. This function
// exists so the expression has ONE home rather than three.
//
// The manager owns the choice and its `officeConfig` is private, so nothing can
// assert the two agree at runtime. `active-office-editor.spec.ts` pins this side
// — including the both-disabled case — so a drift in the manager shows up as a
// failing expectation rather than as a signature the document server rejects.
// On every upstream sync, diff those lines.
export function activeOfficeEditorConfig(): OnlyOfficeConfig {
  const { onlyoffice, eurooffice } = configuration.applications.files.editors
  return onlyoffice.enabled ? onlyoffice : eurooffice
}

// The secret to sign document-server payloads with, or null when neither editor
// is configured with one.
//
// Upstream treats an empty secret as "do not sign at all" rather than as an
// error (`EditorController.php:1064` guards the whole signing block on
// `!empty(getDocumentServerSecret())`), and so must we: a document server
// started without JWT_SECRET rejects a SIGNED payload just as firmly as a
// secured one rejects an unsigned payload.
export function activeOfficeEditorSecret(): string | null {
  return activeOfficeEditorConfig().secret || null
}
