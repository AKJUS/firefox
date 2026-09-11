/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import "@testing-library/jest-dom"; // eslint-disable-line import/no-unassigned-import
import { EventEmitter } from "test/jest/test-utils";

// Platform globals that lib/*.sys.mjs modules touch while their module body
// runs, so they cannot be installed from a test's beforeEach. Everything else
// belongs in stubGlobals() calls inside the tests that need it.
globalThis.ChromeUtils = {
  // Karma resolves lazy getters by reparenting the `lazy` object onto the
  // global, so tests can stub e.g. globalThis.PlacesUtils. Do the same here.
  defineESModuleGetters(object) {
    Object.setPrototypeOf(object, globalThis);
    return globalThis;
  },
  importESModule() {
    return globalThis;
  },
};
globalThis.EventEmitter = EventEmitter;

globalThis.requestIdleCallback = cb => {
  cb();
  return 0;
};
globalThis.cancelIdleCallback = () => {};

globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

globalThis.matchMedia = () => ({
  matches: false,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
});

// jsdom implements neither PointerEvent nor pointer capture. Tests need to be
// able to create the event; capture does nothing here.
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = class PointerEvent extends globalThis.MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "";
      this.isPrimary = params.isPrimary ?? false;
    }
  };
}

if (!globalThis.Element.prototype.setPointerCapture) {
  globalThis.Element.prototype.setPointerCapture = () => {};
  globalThis.Element.prototype.releasePointerCapture = () => {};
  globalThis.Element.prototype.hasPointerCapture = () => false;
}

if (globalThis.performance && !globalThis.performance.getEntriesByType) {
  Object.defineProperty(globalThis.performance, "getEntriesByType", {
    writable: true,
    value: () => [],
  });
}

// Fail any test that logs to console.error (React act() warnings, PropType
// errors, error-boundary logging, etc.). Tests that expect an error must spy
// on console.error themselves (their inner spy swallows the calls, and its
// afterEach restores before this one checks). See bug 2024720 for the earlier
// cleanup that this guard keeps from regressing.
let consoleErrorSpy;
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  const { calls } = consoleErrorSpy.mock;
  consoleErrorSpy.mockRestore();
  if (calls.length) {
    throw new Error(
      `Unexpected console.error in test (${calls.length}):\n${calls
        .map(args => args.join(" "))
        .join("\n\n")}`
    );
  }
});
