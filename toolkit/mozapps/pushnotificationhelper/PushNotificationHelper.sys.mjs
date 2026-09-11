/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const ENABLED_PREF = "app.backgroundNotifications.helper.enabled";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  WindowsPushNotificationHelper:
    "resource://gre/modules/WindowsPushNotificationHelper.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "gImpl", () => {
  if (AppConstants.platform == "win") {
    return lazy.WindowsPushNotificationHelper;
  }

  // Stubs for unsupported platforms
  return {
    start() {},
  };
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "enabled",
  ENABLED_PREF,
  false,
  () => PushNotificationHelper.update()
);

/**
 * Interface to a helper process that delivers push notifications while Firefox
 * is closed, run per profile and outliving the session that started it.
 */
export const PushNotificationHelper = {
  /**
   * Brings the helper in line with the pref. Called once at startup from the
   * browser-idle-startup category, and again whenever the pref changes.
   */
  init() {
    this.update();
  },

  update() {
    if (lazy.enabled) {
      this.start();
    }

    // TODO: Stopping a helper that is already running needs a control channel
    // that outlives a Firefox session. That is dealt with further down the
    // stack.
  },

  /**
   * Launches the helper detached, so it survives this session.
   */
  start() {
    lazy.gImpl.start();
  },
};
