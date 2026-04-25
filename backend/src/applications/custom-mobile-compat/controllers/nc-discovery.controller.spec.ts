import { Test, TestingModule } from '@nestjs/testing'
import { NcDiscoveryController } from './nc-discovery.controller'

describe(NcDiscoveryController.name, () => {
  let moduleRef: TestingModule
  let controller: NcDiscoveryController

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcDiscoveryController]
    }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDiscoveryController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  describe('status.php', () => {
    it('returns the NC-shape identity object', () => {
      const out = controller.status()
      expect(out).toEqual({
        installed: true,
        maintenance: false,
        needsDbUpgrade: false,
        version: expect.any(String),
        versionstring: expect.any(String),
        edition: expect.any(String),
        productname: expect.any(String),
        extendedSupport: expect.any(Boolean)
      })
      // NC iOS gates the connection on `installed === true && maintenance === false`
      expect(out.installed).toBe(true)
      expect(out.maintenance).toBe(false)
    })

    it('declares CORS-permissive headers via @Header so pre-login probes work', () => {
      // @Header() pushes {name, value} onto an Array under '__headers__',
      // attached to the prototype method. We read the metadata directly
      // because spinning up a full Nest app + fastify inject just for one
      // header check is overkill.
      const headers: { name: string; value: string }[] | undefined = Reflect.getMetadata('__headers__', NcDiscoveryController.prototype.status)
      expect(headers).toEqual(expect.arrayContaining([{ name: 'Access-Control-Allow-Origin', value: '*' }]))
    })
  })
})
