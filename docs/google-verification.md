# Google OAuth verification for Khaos

**Answer:** Prepare a public homepage and accurate privacy disclosures, publish the OAuth branding, then submit the `https://www.googleapis.com/auth/youtube.readonly` scope with a justification and an unlisted demonstration video. The invite-only friend pilot may qualify for Google's personal-use exception; verification is the route for removing the warning for a wider launch. OAuth verification is separate from a YouTube API quota-extension audit. [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) and [YouTube quota audits](https://developers.google.com/youtube/data/guides/quota_and_compliance_audits), checked 2026-11-02.

## What is known and what is missing

| Item | Status |
|---|---|
| Cloud project | `content-hoarder`; pilot notes say **In production, unverified**. This is not a live Console check. |
| Hosted app | [demo.khaosapp.tech](https://demo.khaosapp.tech) is documented as invite-only. A public, descriptive homepage separate from the invite-only experience is needed unless an existing page already meets Google's requirements; none is documented. A login-only page is not sufficient. |
| Privacy | [demo.khaosapp.tech/privacy](https://demo.khaosapp.tech/privacy) exists in the app source. Public accessibility and the Console URL have not been independently checked. |
| Domain and branding | Search Console ownership, authorized domains, Console name/logo, homepage and branding status are **unverified**. Check them in the relevant consoles. |
| Demo | A successful import with real playlist data is not documented. Record the actual deployed flow using a suitable account and playlist; do not submit a mock. |
| YouTube policy | The current privacy text does not identify YouTube API Services, link Google's privacy policy, or explain Google permission revocation. Terms/consent, retention, refresh and deletion compliance are **unverified** and need review, not a claim of compliance. |

Project and deployment facts come from [FRIEND-PILOT.md](FRIEND-PILOT.md); privacy wording comes from [`auth.ts`](../src/web/handlers/auth.ts). The intended separate connection flow is being implemented; confirm it is deployed before using the drafts below.

## Before submitting

- [ ] In Search Console, verify ownership of every authorized top-private domain, including `khaosapp.tech` if used. The verified domain owner must also be a project Owner or Editor. Add the domains covering homepage, policy, redirect URIs and JavaScript origins to OAuth Branding's authorized domains. [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), checked 2026-11-02.
- [ ] Publish a homepage on the verified domain. It must be accessible without signing in, clearly identify Khaos, describe what it does, and link directly to the same privacy policy URL used on the consent screen. An invite-only product can have a public information page. The privacy policy must be publicly visible and hosted on the same domain as the homepage. [Homepage and privacy requirements](https://support.google.com/cloud/answer/13464321?hl=en), checked 2026-11-02.
- [ ] Make the consent-screen app name, any logo, homepage and actual app identify the same product. Check Google Sign-In and YouTube branding requirements. Set a working support email and developer contact. [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification) and [verification requirements](https://support.google.com/cloud/answer/13464321?hl=en), checked 2026-11-02.
- [ ] Update the privacy policy to match actual access, use, storage, sharing and deletion, including any optional AI processing and pilot analytics. Ensure the same policy is linked on the homepage and consent screen. Do not promise privacy or deletion behavior that has not been implemented. [Verification requirements](https://support.google.com/cloud/answer/13464321?hl=en), checked 2026-11-02.
- [ ] Review the [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service) and [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), checked 2026-11-02. They apply to YouTube API clients even when access is read-only. In particular, provide terms linking to YouTube's terms and stating that users agree to them; require agreement to the privacy policy before access; disclose YouTube API use, link Google's privacy policy, explain revocation and provide a privacy contact. Review the data storage, refresh, deletion and revocation rules against the implementation. Do not assume the current pilot complies.
- [ ] Check actual YouTube data lifecycle against the policies before submitting: provide an in-app revocation method, revoke authorization when requested, and delete applicable authorized data within seven calendar days after in-app revocation or a deletion request. Check the distinct rules for revocation through Google, including periodic authorization checks and deletion within 30 days. Stored authorized data other than statistics generally must be deleted or refreshed after 30 days; statistics have separate revalidation rules. These are implementation requirements, not just wording changes. Applicability and compliance in Khaos are **unverified**. [Developer Policies, sections III.D.2 and III.E.4](https://developers.google.com/youtube/terms/developer-policies), checked 2026-11-02.
- [ ] Confirm the deployed app requests only scopes it needs, and declare all actual scopes in the Cloud Console Data Access page. Confirm that `youtube.readonly` is classified as sensitive there. Prepare the justification and video below. [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), checked 2026-11-02.
- [ ] Arrange a way for the reviewer to reach and use the invite-only app if Google asks. Keep a working invite or test account ready; never put credentials or secrets in the video. Google's YouTube policies require providing access accounts on request for an audit. [Developer Policies, monitoring and audits](https://developers.google.com/youtube/terms/developer-policies), checked 2026-11-02.

## Ready-to-paste homepage text

Use on the public homepage, with a real link to the policy. Confirm the deployed behavior first.

> **Khaos** helps you bring saved links together and make deliberate choices about what to keep, archive or mark done. You can add links and connect YouTube to choose playlists to import. Connecting YouTube is optional and read-only; Khaos does not change your YouTube playlists. The hosted pilot is invite-only.
>
> [Privacy policy](https://demo.khaosapp.tech/privacy)

## Ready-to-paste scope justification

Paste for `https://www.googleapis.com/auth/youtube.readonly` after confirming the flow and data handling in the deployed build:

> Khaos is a saved-content organizer. After signing in, a user can optionally choose Connect YouTube on the Add page. With their permission, Khaos lists their YouTube playlists so they can choose which ones to import. It reads items from the selected playlists and adds them to the user's Khaos library, where they can review and organize them. Signing in alone does not import playlists. Khaos does not modify the user's YouTube account or playlists.
>
> We request `https://www.googleapis.com/auth/youtube.readonly` because listing the signed-in user's playlists and reading accessible selected playlist items requires access to their YouTube data. Basic sign-in scopes do not provide that access. We use a read-only scope instead of a broader write scope; without it, the playlist choice and import feature cannot work for the user's non-public playlists. The user can use other import methods without connecting YouTube.

The `mine` filter requires authorization, and the API supports reading playlist items; see [playlists.list](https://developers.google.com/youtube/v3/docs/playlists/list) and [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list), checked 2026-11-02. Do not claim the scope can import Watch Later: the API says it cannot.

## Demonstration video shot list

Google requires an end-to-end English demonstration of the actual submitted app, its OAuth grant and the functionality enabled by each requested sensitive scope. Upload it to YouTube Studio as **Unlisted** and submit its link. Show the complete consent screen, the exact scopes requested, the app name, and the browser address bar containing the OAuth client ID. [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) and [verification requirements](https://support.google.com/cloud/answer/13464321?hl=en), checked 2026-11-02.

1. Open the real hosted app with a permitted test user. Show the public homepage and privacy link, then the Google sign-in flow and landing page.
2. On Add, select **Connect YouTube**. Show the Google consent screen in English, the complete permission text and matching Khaos name. Keep the address bar visible and readable with the actual OAuth `client_id`; do not expose tokens, secrets or private account information.
3. Grant the YouTube permission. Show the return to the playlist checklist, choose a real playlist and import it.
4. Show the imported YouTube items in the Khaos library and demonstrate the review/triage use that the permission enables. Make clear that this does not edit the source playlist.
5. If other sensitive scopes are declared, demonstrate each one's complete consent and in-app use too. Review the recording for accidental disclosure before uploading.

## Submit and follow up

1. In [Google Auth Platform Branding](https://console.cloud.google.com/auth/branding), select the correct project. Fill in and verify the branding, fix any findings, then publish it. Published branding is a prerequisite for requesting data-access verification.
2. In Data Access / Verification Center, declare the scopes actually requested and submit the sensitive-scope request with the justification, unlisted video link and any requested documentation. The Console may ask follow-up questions.
3. Monitor Verification Center and the project contact/support inbox. Reply to Trust & Safety questions and provide reviewer access if requested.

Google says automated branding usually takes minutes; manual branding review usually takes **2–3 business days**. Its developer guide says sensitive-scope verification typically takes **3–5 business days**, while its Help Center FAQ gives **10 business days**. Plan for the longer estimate. None is guaranteed; follow-up or an incomplete submission can extend the process. [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), and [verification FAQ](https://support.google.com/cloud/answer/13463817?hl=en), checked 2026-11-02.

## Limits and the separate YouTube audit

- For apps that show the unverified-app screen, Google lists a **100 new users total** cap after the screen is presented, subject to app-specific adjustments. Its FAQ says the cap applies over the project's lifetime and cannot be reset. It is not a daily allowance. A basic sign-in request and the later sensitive-scope request can have different warning behavior; verify the deployed flow. [Unverified apps and OAuth user quotas](https://support.google.com/cloud/answer/7454865) and [verification FAQ](https://support.google.com/cloud/answer/13463817?hl=en), checked 2026-11-02.
- OAuth verification approves the app's identity and requested data access; it does **not** itself extend YouTube Data API quota. YouTube says a quota increase beyond the default requires an API compliance audit and the [Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form). It may also conduct periodic audits. The documented default includes 10,000 units per day for endpoints other than the separately allocated search and upload calls; inspect the project's actual quota and usage. An extension is not inherently required just to submit OAuth verification. [Quota and compliance audits](https://developers.google.com/youtube/data/guides/quota_and_compliance_audits), checked 2026-11-02.
