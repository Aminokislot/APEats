# Connect the actual Gemini Enterprise agent

Status (12 Nov 2026): adapter, agent instructions and menu export prepared; tested only against mocked StreamAssist responses. Live connection not configured or verified. An adapter tested with mocks is not a verified live integration. Until then the website uses the Gemini API (developer API) and labels answers as "Gemini", never as "Gemini Enterprise".

## Required organizer access

Obtain the Google Cloud project ID, Gemini Enterprise app ID, app location (`global`, `us` or `eu`), and the registered chat agent ID. Use the account to which the organizers granted access. A Gemini Developer API key is not a substitute.

The official [StreamAssist instructions](https://docs.cloud.google.com/gemini/enterprise/docs/invoke-agent-streamassist) require the Discovery Engine API and `discoveryengine.assistants.assist` permission. The calling identity also needs access to the relevant app, agent and menu data. Follow the organizer's app licensing and access policy. Request the narrowest role compatible with that policy rather than granting Owner.

## Create the agent inside Enterprise

1. Open the organizer's Gemini Enterprise app and create a Workflow Builder chat agent named APEats Food Guide.
2. Use `agent-instructions.md` as its instructions. Connect only the team-owned menu source; do not add unrelated personal Drive documents.
3. Run `npm run prepare:enterprise`. Import the reviewed `menu-source.md` contents into a supported document source for this app, such as a team Google Doc connected through Drive. Keep `menu.csv` for tabular review; it is not automatically uploaded or indexed by this repository.
4. Wait for the source to be indexed. Ask for a dish, price and exact ID, and verify the answer against the current snapshot.
5. Save/publish the agent within the organizer-approved app. Retrieve its actual agent ID. The app's display name is not its ID; agent discovery uses the `v1alpha` agents list endpoint, while invocation uses `v1` StreamAssist.

## Local authentication and configuration

Install the official Google Cloud CLI if it is not already installed. Authenticate using the account with organizer access:

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Set these values in the private `.env` file:

```dotenv
AI_PROVIDER=enterprise
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
ENTERPRISE_APP_ID=YOUR_APP_ID
ENTERPRISE_AGENT_ID=YOUR_AGENT_ID
ENTERPRISE_LOCATION=global
```

The adapter sends OAuth credentials and the quota-project header from the server. It does not put tokens into the browser or use a Developer API key in Enterprise mode. Supported locations are `global`, `us` and `eu`; choose the location of the actual app.

Run `npm run doctor`, restart the server, and complete the live checks below. Passing doctor only confirms configuration/authentication, not agent behavior.

## Live acceptance checks

- In the website, run **Find my lunch** (RM10, Not spicy, Main dish + drink). The response of `POST /api/lunch` must report `source: enterprise` and the banner must say "Gemini Enterprise agent". `warning: ai_rejected` means the agent answered but broke the format (wrong ID or total): fix the instructions, do not relax the checks.
- Ask `I have RM10, something not spicy`. At least one answer with suitable results must report `source: enterprise`; a local fallback does not prove connection.
- Open a dish and press **Ask about this dish**: the answer must be about that dish (`dishIds` empty or exactly its ID).
- Ask `I am allergic to gluten`. Verify exact item IDs, absence of listed gluten and the vendor-confirmation note.
- Ask `vegan lunch`. With the current dataset the website correctly returns no confirmed vegan options; this rules-only answer does not call the agent.
- In Enterprise itself, ask about a known item and inspect its connected source citation. Record this native-agent view for the demo.
- Change a reviewed test price in the team menu source, synchronize it, and confirm the native agent retrieves the updated value. Rebuild the website snapshot so both sources agree.
- Remove a required ID temporarily in a test configuration; startup should reject incomplete Enterprise settings. With valid IDs but unavailable service, the website should visibly label local fallback.

Keep screenshots and timestamps of real successful calls. Do not label mocked tests or fallback answers as a working Enterprise integration.

## Menu-maintenance extension

The local exporter detects changed IDs and prepares a review report. A future Enterprise workflow can compare old/new team documents and draft vendor review tasks. That workflow has not been built or connected here. The website's agent path is read-only; do not present a local export command as an automated Enterprise workflow.
