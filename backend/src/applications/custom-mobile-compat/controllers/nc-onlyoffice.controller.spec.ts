import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcOnlyOfficeCallbackController, NcOnlyOfficeController } from './nc-onlyoffice.controller'

// Phase 1 spec — covers the stub state (controllers wired and routes throw
// 501). Phase 2/3/4 specs replace the throw assertions with real behavior.
describe('NcOnlyOfficeController (stub)', () => {
  let controller: NcOnlyOfficeController

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NcOnlyOfficeController]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    controller = module.get(NcOnlyOfficeController)
  })

  it('should be defined', () => {
    expect(controller).toBeDefined()
  })

  it('config() throws 501 in phase 1', () => {
    expect(() => controller.config()).toThrow(HttpException)
    try {
      controller.config()
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED)
    }
  })

  it('empty() throws 501 in phase 1', () => {
    expect(() => controller.empty()).toThrow(HttpException)
  })

  it('save() throws 501 in phase 1', () => {
    expect(() => controller.save()).toThrow(HttpException)
  })
})

describe('NcOnlyOfficeCallbackController (stub)', () => {
  let controller: NcOnlyOfficeCallbackController

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NcOnlyOfficeCallbackController],
      providers: []
    }).compile()
    controller = module.get(NcOnlyOfficeCallbackController)
  })

  it('should be defined', () => {
    expect(controller).toBeDefined()
  })

  it('track() throws 501 in phase 1', () => {
    expect(() => controller.track()).toThrow(HttpException)
  })
})
