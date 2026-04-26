import { HttpException, HttpStatus, StreamableFile } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NcThemingController } from './nc-theming.controller'

describe(NcThemingController.name, () => {
  let moduleRef: TestingModule
  let controller: NcThemingController

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ controllers: [NcThemingController] }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcThemingController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  function fakeReq(host = 'sync.example.com', proto = 'https'): FastifyRequest {
    return { headers: { host, 'x-forwarded-proto': proto } } as unknown as FastifyRequest
  }
  function fakeRes(): FastifyReply {
    return {
      header: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis()
    } as unknown as FastifyReply
  }

  describe('logo', () => {
    it('streams the on-disk logo asset as image/svg+xml when present', () => {
      // Use the actual logo.svg shipped under frontend/src/assets — it's
      // present in the repo and the controller resolves to its install
      // location at STATIC_ASSETS_PATH/logo.svg in production. For the test
      // we patch the resolved path to a known-existing file so the stream
      // doesn't error out at open time.
      const knownExisting = __filename
      jest.spyOn(controller as unknown as { resolveLogoPath: () => string }, 'resolveLogoPath').mockReturnValue(knownExisting)
      const res = fakeRes()
      const result = controller.logo(res)
      expect(result).toBeInstanceOf(StreamableFile)
      expect(res.header).toHaveBeenCalledWith('content-type', 'image/svg+xml')
      ;(result.getStream() as fs.ReadStream).destroy()
    })

    it('returns 404 if the logo is missing on disk', () => {
      jest.spyOn(controller as unknown as { resolveLogoPath: () => string }, 'resolveLogoPath').mockReturnValue(path.join('/nonexistent', 'logo.svg'))
      const res = fakeRes()
      expect(() => controller.logo(res)).toThrow(HttpException)
      try {
        controller.logo(res)
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND)
      }
    })
  })

  describe('background', () => {
    it('returns 404 unconditionally so the client falls back to the theme color', () => {
      expect(() => controller.background()).toThrow(HttpException)
      try {
        controller.background()
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND)
      }
    })
  })

  describe('favicon', () => {
    it('streams favicon.svg when present', () => {
      jest.spyOn(controller as unknown as { resolveFaviconPath: () => string }, 'resolveFaviconPath').mockReturnValue(__filename)
      const res = fakeRes()
      const result = controller.favicon('core', res)
      expect(result).toBeInstanceOf(StreamableFile)
      ;(result.getStream() as fs.ReadStream).destroy()
    })

    it('returns 404 if favicon.svg is missing', () => {
      jest
        .spyOn(controller as unknown as { resolveFaviconPath: () => string }, 'resolveFaviconPath')
        .mockReturnValue(path.join('/nonexistent', 'favicon.svg'))
      const res = fakeRes()
      expect(() => controller.favicon('core', res)).toThrow(HttpException)
    })
  })

  describe('icon', () => {
    // App-icon endpoint: NC iOS calls /index.php/apps/theming/icon/<app>/<image>
    // for per-app icons. We don't theme app icons, so 404 lets the client use
    // its bundled defaults (matches what NC servers without theming app do).
    it('returns 404 so the client uses its bundled default app icons', () => {
      expect(() => controller.icon('files', 'app.svg')).toThrow(HttpException)
    })
  })

  describe('manifest', () => {
    it('returns a JSON manifest carrying the Sync-in brand name', () => {
      const out = controller.manifest('core', fakeReq())
      expect(out.name).toBe('Sync-in')
      expect(out.short_name).toBe('Sync-in')
      expect(out.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(Array.isArray(out.icons)).toBe(true)
      // At least one icon entry should resolve to our favicon endpoint.
      expect(out.icons[0]?.src).toContain('/index.php/apps/theming/favicon')
    })
  })
})
