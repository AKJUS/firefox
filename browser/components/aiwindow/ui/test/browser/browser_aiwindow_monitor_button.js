/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const WIDGET_ID = "smartwindow-monitor-button";
const PREF_MONITOR_ATTENTION = "browser.smartwindow.agent.monitorAttention";
const PREF_MONITOR_ANNOUNCEMENT =
  "browser.smartwindow.agent.monitorAnnouncement";
const SUPPORTED_REGIONS_PREF = "browser.smartwindow.agent.supportedRegions";
const TEST_REGION = "US";
const PANEL_ID = "smartwindow-monitor-panel";

function clearAttentionPrefs() {
  Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
  Services.prefs.clearUserPref(PREF_MONITOR_ANNOUNCEMENT);
}

// Nimbus sets the announcement on the default branch, so tests that stand in
// for a rollout have to write the same branch the dismissal outranks.
function setAnnouncementRollout(enabled) {
  Services.prefs
    .getDefaultBranch("")
    .setBoolPref(PREF_MONITOR_ANNOUNCEMENT, enabled);
}

function notifyMatch(monitorId) {
  Services.obs.notifyObservers(null, MONITOR_CONDITION_MET_TOPIC, monitorId);
}

const { Region } = ChromeUtils.importESModule(
  "resource://gre/modules/Region.sys.mjs"
);

const { MONITOR_CONDITION_MET_TOPIC } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs"
);
const { MonitorAttention } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/MonitorAttention.sys.mjs"
);

const { TOTAL_NUM_MONITORS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs"
);
const { MonitorAgent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/MonitorAgent.sys.mjs"
);

add_setup(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.suggest.enabled", false],
      ["browser.urlbar.suggest.searches", false],
      ["browser.smartwindow.endpoint", "http://localhost:0/v1"],
      ["browser.smartwindow.firstrun.hasCompleted", true],
      ["browser.smartwindow.agent.enabled", true],
      ["browser.smartwindow.agent.toolbar.enabled", true],
      ["browser.smartwindow.agent.supportedRegions", TEST_REGION],
    ],
  });

  // Pin the home region, otherwise the region gate decides whether the button
  // exists at all and every test here becomes a coin toss.
  const originalRegion = Region.home;
  Region._setHomeRegion(TEST_REGION, false);

  AIWindow._updateMonitorWidgetRegistration();

  registerCleanupFunction(() => {
    Region._setHomeRegion(originalRegion, false);
    Services.prefs.clearUserPref(
      "browser.smartwindow.lastSmartWindowUsageTime"
    );
    Services.prefs.clearUserPref("browser.smartwindow.lastLLMTelemetryRunTime");
  });
});

function getMonitorButton(win) {
  return win.document.getElementById(WIDGET_ID);
}

/**
 * The monitor button is visible in a Smart Window and routes activation to
 * AIWindowUI.toggleMonitorPanel, by mouse and by keyboard.
 */
