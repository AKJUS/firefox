/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AppConstants is imported eagerly by AboutPreferences.sys.mjs and Jest can't
// resolve resource:// URIs, so mock it the way karma's webpack config did.
jest.mock(
  "resource://gre/modules/AppConstants.sys.mjs",
  () => ({
    AppConstants: {
      MOZILLA_OFFICIAL: true,
      MOZ_APP_VERSION: "69.0a1",
      isPlatformAndVersionAtMost() {
        return false;
      },
      platform: "win",
    },
  }),
  { virtual: true }
);

import {
  AboutPreferences,
  PREFERENCES_LOADED_EVENT,
  PREFERENCES_LOADED_EVENT_SUBPANE,
} from "lib/AboutPreferences.sys.mjs";
import { actionTypes as at, actionCreators as ac } from "common/Actions.mjs";
import { mockServices, stubGlobals } from "test/jest/test-utils";

describe("AboutPreferences Feed", () => {
  let restoreGlobals;
  let fakeServices;
  let Sections;
  let DiscoveryStream;
  let instance;

  // sinon's `.withArgs(pref, false).returns(value)` becomes a lookup table:
  // any pref that isn't listed reads back as undefined.
  const setBoolPrefs = prefs => {
    fakeServices.prefs.getBoolPref.mockImplementation(pref => prefs[pref]);
  };

  beforeEach(() => {
    Sections = [];
    DiscoveryStream = { config: { enabled: false } };
    instance = new AboutPreferences();
    instance.store = {
      dispatch: jest.fn(),
      getState: () => ({ Sections, DiscoveryStream }),
    };
    fakeServices = mockServices(["obs", "prefs"]);
    restoreGlobals = stubGlobals({
      Services: fakeServices,
    });
  });
  afterEach(() => {
    restoreGlobals();
    jest.restoreAllMocks();
  });

  describe("#onAction", () => {
    it("should call .init() on an INIT action", () => {
      const stub = jest.spyOn(instance, "init").mockImplementation(() => {});

      instance.onAction({ type: at.INIT });

      expect(stub).toHaveBeenCalledTimes(1);
    });
    it("should call .uninit() on an UNINIT action", () => {
      const stub = jest.spyOn(instance, "uninit").mockImplementation(() => {});

      instance.onAction({ type: at.UNINIT });

      expect(stub).toHaveBeenCalledTimes(1);
    });
    it("should call .openPreferences on SETTINGS_OPEN", () => {
      const action = {
        type: at.SETTINGS_OPEN,
        _target: {
          window: { openPreferences: jest.fn() },
        },
      };
      instance.onAction(action);
      expect(action._target.window.openPreferences).toHaveBeenCalledTimes(1);
    });
    it("should call .BrowserAddonUI.openAddonsMgr with the extension id on OPEN_WEBEXT_SETTINGS", () => {
      const action = {
        type: at.OPEN_WEBEXT_SETTINGS,
        data: "foo",
        _target: {
          window: {
            BrowserAddonUI: { openAddonsMgr: jest.fn() },
          },
        },
      };
      instance.onAction(action);
      expect(
        action._target.window.BrowserAddonUI.openAddonsMgr
      ).toHaveBeenCalledWith("addons://detail/foo");
    });
  });

  describe("#observe", () => {
    let renderPreferenceSection;
    let toggleRestoreDefaults;

    beforeEach(() => {
      // Stub out All The Things
      renderPreferenceSection = jest
        .spyOn(instance, "renderPreferenceSection")
        .mockImplementation(() => {});
      toggleRestoreDefaults = jest
        .spyOn(instance, "toggleRestoreDefaults")
        .mockImplementation(() => {});
    });

    it("should watch for about:preferences loading", () => {
      instance.init();

      expect(fakeServices.obs.addObserver).toHaveBeenCalledTimes(2);
      expect(fakeServices.obs.addObserver).toHaveBeenCalledWith(
        instance,
        PREFERENCES_LOADED_EVENT
      );
      expect(fakeServices.obs.addObserver).toHaveBeenCalledWith(
        instance,
        PREFERENCES_LOADED_EVENT_SUBPANE
      );
    });
    it("should stop watching on uninit", () => {
      instance.uninit();

      expect(fakeServices.obs.removeObserver).toHaveBeenCalledTimes(2);
      expect(fakeServices.obs.removeObserver).toHaveBeenCalledWith(
        instance,
        PREFERENCES_LOADED_EVENT
      );
      expect(fakeServices.obs.removeObserver).toHaveBeenCalledWith(
        instance,
        PREFERENCES_LOADED_EVENT_SUBPANE
      );
    });
    it("should try to render on event", async () => {
      Sections.push({
        rowsPref: "row_pref",
        maxRows: 3,
        pref: { descString: "foo" },
        learnMore: { link: "https://foo.com" },
        id: "topstories",
      });

      Sections.push({
        rowsPref: "row_pref",
        maxRows: 3,
        pref: { descString: "foo" },
        learnMore: { link: "https://foo.com" },
        id: "highlights",
      });

      await instance.observe(window, PREFERENCES_LOADED_EVENT);

      // Render all the prefs
      expect(renderPreferenceSection).toHaveBeenCalledTimes(6);

      // Show or hide the "Restore defaults" button depending on prefs
      expect(toggleRestoreDefaults).toHaveBeenCalledTimes(1);
    });

    describe("when browser.settings-redesign.enabled is true", () => {
      let restoreRedesignGlobals;
      let registerGroups;
      let getSettingGroup;
      let insertFTLIfNeeded;

      beforeEach(() => {
        fakeServices.prefs.getBoolPref.mockReturnValue(true);
        registerGroups = jest.fn();
        let homeCalls = 0;
        getSettingGroup = jest.fn(group => {
          if (group !== "home") {
            return undefined;
          }
          homeCalls += 1;
          if (homeCalls === 1) {
            throw new Error("Not yet registered");
          }
          return true;
        });
        insertFTLIfNeeded = jest.fn();
        restoreRedesignGlobals = stubGlobals({
          SettingGroupManager: {
            registerGroups,
            get: getSettingGroup,
          },
          MozXULElement: { insertFTLIfNeeded },
        });
        jest.spyOn(instance, "_registerPreferences").mockImplementation();
        jest.spyOn(instance, "_setupHomeGroup").mockReturnValue({});
      });

      afterEach(() => {
        restoreRedesignGlobals();
      });

      it("should register newtab.ftl with the preferences document", () => {
        instance.observe(window);

        expect(insertFTLIfNeeded).toHaveBeenCalledWith(
          "browser/newtab/newtab.ftl"
        );
      });

      it("should call registerGroups with home only", async () => {
        // homepage/customHomepage are owned by components/preferences.
        await instance.observe(window);

        expect(registerGroups).toHaveBeenCalledTimes(1);
        const [[groups]] = registerGroups.mock.calls;
        expect(Object.keys(groups)).toEqual(["home"]);
        expect(groups).not.toHaveProperty("homepage");
        expect(groups).not.toHaveProperty("customHomepage");
      });

      it("should not call renderPreferenceSection or toggleRestoreDefaults", async () => {
        // The redesign path returns early; legacy DOM rendering must not run.
        await instance.observe(window);

        expect(renderPreferenceSection).not.toHaveBeenCalled();
        expect(toggleRestoreDefaults).not.toHaveBeenCalled();
      });

      it("should not register a second time when observe fires again for the same window", async () => {
        await instance.observe(window, PREFERENCES_LOADED_EVENT);
        await instance.observe(window, PREFERENCES_LOADED_EVENT_SUBPANE);

        expect(instance._registerPreferences).toHaveBeenCalledTimes(1);
        expect(registerGroups).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("#_registerPreferences", () => {
    it("should call Preferences.addAll once with all pref ids", () => {
      const addAll = jest.fn();

      instance._registerPreferences({ Preferences: { addAll } });

      expect(addAll).toHaveBeenCalledTimes(1);
      // Spot-check prefs from the beginning, middle, and end of the list.
      const [[prefs]] = addAll.mock.calls;
      expect(Array.isArray(prefs)).toBe(true);
      expect(
        prefs.some(
          p => p.id === "browser.newtabpage.activity-stream.showSearch"
        )
      ).toBe(true);
      expect(
        prefs.some(
          p => p.id === "browser.newtabpage.activity-stream.feeds.topsites"
        )
      ).toBe(true);
      expect(
        prefs.some(
          p =>
            p.id ===
            "browser.newtabpage.activity-stream.section.highlights.includeVisited"
        )
      ).toBe(true);
      expect(
        prefs.some(
          p =>
            p.id === "browser.newtabpage.activity-stream.hideLogo" &&
            p.type === "bool" &&
            p.inverted === true
        )
      ).toBe(true);
    });
  });

  describe("#_setupHomeGroup", () => {
    let addSetting;
    let Preferences;

    beforeEach(() => {
      addSetting = jest.fn();
      Preferences = { addSetting };
    });

    it("should register weather against showWeather prefs when Nova is disabled", () => {
      setBoolPrefs({
        "browser.newtabpage.activity-stream.nova.enabled": false,
      });

      instance._setupHomeGroup({ Preferences });

      const calls = addSetting.mock.calls.map(([{ id, pref }]) => ({
        id,
        pref,
      }));
      expect(
        calls.some(
          c =>
            c.id === "weather" &&
            c.pref === "browser.newtabpage.activity-stream.showWeather"
        )
      ).toBe(true);
      expect(
        calls.some(
          c =>
            c.pref ===
            "browser.newtabpage.activity-stream.widgets.weather.enabled"
        )
      ).toBe(false);
    });

    it("should register weather against widgets.weather.enabled when Nova is enabled", () => {
      setBoolPrefs({ "browser.newtabpage.activity-stream.nova.enabled": true });

      instance._setupHomeGroup({ Preferences });

      const calls = addSetting.mock.calls.map(([{ id, pref }]) => ({
        id,
        pref,
      }));
      expect(
        calls.some(
          c =>
            c.id === "weather" &&
            c.pref ===
              "browser.newtabpage.activity-stream.widgets.weather.enabled"
        )
      ).toBe(true);
      expect(
        calls.some(
          c => c.pref === "browser.newtabpage.activity-stream.showWeather"
        )
      ).toBe(false);
    });

    const findSetting = id =>
      addSetting.mock.calls.find(([s]) => s.id === id)[0];

    it("shows a widget toggle when the widget is enabled via trainhopConfig even if its system pref is off", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({
        Prefs: {
          values: { trainhopConfig: { widgets: { listsEnabled: true } } },
        },
      });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("lists").visible({ listsEnabled: { value: false } })
      ).toBe(true);
    });

    it("shows a widget toggle when its system pref is on (read live from deps)", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({ Prefs: { values: {} } });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("lists").visible({ listsEnabled: { value: true } })
      ).toBe(true);
    });

    it("hides a widget toggle when neither the system pref nor trainhopConfig enable it", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({ Prefs: { values: {} } });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("lists").visible({ listsEnabled: { value: false } })
      ).toBe(false);
    });

    it("shows a widget toggle when revealed via widgetsSettings even if its system pref is off", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({
        Prefs: {
          values: {
            trainhopConfig: { widgetsSettings: { listsVisible: true } },
          },
        },
      });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("lists").visible({ listsEnabled: { value: false } })
      ).toBe(true);
    });

    it("shows the widgets group when the container is enabled via trainhopConfig even if the system pref is off", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({
        Prefs: { values: { trainhopConfig: { widgets: { enabled: true } } } },
      });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("widgets").visible({ widgetsEnabled: { value: false } })
      ).toBe(true);
    });

    it("shows the widgets group when the container system pref is on (read live from deps)", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({ Prefs: { values: {} } });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("widgets").visible({ widgetsEnabled: { value: true } })
      ).toBe(true);
    });

    it("hides the widgets group when neither the system pref nor trainhopConfig enable the container", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({ Prefs: { values: {} } });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("widgets").visible({ widgetsEnabled: { value: false } })
      ).toBe(false);
    });

    it("shows the widgets group when revealed via widgetsSettings even if the system pref is off", () => {
      fakeServices.prefs.getBoolPref.mockReturnValue(false);
      instance.store.getState = () => ({
        Prefs: {
          values: { trainhopConfig: { widgetsSettings: { enabled: true } } },
        },
      });

      instance._setupHomeGroup({ Preferences });

      expect(
        findSetting("widgets").visible({ widgetsEnabled: { value: false } })
      ).toBe(true);
    });

    it("nests the weather toggle inside the widgets group when Nova and the widgets system pref are enabled", () => {
      setBoolPrefs({ "browser.newtabpage.activity-stream.nova.enabled": true });
      instance.store.getState = () => ({
        Prefs: { values: { "widgets.system.enabled": true } },
      });

      const group = instance._setupHomeGroup({ Preferences });

      expect(group.items.find(i => i.id === "weather")).toBeUndefined();
      const widgets = group.items.find(i => i.id === "widgets");
      expect(widgets.items.some(i => i.id === "weather")).toBe(true);
    });

    it("nests the weather toggle inside the widgets group when the container is enabled via trainhopConfig", () => {
      setBoolPrefs({ "browser.newtabpage.activity-stream.nova.enabled": true });
      instance.store.getState = () => ({
        Prefs: { values: { trainhopConfig: { widgets: { enabled: true } } } },
      });

      const group = instance._setupHomeGroup({ Preferences });

      expect(group.items.find(i => i.id === "weather")).toBeUndefined();
      const widgets = group.items.find(i => i.id === "widgets");
      const nestedWeather = widgets.items.find(i => i.id === "weather");
      expect(nestedWeather).toBeDefined();
      // Nested under Widgets, Weather is a checkbox like its siblings.
      expect(nestedWeather).not.toHaveProperty("control");
    });

    it("keeps the weather toggle standalone when Nova is enabled but the widgets system pref is off", () => {
      setBoolPrefs({ "browser.newtabpage.activity-stream.nova.enabled": true });
      instance.store.getState = () => ({
        Prefs: {
          values: {
            "widgets.system.enabled": false,
            "widgets.system.weather.enabled": true,
          },
        },
      });

      const group = instance._setupHomeGroup({ Preferences });

      expect(group.items.some(i => i.id === "weather")).toBe(true);
      const widgets = group.items.find(i => i.id === "widgets");
      expect(widgets.items.some(i => i.id === "weather")).toBe(false);
    });

    it("keeps the weather toggle as a standalone row when Nova is disabled", () => {
      setBoolPrefs({
        "browser.newtabpage.activity-stream.nova.enabled": false,
      });

      const group = instance._setupHomeGroup({ Preferences });

      const standaloneWeather = group.items.find(i => i.id === "weather");
      expect(standaloneWeather).toBeDefined();
      // Standalone, Weather is a top-level toggle like the other rows.
      expect(standaloneWeather.control).toBe("moz-toggle");
      const widgets = group.items.find(i => i.id === "widgets");
      expect(widgets.items.some(i => i.id === "weather")).toBe(false);
    });
  });

  describe("PREFS_FOR_SETTINGS (legacy path, settings-redesign disabled)", () => {
    let renderStub;

    beforeEach(() => {
      renderStub = jest
        .spyOn(instance, "renderPreferenceSection")
        .mockImplementation(() => {});
      jest
        .spyOn(instance, "toggleRestoreDefaults")
        .mockImplementation(() => {});
    });

    it("uses showWeather pref when Nova is disabled", () => {
      setBoolPrefs({
        "browser.newtabpage.activity-stream.nova.enabled": false,
      });

      instance.observe(window);

      const weatherSection = renderStub.mock.calls
        .map(([s]) => s)
        .find(s => s && s.id === "weather");
      expect(weatherSection).toBeDefined();
      expect(weatherSection.pref.feed).toBe("showWeather");
    });

    it("uses widgets.weather.enabled pref when Nova is enabled", () => {
      setBoolPrefs({ "browser.newtabpage.activity-stream.nova.enabled": true });

      instance.observe(window);

      const weatherSection = renderStub.mock.calls
        .map(([s]) => s)
        .find(s => s && s.id === "weather");
      expect(weatherSection).toBeDefined();
      expect(weatherSection.pref.feed).toBe("widgets.weather.enabled");
    });
  });

  describe("#renderPreferenceSection", () => {
    let node;
    let Preferences;
    let prefObject;
    let document;

    beforeEach(() => {
      node = {
        appendChild: jest.fn(child => child),
        addEventListener: jest.fn(),
        classList: { add: jest.fn(), remove: jest.fn() },
        cloneNode: jest.fn(function cloneNode() {
          return this;
        }),
        insertAdjacentElement: jest.fn((position, element) => element),
        setAttribute: jest.fn(),
        remove: jest.fn(),
        style: {},
      };
      document = {
        createXULElement: jest.fn(() => node),
        l10n: {
          setAttributes(el, id, args) {
            el.setAttribute("data-l10n-id", id);
            el.setAttribute("data-l10n-args", JSON.stringify(args));
          },
        },
        createProcessingInstruction: jest.fn(),
        createElementNS: jest.fn(() => node),
        getElementById: jest.fn(() => node),
        insertBefore: jest.fn(child => child),
        querySelector: jest.fn(() => ({ appendChild: jest.fn() })),
      };
      prefObject = { on: jest.fn() };
      Preferences = {
        add: jest.fn(),
        get: jest.fn(() => prefObject),
      };
    });

    describe("#linkPref", () => {
      it("should add a pref to the global", () => {
        const sectionData = { pref: { feed: "feed" } };
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(Preferences.add).toHaveBeenCalledTimes(1);
      });

      it("should skip adding if not shown", () => {
        const sectionData = { shouldHidePref: true };
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(Preferences.add).not.toHaveBeenCalled();
      });
    });

    describe("title line", () => {
      it("should render a title", () => {
        const titleString = "the_title";
        const sectionData = { pref: { titleString } };
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.setAttribute).toHaveBeenCalledWith(
          "data-l10n-id",
          titleString
        );
      });
    });

    describe("top stories", () => {
      const href = "https://disclaimer/";
      const eventSource = "https://disclaimer/";
      let sectionData;

      beforeEach(() => {
        sectionData = {
          id: "topstories",
          pref: { feed: "feed", learnMore: { link: { href } } },
          eventSource,
        };
      });

      it("should setup a user event for top stories eventSource", () => {
        jest.spyOn(instance, "setupUserEvent");
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.addEventListener).toHaveBeenCalledWith(
          "command",
          expect.any(Function)
        );
        expect(instance.setupUserEvent).toHaveBeenCalledWith(node, eventSource);
      });

      it("should setup a user event for top stories nested pref eventSource", () => {
        jest.spyOn(instance, "setupUserEvent");
        const section = {
          id: "topstories",
          pref: {
            feed: "feed",
            learnMore: { link: { href } },
            nestedPrefs: [
              {
                name: "showSponsored",
                titleString:
                  "home-prefs-recommended-by-option-sponsored-stories",
                icon: "icon-info",
                eventSource: "POCKET_SPOCS",
              },
            ],
          },
        };
        instance.renderPreferenceSection(section, document, Preferences);

        expect(node.addEventListener).toHaveBeenCalledWith(
          "command",
          expect.any(Function)
        );
        expect(instance.setupUserEvent).toHaveBeenCalledWith(
          node,
          "POCKET_SPOCS"
        );
      });

      it("should fire store dispatch with onCommand", () => {
        const element = {
          addEventListener: (command, action) => {
            // Trigger the action right away because we only care about testing the action here.
            action({ target: { checked: true } });
          },
        };
        instance.setupUserEvent(element, eventSource);
        expect(instance.store.dispatch).toHaveBeenCalledWith(
          ac.UserEvent({
            event: "PREF_CHANGED",
            source: eventSource,
            value: { menu_source: "ABOUT_PREFERENCES", status: true },
          })
        );
      });

      // The Weather pref now has a link to learn more, other prefs such as Top Stories don't any more
      it("should add a link for weather", () => {
        const section = {
          id: "weather",
          pref: { feed: "feed", learnMore: { link: { href } } },
          eventSource,
        };

        instance.renderPreferenceSection(section, document, Preferences);

        expect(node.setAttribute).toHaveBeenCalledWith("href", href);
      });
    });

    describe("description line", () => {
      it("should render a description", () => {
        const descString = "the_desc";
        const sectionData = { pref: { descString } };

        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.setAttribute).toHaveBeenCalledWith(
          "data-l10n-id",
          descString
        );
      });

      it("should render rows dropdown with appropriate number", () => {
        const sectionData = {
          rowsPref: "row_pref",
          maxRows: 3,
          pref: { descString: "foo" },
        };

        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.setAttribute).toHaveBeenCalledWith("value", 1);
        expect(node.setAttribute).toHaveBeenCalledWith("value", 2);
        expect(node.setAttribute).toHaveBeenCalledWith("value", 3);
      });
    });
    describe("nested prefs", () => {
      const titleString = "im_nested";
      let sectionData;

      beforeEach(() => {
        sectionData = { pref: { nestedPrefs: [{ titleString }] } };
      });

      it("should render a nested pref", () => {
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.setAttribute).toHaveBeenCalledWith(
          "data-l10n-id",
          titleString
        );
      });

      it("should set node hidden to true", () => {
        sectionData.pref.nestedPrefs[0].hidden = true;

        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.hidden).toBe(true);
      });
      it("should add a change event", () => {
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(prefObject.on).toHaveBeenCalledTimes(1);
        expect(prefObject.on).toHaveBeenCalledWith(
          "change",
          expect.any(Function)
        );
      });

      it("should default node disabled to false", async () => {
        prefObject._value = true;

        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.disabled).toBe(false);
      });
      it("should default node disabled to true", async () => {
        instance.renderPreferenceSection(sectionData, document, Preferences);

        expect(node.disabled).toBe(true);
      });
      it("should set node disabled to true", async () => {
        prefObject._value = true;

        instance.renderPreferenceSection(sectionData, document, Preferences);
        prefObject._value = !prefObject._value;
        await prefObject.on.mock.calls[0][1]();

        expect(node.disabled).toBe(true);
      });
      it("should set node disabled to false", async () => {
        prefObject._value = false;

        instance.renderPreferenceSection(sectionData, document, Preferences);
        prefObject._value = !prefObject._value;
        await prefObject.on.mock.calls[0][1]();

        expect(node.disabled).toBe(false);
      });
    });
  });

  describe("#toggleRestoreDefaults", () => {
    it("should call toggleRestoreDefaultsBtn", async () => {
      const gHomePane = { toggleRestoreDefaultsBtn: jest.fn() };

      await instance.toggleRestoreDefaults(gHomePane);

      expect(gHomePane.toggleRestoreDefaultsBtn).toHaveBeenCalledTimes(1);
    });
  });

  describe("#getString", () => {
    it("should not fail if titleString is not provided", () => {
      const emptyPref = {};

      const returnString = instance.getString(emptyPref);
      expect(returnString).toBeUndefined();
    });

    it("should return the string id if titleString is just a string", () => {
      const titleString = "foo";

      const returnString = instance.getString(titleString);
      expect(returnString).toBe(titleString);
    });

    it("should set id and args if titleString is an object with id and values", () => {
      const titleString = { id: "foo", values: { provider: "bar" } };

      const returnString = instance.getString(titleString);
      expect(returnString).toBe(titleString.id);
    });
  });
});
