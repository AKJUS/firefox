/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Provider } from "react-redux";
import { createStore, combineReducers } from "redux";
import { INITIAL_STATE, reducers } from "common/Reducers.sys.mjs";

export function WrapWithProvider({ children, state = INITIAL_STATE }) {
  const store = createStore(combineReducers(reducers), state);
  return <Provider store={store}>{children}</Provider>;
}

/**
 * stubGlobals - Replace properties on globalThis for the duration of a test,
 * the jest replacement for karma's GlobalOverrider. Uses property descriptors so
 * that getter-only globals can be stubbed and faithfully restored.
 *
 * @param {object} overrides Keys are global names, values the stubs to install
 * @returns {Function} restore, which puts every key back the way it was
 *                     (deleting the ones that did not exist). Call in afterEach.
 */
export function stubGlobals(overrides) {
  const originals = Object.entries(overrides).map(([key]) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);

  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  return function restore() {
    for (const [key, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  };
}

// Known shapes of the `Services.*` singletons, so that every test asks for the
// same stub for a given service. Add a service here the first time a test needs
// it, with only the members that service actually exposes.
const SERVICE_STUBS = {
  obs: () => ({
    addObserver: jest.fn(),
    removeObserver: jest.fn(),
    notifyObservers: jest.fn(),
  }),
  scriptSecurityManager: () => ({
    createContentPrincipalFromOrigin: jest.fn(origin => ({ origin })),
  }),
  wm: () => ({
    getEnumerator: jest.fn(() => []),
  }),
};

/**
 * Builds a `Services`-shaped object holding a fresh stub per named service.
 *
 * @param {string[]} names Service names, e.g. `["obs", "wm"]`.
 * @returns {object} `{ [name]: stub }`, every member a `jest.fn()`.
 */
export function mockServices(names) {
  return Object.fromEntries(
    names.map(name => {
      const stub = SERVICE_STUBS[name];
      if (!stub) {
        throw new Error(
          `mockServices: no stub registered for Services.${name}`
        );
      }
      return [name, stub()];
    })
  );
}