add_task(async function test_monitor_button() {
  const sb = this.sinon.createSandbox();
  const toggleMonitorPanel = sb.stub(AIWindowUI, "toggleMonitorPanel");
  let win;
  try {
    win = await openAIWindow();
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const monitorButton = getMonitorButton(win);
    Assert.ok(monitorButton, "Monitor button exists in the toolbar");
    Assert.ok(
      BrowserTestUtils.isVisible(monitorButton),
      "Monitor button is visible for AI Window"
    );

    EventUtils.synthesizeMouseAtCenter(monitorButton, {}, win);
    Assert.equal(
      toggleMonitorPanel.callCount,
      1,
      "Clicking the monitor button toggles the monitor panel"
    );
    Assert.equal(
      toggleMonitorPanel.firstCall.args[0],
      win,
      "The panel is toggled for the window the button belongs to"
    );

    // Toolbar buttons are only focusable while ToolbarKeyboardNavigator has
    // given them a tabindex, so take the same step it does before typing.
    monitorButton.setAttribute("tabindex", "-1");
    monitorButton.focus();
    Assert.equal(
      win.document.activeElement,
      monitorButton,
      "Monitor button can take keyboard focus"
    );
    // Space rather than Enter: on macOS, Return activates the default button
    // instead of the focused one (see XULButtonElement::AfterHandleEvent).
    EventUtils.synthesizeKey(" ", {}, win);
    Assert.equal(
      toggleMonitorPanel.callCount,
      2,
      "Pressing Space on the monitor button toggles the monitor panel"
    );
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * A monitor run that meets its condition puts a dot on the button in every
 * window, and opening the panel clears it everywhere.
 */
add_task(async function test_monitor_button_attention_dot() {
  // Deliberately not stubbing toggleMonitorPanel: clearing the dot is its job,
  // so a stub would make the clear assertions below vacuous.
  let win;
  let otherWin;
  try {
    win = await openAIWindow();
    otherWin = await openAIWindow();

    Assert.ok(
      !getMonitorButton(win).hasAttribute("monitor-attention"),
      "No dot before any monitor matched"
    );

    notifyMatch("monitor-1");
    for (const w of [win, otherWin]) {
      Assert.ok(
        getMonitorButton(w).hasAttribute("monitor-attention"),
        "A match puts the dot on the button in every window"
      );
    }

    // The badge is empty, so it only renders because the attribute makes it
    // display: block. Without that the dot would be invisible.
    const badge = getMonitorButton(win).querySelector(".toolbarbutton-badge");
    Assert.equal(
      win.getComputedStyle(badge).display,
      "block",
      "The dot is rendered in the badge slot"
    );

    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    for (const w of [win, otherWin]) {
      Assert.ok(
        !getMonitorButton(w).hasAttribute("monitor-attention"),
        "Opening the panel clears the dot in every window"
      );
    }
  } finally {
    Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
    await BrowserTestUtils.closeWindow(otherWin);
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The panel needs to know which monitors matched, not just that something did.
 * Taking the ids hands them over and clears the dot in one step.
 */
add_task(async function test_monitor_attention_ids() {
  try {
    // Back to back, so the two matches land in the same millisecond: the order
    // has to come from how they were stored, not from comparing timestamps.
    notifyMatch("monitor-1");
    notifyMatch("monitor-2");
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      ["monitor-2", "monitor-1"],
      "Matched monitors are reported newest first"
    );

    // The same monitor matching twice is still one monitor, now the newest.
    notifyMatch("monitor-1");
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      ["monitor-1", "monitor-2"],
      "Matching again moves the monitor to the front rather than duplicating it"
    );

    const taken = AIWindow.takeMonitorAttentionIds();
    Assert.deepEqual(
      taken,
      ["monitor-1", "monitor-2"],
      "Taking the ids returns what the panel should highlight, in order"
    );
    Assert.ok(
      !AIWindow.hasMonitorAttention,
      "Taking the ids clears the dot in the same step"
    );
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      [],
      "A second open has nothing left to highlight"
    );
  } finally {
    Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
  }
});

/**
 * A corrupt pref must not take the button down with it.
 */
add_task(async function test_monitor_attention_ignores_bad_pref() {
  for (const [label, value] of [
    ["Unparseable", "not json"],
    // The shape this pref held before it had to carry an order.
    ["A stale shape", JSON.stringify({ "monitor-1": Date.now() })],
  ]) {
    try {
      Services.prefs.setStringPref(PREF_MONITOR_ATTENTION, value);
      Assert.deepEqual(
        AIWindow.monitorAttentionIds,
        [],
        `${label} state reads as no matches`
      );
      Assert.ok(
        !AIWindow.hasMonitorAttention,
        `${label} state does not light the dot`
      );
    } finally {
      Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
    }
  }

  // Reading does not repair the pref, so the next match has to.
  try {
    Services.prefs.setStringPref(PREF_MONITOR_ATTENTION, "not json");
    notifyMatch("monitor-1");
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      ["monitor-1"],
      "The next match replaces state that could not be read"
    );
  } finally {
    Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
  }

  // A single bad entry must not throw away the matches around it.
  try {
    Services.prefs.setStringPref(
      PREF_MONITOR_ATTENTION,
      JSON.stringify([{ id: "monitor-1", at: Date.now() }, null, { at: 5 }])
    );
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      ["monitor-1"],
      "Malformed entries are skipped, valid ones survive"
    );
  } finally {
    Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
  }
});

/**
 * The other reason for the dot: announcing the feature as new. Nimbus turns
 * this on via the default branch, and it lights the same dot.
 */
add_task(async function test_monitor_announcement_dot() {
  let win;
  try {
    setAnnouncementRollout(true);

    win = await openAIWindow();
    Assert.ok(
      getMonitorButton(win).hasAttribute("monitor-attention"),
      "Announcing the feature shows the dot"
    );
    Assert.ok(
      AIWindow.hasMonitorAnnouncement,
      "The dot is attributed to the announcement"
    );
    Assert.ok(
      !MonitorAttention.hasMatches,
      "No monitor matched, so the announcement is the only reason"
    );
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      [],
      "The announcement is not a monitor, so there is nothing to highlight"
    );
    AIWindow.clearMonitorAttention();
    Assert.ok(
      !getMonitorButton(win).hasAttribute("monitor-attention"),
      "Opening the panel answers the announcement too"
    );

    // Nimbus re-applying the rollout must not bring the dot back: the dismissal
    // is on the user branch, which outranks the default branch it writes.
    setAnnouncementRollout(true);
    Assert.ok(
      !AIWindow.hasMonitorAnnouncement,
      "A dismissed announcement stays dismissed when the rollout re-applies"
    );
  } finally {
    setAnnouncementRollout(false);
    clearAttentionPrefs();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Dismissal writes the user branch, which outranks the default branch a rollout
 * writes, and the button is usable long before any rollout starts. Opening the
 * panel that early must not mask the announcement that comes later.
 */
add_task(async function test_monitor_dismissal_does_not_mask_later_rollout() {
  try {
    Assert.ok(
      !AIWindow.hasMonitorAnnouncement,
      "Nothing is being announced yet"
    );

    // The user opens the panel for their own reasons, well before any rollout.
    AIWindow.clearMonitorAttention();
    Assert.ok(
      !Services.prefs.prefHasUserValue(PREF_MONITOR_ANNOUNCEMENT),
      "Opening the panel with nothing to announce dismisses nothing"
    );

    setAnnouncementRollout(true);
    Assert.ok(
      AIWindow.hasMonitorAnnouncement,
      "A rollout that starts later still reaches the user"
    );

    // And dismissing it now does stick.
    AIWindow.clearMonitorAttention();
    Assert.ok(
      !AIWindow.hasMonitorAnnouncement,
      "Dismissing a running announcement still works"
    );
  } finally {
    setAnnouncementRollout(false);
    clearAttentionPrefs();
  }
});

/**
 * Unenrolling restores the default branch, which is the only thing keeping the
 * announcement up. A match is separate state and has to survive that.
 */
add_task(async function test_monitor_announcement_ends_with_rollout() {
  try {
    setAnnouncementRollout(true);
    notifyMatch("monitor-1");
    Assert.ok(AIWindow.hasMonitorAnnouncement, "The rollout is announcing");

    setAnnouncementRollout(false);
    Assert.ok(
      !AIWindow.hasMonitorAnnouncement,
      "Unenrolling ends the announcement"
    );
    Assert.ok(
      AIWindow.hasMonitorAttention,
      "The match still shows the dot on its own"
    );
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      ["monitor-1"],
      "Ending the rollout does not disturb what the panel highlights"
    );
  } finally {
    setAnnouncementRollout(false);
    clearAttentionPrefs();
  }
});

/**
 * A match the user never came back for stops being advertised, so the dot does
 * not outlive its lifetime.
 */
add_task(async function test_monitor_button_attention_dot_expires() {
  let win;
  try {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    Services.prefs.setStringPref(
      PREF_MONITOR_ATTENTION,
      JSON.stringify([{ id: "monitor-stale", at: eightDaysAgo }])
    );
    win = await openAIWindow();
    Assert.ok(
      !getMonitorButton(win).hasAttribute("monitor-attention"),
      "A match older than the dot lifetime does not show the dot"
    );
    Assert.deepEqual(
      AIWindow.monitorAttentionIds,
      [],
      "An expired match is not offered to the panel either"
    );
  } finally {
    Services.prefs.clearUserPref(PREF_MONITOR_ATTENTION);
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Clicking the button opens a panel anchored to it, and clicking again closes
 * it. The panel is removed from the DOM once hidden.
 */
add_task(async function test_monitor_panel_toggles() {
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const monitorButton = getMonitorButton(win);
    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(monitorButton, {}, win);
    const panel = (await shown).target;

    Assert.equal(panel.id, PANEL_ID, "Clicking the button opens the panel");
    Assert.equal(
      panel.anchorNode?.id,
      WIDGET_ID,
      "Panel is anchored to the monitor button"
    );
    Assert.equal(
      monitorButton.getAttribute("aria-expanded"),
      "true",
      "Button reports the panel as expanded"
    );

    const title = panel.querySelector(".panel-header > h1");
    await win.document.l10n.translateFragment(panel);
    Assert.equal(title.textContent, "Tasks", "Panel has a localized title");
    Assert.equal(
      panel.getAttribute("aria-labelledby"),
      title.id,
      "Panel is labelled by its title for assistive technology"
    );

    const contents = panel.querySelector("agent-monitor-panel");
    Assert.ok(contents, "Panel hosts the agent-monitor-panel element");
    await contents.updateComplete;
    Assert.equal(contents.view, "list", "Panel opens on the list view");
    Assert.equal(
      contents.maxMonitors,
      TOTAL_NUM_MONITORS,
      "Contents know how many tasks are allowed"
    );

    // A second click must close the panel and leave it closed: the rollup on
    // mousedown and the command event that follows must not fight each other.
    let reopened = false;
    const onShown = () => {
      reopened = true;
    };
    const popupSet = win.document.getElementById("mainPopupSet");
    popupSet.addEventListener("popupshown", onShown);
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeMouseAtCenter(monitorButton, {}, win);
    await hidden;
    await TestUtils.waitForTick();
    popupSet.removeEventListener("popupshown", onShown);
    Assert.ok(!reopened, "Closing click does not reopen the panel");

    Assert.equal(
      win.document.getElementById(PANEL_ID),
      null,
      "Panel is removed from the DOM once hidden"
    );
    Assert.equal(
      monitorButton.getAttribute("aria-expanded"),
      "false",
      "Button reports the panel as collapsed again"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The list names each task the user is watching, newest first, and states when
 * it checks rather than when it last ran.
 */
add_task(async function test_monitor_panel_list_rows() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([
    {
      id: "monitor-1",
      title: "Concert tickets",
      monitorPrompt: "tickets go on sale",
      watchUrls: ["https://example.com/tickets"],
      enabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      schedule: { type: "weekly", hour: 14, minute: 30, weekday: 3 },
      history: [],
    },
    {
      id: "monitor-2",
      title: "Ticket price",
      monitorPrompt: "price drops",
      watchUrls: ["https://example.com/price"],
      enabled: true,
      createdAt: "2026-02-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [],
    },
  ]);
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contents.monitors.length === 2);
    await contents.updateComplete;

    const rows = contents.shadowRoot.querySelectorAll(".monitor-row");
    Assert.equal(rows.length, 2, "Every monitor gets a row");
    Assert.deepEqual(
      [...rows].map(row => row.querySelector(".monitor-row-title").textContent),
      ["Ticket price", "Concert tickets"],
      "Rows name the monitors, newest first"
    );

    const metas = [...rows].map(row => row.querySelector(".monitor-row-meta"));
    Assert.deepEqual(
      metas.map(meta => meta.getAttribute("data-l10n-id")),
      [
        "ai-tasks-alert-schedule-daily-at",
        "ai-tasks-alert-schedule-weekly-wednesday",
      ],
      "Rows state the schedule the monitor checks on"
    );
    Assert.deepEqual(
      metas.map(meta => JSON.parse(meta.getAttribute("data-l10n-args")).time),
      [
        new Date(new Date().setHours(9, 0, 0, 0)).getTime(),
        new Date(new Date().setHours(14, 30, 0, 0)).getTime(),
      ],
      "The scheduled time of day is passed to the string"
    );
    await TestUtils.waitForCondition(() => metas.every(m => m.textContent));

    const chips = [...rows].map(row =>
      row.querySelector("monitor-status-chip")
    );
    Assert.deepEqual(
      chips.map(chip => chip.kind),
      ["watching", "paused"],
      "Rows wear the same status pill the task cards do"
    );
    await TestUtils.waitForCondition(() =>
      chips.every(chip => chip.shadowRoot.querySelector("span")?.textContent)
    );
    Assert.deepEqual(
      chips.map(chip => chip.shadowRoot.querySelector("span").textContent),
      ["Active", "Paused"],
      "The pills are localized inside the panel"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Clicking a monitor row opens the tasks page and dismisses the panel.
 */
add_task(async function test_monitor_panel_row_opens_tasks_page() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([
    {
      id: "monitor-1",
      title: "Concert tickets",
      monitorPrompt: "tickets go on sale",
      watchUrls: ["https://example.com/tickets"],
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [],
    },
  ]);
  const win = await openAIWindow();
  const switchToTab = sb.stub(win, "switchToTabHavingURI");
  try {
    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contents.monitors.length === 1);
    await contents.updateComplete;

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    contents.shadowRoot
      .querySelector(".monitor-row")
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await hidden;

    Assert.ok(
      switchToTab.calledWith("about:smartwindowtasks", true),
      "Clicking a row opens the tasks page and dismisses the panel"
    );
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Monitors that newly matched since the panel was last opened are pulled into a
 * "New matches" section above "Recent", and their Match result wears a green dot.
 * Opening consumes the match, so reopening drops the section and the monitor
 * falls back under "Recent".
 */
add_task(async function test_monitor_panel_new_matches_section() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([
    {
      id: "monitor-1",
      title: "Concert tickets",
      monitorPrompt: "tickets go on sale",
      watchUrls: ["https://example.com/tickets"],
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [],
    },
    {
      id: "monitor-2",
      title: "Ticket price",
      monitorPrompt: "price drops",
      watchUrls: ["https://example.com/price"],
      enabled: true,
      createdAt: "2026-02-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [{ conditionMet: true }],
    },
  ]);
  const win = await openAIWindow();
  try {
    notifyMatch("monitor-2");
    await TestUtils.waitForCondition(() => AIWindow.hasMonitorAttention);

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contents.monitors.length === 2);
    await contents.updateComplete;

    const labels = [
      ...contents.shadowRoot.querySelectorAll(".monitor-section-label"),
    ];
    Assert.deepEqual(
      labels.map(label => label.getAttribute("data-l10n-id")),
      [
        "smartwindow-monitor-panel-new-matches",
        "smartwindow-monitor-panel-watching",
      ],
      "The New matches section is listed above Recent"
    );

    const sections = [...contents.shadowRoot.querySelectorAll(".monitor-rows")];
    Assert.deepEqual(
      [...sections[0].querySelectorAll(".monitor-row-title")].map(
        title => title.textContent
      ),
      ["Ticket price"],
      "The newly matched monitor is under New matches"
    );
    Assert.deepEqual(
      [...sections[1].querySelectorAll(".monitor-row-title")].map(
        title => title.textContent
      ),
      ["Concert tickets"],
      "The rest stay under Recent"
    );

    Assert.ok(
      sections[0].querySelector(
        ".monitor-row-result.match .monitor-row-match-dot"
      ),
      "The matched row shows a green dot beside its Match status"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;

    // Opening consumed the match, so reopening has no New matches section and the
    // monitor now sits under Recent.
    const shownAgain = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panelAgain = (await shownAgain).target;
    const contentsAgain = panelAgain.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contentsAgain.monitors.length === 2);
    await contentsAgain.updateComplete;

    Assert.deepEqual(
      [
        ...contentsAgain.shadowRoot.querySelectorAll(".monitor-section-label"),
      ].map(label => label.getAttribute("data-l10n-id")),
      ["smartwindow-monitor-panel-watching"],
      "Reopening drops the New matches section"
    );
    Assert.deepEqual(
      [...contentsAgain.shadowRoot.querySelectorAll(".monitor-row-title")].map(
        title => title.textContent
      ),
      ["Ticket price", "Concert tickets"],
      "The previously new match now sits under Recent with the others"
    );
    Assert.ok(
      !contentsAgain.shadowRoot.querySelector(".monitor-row-match-dot"),
      "The green dot is gone once the match moved back to Recent"
    );

    const hiddenAgain = BrowserTestUtils.waitForEvent(
      panelAgain,
      "popuphidden"
    );
    panelAgain.hidePopup();
    await hiddenAgain;
  } finally {
    sb.restore();
    AIWindow.clearMonitorAttention();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * "Create new task" swaps the panel to the agent-monitor-item create form, and
 * submitting it creates a monitor through MonitorAgent and returns to the list.
 */
add_task(async function test_monitor_panel_create_view() {
  const sb = this.sinon.createSandbox();
  const createMonitor = sb.stub(MonitorAgent, "createMonitor").resolves("id-1");
  sb.stub(MonitorAgent, "listMonitors").resolves([]);
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await contents.updateComplete;

    contents.shadowRoot
      .querySelector(".monitor-footer-row")
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await contents.updateComplete;

    Assert.equal(contents.view, "create", "Panel switches to the create view");
    const form = contents.shadowRoot.querySelector("agent-monitor-item");
    Assert.ok(form, "Create view renders the monitor item form");
    Assert.equal(form.mode, "create", "Monitor item is in create mode");
    Assert.ok(
      !form.selfContained,
      "The panel frames and titles the form itself"
    );

    form.dispatchEvent(
      new win.CustomEvent("agent-monitor-item:submit", {
        detail: {
          mode: "create",
          monitorName: "Ticket price",
          condition: "price drops",
          watchUrls: ["https://example.com/"],
          schedule: { frequency: "weekly", time: "09:30", weekday: 3 },
        },
        bubbles: true,
        composed: true,
      })
    );
    await TestUtils.waitForCondition(() => contents.view === "list");

    Assert.ok(createMonitor.calledOnce, "Submitting creates one monitor");
    Assert.deepEqual(
      createMonitor.firstCall.args[0],
      {
        prompt: "price drops",
        watchUrls: ["https://example.com/"],
        pageTitle: "Ticket price",
        schedule: { type: "weekly", hour: 9, minute: 30, weekday: 3 },
        source: "toolbar_panel",
      },
      "Form values are mapped to the shape MonitorAgent stores"
    );
    Assert.equal(
      contents.justCreatedId,
      "id-1",
      "The new monitor is named so its row can animate in"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The create form opens watching the page the user is on, unless that page is
 * one a monitor cannot watch.
 */
add_task(async function test_monitor_panel_create_seeds_current_page() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([]);
  const win = await openAIWindow();

  const openCreateForm = async () => {
    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await contents.updateComplete;
    contents.shadowRoot
      .querySelector(".monitor-footer-row")
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await contents.updateComplete;
    const form = contents.shadowRoot.querySelector("agent-monitor-item");
    await form.updateComplete;
    return { panel, form };
  };

  const closePanel = async panel => {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  };

  const pageChips = form =>
    form.shadowRoot.querySelectorAll(".page-pills-row ai-website-chip");

  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    let { panel, form } = await openCreateForm();
    // pageUrls is seeded a render before the chip is drawn, so wait for it.
    await TestUtils.waitForCondition(
      () => pageChips(form).length === 1,
      "Waiting for the seeded page to render as a chip"
    );
    Assert.deepEqual(
      form.pageUrls,
      ["https://example.com/"],
      "The form opens watching the page the user is on"
    );
    Assert.equal(
      pageChips(form).length,
      1,
      "The seeded page is shown as a chip, so the user can drop it"
    );
    await closePanel(panel);

    await promiseNavigateAndLoad(win.gBrowser.selectedBrowser, "about:robots");
    ({ panel, form } = await openCreateForm());
    Assert.deepEqual(
      form.pageUrls,
      [],
      "A page no monitor can watch seeds nothing"
    );
    await closePanel(panel);
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The panel header names whichever view is showing and only offers a back button
 * while there is somewhere to go back to.
 */
add_task(async function test_monitor_panel_header_follows_view() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([]);
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    const title = panel.querySelector(".panel-header > h1 > span");
    await contents.updateComplete;

    Assert.ok(
      !panel.querySelector(".subviewbutton-back"),
      "The list view has no back button"
    );

    const openCreateView = async () => {
      contents.shadowRoot
        .querySelector(".monitor-footer-row")
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await contents.updateComplete;
      await win.document.l10n.translateFragment(panel);
    };

    await openCreateView();
    Assert.equal(
      title.textContent,
      "Create new task",
      "Header names the create view"
    );
    const backButton = panel.querySelector(".subviewbutton-back");
    Assert.ok(backButton, "Create view offers a back button");
    Assert.equal(
      backButton.getAttribute("aria-label"),
      "Back",
      "Back button is labelled for assistive technology"
    );

    backButton.doCommand();
    await contents.updateComplete;
    await win.document.l10n.translateFragment(panel);
    Assert.equal(contents.view, "list", "Back returns to the list view");
    Assert.equal(
      title.textContent,
      "Tasks",
      "Header names the list view again"
    );
    Assert.ok(
      !panel.querySelector(".subviewbutton-back"),
      "Back button is removed with the create view so the title stays centered"
    );

    // Cancelling the form is the other way back out of the create view.
    await openCreateView();
    contents.shadowRoot.querySelector("agent-monitor-item").dispatchEvent(
      new win.CustomEvent("agent-monitor-item:cancel", {
        detail: {},
        bubbles: true,
        composed: true,
      })
    );
    await contents.updateComplete;
    await win.document.l10n.translateFragment(panel);
    Assert.equal(contents.view, "list", "Cancelling returns to the list view");
    Assert.equal(
      title.textContent,
      "Tasks",
      "Header follows the cancelled view back"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Unlike the ask button, the monitor button stays available in immersive view
 * (the Smart Window full page).
 */
add_task(async function test_monitor_button_immersive_view() {
  const win = await openAIWindow();
  try {
    Assert.ok(
      win.document.documentElement.hasAttribute("aiwindow-immersive-view"),
      "Chrome window has the aiwindow-immersive-view attribute"
    );
    Assert.ok(
      !getMonitorButton(win).hidden,
      "Monitor button is not hidden in immersive view"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The monitor button is not visible in a Classic Window.
 */
add_task(async function test_monitor_button_classic_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({
    openerWindow: null,
  });
  try {
    Assert.ok(
      BrowserTestUtils.isHidden(getMonitorButton(win)),
      "Monitor button is not visible in the toolbar for classic window"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The button is a CustomizableUI widget: the user can move it out of the navbar
 * and the removal sticks across windows.
 */
add_task(async function test_monitor_button_is_customizable() {
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(WIDGET_ID)?.area,
    CustomizableUI.AREA_NAVBAR,
    "Monitor button is placed in the navbar by default"
  );
  Assert.ok(
    CustomizableUI.isWidgetRemovable(WIDGET_ID),
    "Monitor button is removable"
  );

  CustomizableUI.removeWidgetFromArea(WIDGET_ID);
  try {
    Assert.equal(
      CustomizableUI.getPlacementOfWidget(WIDGET_ID),
      null,
      "Monitor button has no placement once removed"
    );

    const win = await openAIWindow();
    try {
      await promiseNavigateAndLoad(
        win.gBrowser.selectedBrowser,
        "https://example.com/"
      );
      Assert.ok(
        !getMonitorButton(win)?.closest("toolbar"),
        "A new window does not put the removed button back on a toolbar"
      );
      Assert.ok(
        CustomizableUI.getUnusedWidgets(win.gNavToolbox.palette).some(
          widget => widget.id == WIDGET_ID
        ),
        "Removed monitor button is available in the customize palette"
      );
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }
  } finally {
    // Not CustomizableUI.reset(): it rebuilds every area from the areas'
    // defaultPlacements, which never contain widgets whose defaultArea is a
    // builtin toolbar (see CustomizableUIInternal.createWidget). That would
    // unplace ai-window-toggle for the rest of the browser session.
    CustomizableUI.addWidgetToArea(WIDGET_ID, CustomizableUI.AREA_NAVBAR);
  }
});

/**
 * The button needs both the agent feature pref and its own toolbar pref, so the
 * widget is not registered at all - and therefore stays out of the customize
 * palette - when either one is off.
 */
add_task(async function test_monitor_button_pref_gates() {
  for (const [agent, toolbar] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.smartwindow.agent.enabled", agent],
        ["browser.smartwindow.agent.toolbar.enabled", toolbar],
      ],
    });
    const win = await openAIWindow();
    try {
      await promiseNavigateAndLoad(
        win.gBrowser.selectedBrowser,
        "https://example.com/"
      );
      Assert.equal(
        getMonitorButton(win),
        null,
        `Monitor button is absent with agent.enabled=${agent}, agent.toolbar.enabled=${toolbar}`
      );
      Assert.ok(
        !CustomizableUI.getUnusedWidgets(win.gNavToolbox.palette).some(
          widget => widget.id == WIDGET_ID
        ),
        `Monitor button is not in the customize palette with agent.enabled=${agent}, agent.toolbar.enabled=${toolbar}`
      );
    } finally {
      await BrowserTestUtils.closeWindow(win);
      await SpecialPowers.popPrefEnv();
    }
  }
});

/**
 * The button is the toolbar surface of a feature that cannot create a monitor
 * outside its supported regions, so it follows the same region gate as the
 * /watch command and the tasks page rather than offering a dead button.
 */
add_task(async function test_monitor_button_region_gate() {
  await SpecialPowers.pushPrefEnv({
    set: [[SUPPORTED_REGIONS_PREF, "CA"]],
  });

  AIWindow._updateMonitorWidgetRegistration();
  const win = await openAIWindow();
  try {
    Assert.equal(
      getMonitorButton(win),
      null,
      "Monitor button is absent when the home region is unsupported"
    );
    Assert.ok(
      !CustomizableUI.getUnusedWidgets(win.gNavToolbox.palette).some(
        widget => widget.id == WIDGET_ID
      ),
      "It is not offered in the customize palette either"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * A fresh profile has no home region until detection finishes, so the button
 * has to appear when that lands rather than waiting for the next restart.
 */
add_task(async function test_monitor_button_appears_when_region_arrives() {
  const originalRegion = Region.home;
  Region._setHomeRegion("", false);
  AIWindow._updateMonitorWidgetRegistration();
  const win = await openAIWindow();
  try {
    Assert.equal(
      getMonitorButton(win),
      null,
      "No button while the home region is still unknown"
    );

    // _setHomeRegion notifies browser-region-updated, which AIWindow observes.
    Region._setHomeRegion(TEST_REGION);
    Assert.ok(
      getMonitorButton(win),
      "Detecting a supported region registers the button without a restart"
    );
  } finally {
    Region._setHomeRegion(originalRegion, false);
    AIWindow._updateMonitorWidgetRegistration();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * onCreated has to resolve the window the node was built for. Every other path
 * that sets `hidden` runs from AIWindow.init, so a node built after a window is
 * already initialised is the only one that depends on onCreated getting it
 * right, and it stays wrongly hidden if it does not.
 */
add_task(async function test_monitor_button_visible_when_created_late() {
  const win = await openAIWindow();
  try {
    Assert.ok(!getMonitorButton(win).hidden, "Button is visible to begin with");

    // Rebuild the widget while the Smart Window is open, so onCreated is the
    // only thing deciding whether this node is hidden.
    AIWindow._destroyMonitorWidget();
    AIWindow._createMonitorWidget();

    Assert.ok(
      !getMonitorButton(win).hidden,
      "A node built after the window was initialised is still visible"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
