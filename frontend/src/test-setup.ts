// Vitest setup for the frontend unit specs (see vitest.config.mts).
//
// 1. Angular ships its libraries "partially compiled": their decorators are
//    declared via ɵɵngDeclare* calls that the Angular Linker normally expands at
//    build time. `ng build` does that; vitest does not, so the runtime falls back
//    to JIT and needs @angular/compiler loaded first. Without this import, merely
//    *importing* a module whose graph reaches @angular/common throws
//    "The injectable 'PlatformLocation' needs to be compiled using the JIT compiler".
import '@angular/compiler'

// 2. The specs run in a DOM-less node environment on purpose (no jsdom
//    dependency). The components under test only use the DOM through `instanceof`
//    guards on keyboard-event targets, so those two constructors have to exist
//    for `x instanceof HTMLInputElement` to evaluate rather than throw. Specs
//    construct instances of these to simulate "focus is in a text field".
const g = globalThis as Record<string, unknown>
if (typeof g['HTMLInputElement'] === 'undefined') g['HTMLInputElement'] = class HTMLInputElement {}
if (typeof g['HTMLTextAreaElement'] === 'undefined') g['HTMLTextAreaElement'] = class HTMLTextAreaElement {}
