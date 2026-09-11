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
 * Replaces properties on the global object, the way the karma harness'
 * GlobalOverrider did. Call from `beforeEach` and call the returned function
 * from `afterEach`.
 *
 * @param {object} overrides Keys to assign onto `globalThis`.
 * @returns {Function} Restores every key to what it was (deleting keys that
 *                     did not exist before).
 */
export function stubGlobals(overrides) {
  const originals = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, { existed: key in globalThis, value: globalThis[key] });
    globalThis[key] = value;
  }
  return function restore() {
    for (const [key, original] of originals) {
      if (original.existed) {
        globalThis[key] = original.value;
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
