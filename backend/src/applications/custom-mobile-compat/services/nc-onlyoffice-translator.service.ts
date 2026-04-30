import { Injectable } from '@nestjs/common'
import type { FILE_MODE } from '../../files/constants/operations'
import type { OnlyOfficeReqDto } from '../../files/modules/only-office/only-office.dtos'

// NC OnlyOffice connector envelope. Shape mirrors what NC's OnlyOffice plugin
// emits at /index.php/apps/onlyoffice/config — what stock NC mobile + the
// OnlyOffice Documents app expect to find when probing /config.
//
// The OnlyOffice document server itself accepts both Sync-in's nested
// `{config: {...}}` shape and this flat one; the difference is what NC
// mobile parses, not what the doc server consumes.
export interface NcOnlyOfficeEnvelope {
  documentServerUrl: string
  documentType: string
  type: 'desktop' | 'mobile'
  document: {
    title: string
    fileType: string
    key: string
    url: string
    permissions?: Record<string, unknown>
  }
  editorConfig: {
    callbackUrl?: string
    mode?: FILE_MODE
    lang?: string
    user?: { id?: string; name?: string; image?: string }
  }
  token?: string
}

// Pure reshape — no DI deps, no I/O. Keeps the JWT under config.token
// unchanged because the doc server signs/verifies with the same secret
// regardless of which connector built the payload.
@Injectable()
export class NcOnlyOfficeTranslatorService {
  toNcEnvelope(synci: OnlyOfficeReqDto): NcOnlyOfficeEnvelope {
    const cfg = synci.config
    return {
      documentServerUrl: synci.documentServerUrl,
      documentType: cfg.documentType,
      type: cfg.type,
      document: {
        title: cfg.document.title,
        fileType: cfg.document.fileType,
        key: cfg.document.key,
        url: cfg.document.url,
        permissions: cfg.document.permissions
      },
      editorConfig: {
        callbackUrl: cfg.editorConfig?.callbackUrl,
        mode: cfg.editorConfig?.mode,
        lang: cfg.editorConfig?.lang,
        user: cfg.editorConfig?.user
      },
      token: cfg.token
    }
  }
}
