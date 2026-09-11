/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PushNotificationHelper } = ChromeUtils.importESModule(
  "resource://gre/modules/PushNotificationHelper.sys.mjs"
);

const ENABLED_PREF = "app.backgroundNotifications.helper.enabled";

function withStubbedStart(task) {
  const original = PushNotificationHelper.start;
  const launches = [];
  PushNotificationHelper.start = () => launches.push(true);
  try {
    return task(launches);
  } finally {
    PushNotificationHelper.start = original;
  }
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(ENABLED_PREF);
});

add_task(async function test_disabled_does_not_launch() {
  Services.prefs.setBoolPref(ENABLED_PREF, false);

  withStubbedStart(launches => {
    PushNotificationHelper.update();
    Assert.equal(launches.length, 0, "helper is not launched when disabled");
  });
});

add_task(async function test_enabled_launches() {
  Services.prefs.setBoolPref(ENABLED_PREF, true);

  withStubbedStart(launches => {
    PushNotificationHelper.update();
    Assert.equal(launches.length, 1, "helper is launched when enabled");
  });
});

add_task(async function test_flipping_pref() {
  Services.prefs.setBoolPref(ENABLED_PREF, false);

  withStubbedStart(launches => {
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    Assert.equal(
      launches.length,
      1,
      "flipping the pref on launches the helper without an explicit update()"
    );
  });

  withStubbedStart(launches => {
    Services.prefs.setBoolPref(ENABLED_PREF, false);
    Assert.equal(launches.length, 0, "flipping the pref off launches nothing");
  });
});
