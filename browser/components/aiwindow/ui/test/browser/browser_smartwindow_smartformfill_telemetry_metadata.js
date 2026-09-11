/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head_smartformfill_telemetry.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_smartformfill_telemetry.js",
  this
);

const EXPECTED_FORMS = 2;

/**
 * Adds a field to the first form, which the document's observer reports as a
 * form update.
 *
 * @param {MozBrowser} browser
 * @returns {Promise<void>}
 */
function addFieldToForm(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    input.type = "text";
    input.name = "city";
    content.document.getElementById("contact").append(input);
  });
}

add_task(async function test_one_classification_flow_per_form() {
  await withFormPage({}, async ({ win, browser, actor }) => {
    await runRoundOnForm(browser, actor, "#email");
    await closeFormReview(win, browser);
    await runRoundOnForm(browser, actor, "#reason");

    const requests = recordedExtras("formFillClassifyRequest");
    const [contact, details] = requests;

    Assert.equal(
      requests.length,
      EXPECTED_FORMS,
      "One classification request per form"
    );
    Assert.ok(contact.flow_id, "The first form's request carries a flow id");
    Assert.ok(details.flow_id, "The second form's request carries a flow id");
    Assert.notEqual(
      contact.flow_id,
      details.flow_id,
      "Each form gets its own flow id"
    );
    Assert.equal(
      Number(contact.fields_total),
      2,
      "fields_total counts the email and tel fields"
    );
    Assert.equal(
      Number(details.fields_total),
      1,
      "fields_total counts the textarea"
    );

    for (const request of requests) {
      Assert.equal(
        request.model,
        TEST_MODEL_INFO.model,
        "The request reports the model it was dispatched with"
      );
      Assert.equal(
        request.prompt_version,
        TEST_MODEL_INFO.promptVersion,
        "The request reports the prompt version it was dispatched with"
      );
    }

    const responses = await waitForEvents(
      "formFillClassifyResponse",
      EXPECTED_FORMS
    );

    // Responses land in whatever order the requests complete, so each one is
    // looked up by the flow of its request.
    for (const request of requests) {
      const response = responses.find(
        candidate => candidate.flow_id === request.flow_id
      );

      Assert.ok(response, `Flow ${request.flow_id} recorded its response`);
      Assert.equal(
        response.error,
        "false",
        "A successful classification records no error"
      );
      Assert.strictEqual(
        response.error_message,
        undefined,
        "A success carries no error code"
      );
    }
  });
});

add_task(async function test_a_structure_change_starts_a_new_flow() {
  await withFormPage({}, async ({ win, browser, actor }) => {
    await runRoundOnForm(browser, actor);

    // That a changed form is asked about again is covered by
    // browser_smartwindow_smartformfill_metadata_lifecycle.js. What only shows
    // here is that the second round stops sharing a flow with the first, so the
    // two attempts are not merged into one in the data.
    await addFieldToForm(browser);
    await closeFormReview(win, browser);
    await runRoundOnForm(browser, actor);

    const [first, second] = recordedExtras("formFillClassifyRequest");

    Assert.ok(first.flow_id, "The first round carries a flow id");
    Assert.ok(second.flow_id, "The second round carries a flow id");
    Assert.notEqual(
      first.flow_id,
      second.flow_id,
      "A form whose fields changed starts a new flow"
    );
  });
});

add_task(async function test_failed_classification_records_the_error() {
  const failure = new Error("Error");
  failure.clientReason = "connectionFailure";

  await withFormPage(
    {
      classifyFields: async (request, { onDispatch }) => {
        onDispatch?.(TEST_MODEL_INFO);

        throw failure;
      },
    },
    async ({ browser, actor }) => {
      await runRoundOnForm(browser, actor);

      const responses = await waitForEvents("formFillClassifyResponse", 1);

      for (const response of responses) {
        Assert.equal(
          response.error,
          "true",
          `Flow ${response.flow_id} is reported as failed`
        );
        Assert.equal(
          response.error_message,
          "connectionFailure",
          `Flow ${response.flow_id} reports what the failure was attributed to`
        );
      }
    }
  );
});

add_task(async function test_a_round_records_its_relevant_tabs_request() {
  await withFormPage({}, async ({ browser, actor }) => {
    await runRoundOnForm(browser, actor);
    const requests = await waitForEvents("formRelevantTabsRequest", 1);

    Assert.equal(requests.length, 1, "The round records one request");

    const responses = await waitForEvents("formRelevantTabsResponse", 1);

    for (const request of requests) {
      Assert.equal(
        request.model,
        TEST_MODEL_INFO.model,
        "The request reports the model it was dispatched with"
      );
      Assert.equal(
        request.prompt_version,
        TEST_MODEL_INFO.promptVersion,
        "The request reports the prompt version it was dispatched with"
      );
      Assert.greater(
        Number(request.tabs_sent),
        0,
        "The request reports the tabs the model got to choose from"
      );

      const response = responses.find(
        candidate => candidate.flow_id === request.flow_id
      );
      Assert.ok(response, `Flow ${request.flow_id} recorded its response`);
      Assert.equal(
        response.error,
        "false",
        "A successful round records no error"
      );
    }
  });
});

add_task(async function test_failed_relevant_tabs_records_the_error() {
  // Carries no client reason, so it has to be reported as the catch-all rather
  // than as anything the error itself holds.
  const failure = new Error("Error");
  failure.name = "TabFailure";
  failure.error = "a backend message that must not be recorded";

  await withFormPage(
    {
      findRelevantTabs: async (request, { onDispatch }) => {
        onDispatch?.(TEST_MODEL_INFO);

        throw failure;
      },
    },
    async ({ browser, actor }) => {
      await runRoundOnForm(browser, actor);

      // Losing the tab selection is not fatal: the round goes on without tabs
      // as context, so the only thing to check is that the failure was
      // reported rather than the round looking like a success.
      const responses = await waitForEvents("formRelevantTabsResponse", 1);

      for (const response of responses) {
        Assert.equal(
          response.error,
          "true",
          `Flow ${response.flow_id} is reported as failed`
        );
        Assert.equal(
          response.error_message,
          "genericError",
          `Flow ${response.flow_id} reports a failure it cannot attribute as the catch-all`
        );
        Assert.strictEqual(
          response.tabs_selected,
          undefined,
          "No answer came back, so no selected tab count is reported"
        );
        Assert.strictEqual(
          response.tabs_used,
          undefined,
          "No answer came back, so no used tab count is reported"
        );
      }
    }
  );
});

add_task(async function test_tabs_never_offered_are_selected_but_not_used() {
  await withFormPage(
    {
      // The response schema does not constrain the ids to the ones that were
      // offered, so the model can answer with one that was never in the list.
      findRelevantTabs: async (request, { onDispatch }) => {
        onDispatch?.(TEST_MODEL_INFO);

        return {
          selectedTabs: [
            { id: "made-up-1", relevance: "high" },
            { id: "made-up-2", relevance: "medium" },
          ],
        };
      },
    },
    async ({ browser, actor }) => {
      await runRoundOnForm(browser, actor);

      const [response] = await waitForEvents("formRelevantTabsResponse", 1);

      Assert.equal(
        response.tabs_selected,
        "2",
        "tabs_selected is what the model returned"
      );
      Assert.equal(
        response.tabs_used,
        "0",
        "tabs_used counts only the tabs that survived validation"
      );
    }
  );
});
