# MongoDB Atlas setup for Outfitter (manual, one time)

These are your steps; they need your Atlas and Google Workspace admin logins. Budget about 30
minutes. The decisions behind them are in `../EPIC.md` ("Decisions taken"): free M0 cluster in GCP
us-central1, SCRAM user with the password in Secret Manager, Google Workspace SAML for the Atlas
org, Marketplace billing deferred until we leave M0.

## 1. Organization and project

1. Sign in at https://cloud.mongodb.com with mgm@mgms.eu (or create the account with it; do not
   use the Augment work account).
2. If you do not already have a personal organization, create one named `mgmonteleone`. Note the
   **Organization ID** (Organization Settings).
3. Create a project named `outfitter` in that organization.

## 2. Cluster

1. In the `outfitter` project choose **Create** > **M0 (Free)**.
2. Provider **Google Cloud**, region **Iowa (us-central1)**. Same region as Cloud Run; cross-region
   adds latency to every transcript write.
3. Name it `outfitter`. Leave the defaults. Create.

## 3. Database user

1. **Database Access** > **Add New Database User**.
2. Authentication method **Password**, username `outfitter-api`. Click **Autogenerate Secure
   Password** and copy it somewhere temporary.
3. Built-in role **Read and write to any database** (we will narrow this to the `outfitter`
   database once the collections exist). Restrict access to the `outfitter` cluster.
4. Save.

## 4. Network access

M0 has no private endpoints, so the cluster has to accept connections from Cloud Run's egress
addresses, which are not fixed. For now:

1. **Network Access** > **Add IP Address** > **Allow access from anywhere** (`0.0.0.0/0`).
   The SCRAM password is the only thing protecting the cluster, which is why it lives in Secret
   Manager and nowhere else.
2. When we move to M10 (E7), replace this with an Atlas private endpoint and OIDC workload
   identity, and delete this entry.

## 5. Connection string into Secret Manager

1. **Connect** on the cluster > **Drivers** > Node.js. Copy the `mongodb+srv://...` string.
2. Replace `<db_password>` with the password from step 3 and append the database name and app
   name, so it looks like:
   `mongodb+srv://outfitter-api:<password>@outfitter.xxxxx.mongodb.net/outfitter?retryWrites=true&w=majority&appName=outfitter`
3. Store it (from this repo's `outfitter/deploy` directory; `printf` avoids a trailing newline,
   and reading from a prompt keeps it out of shell history):

```bash
read -rs MONGODB_URI && printf '%s' "$MONGODB_URI" | gcloud secrets create outfitter-mongodb-uri --project=outfitter-509211 --replication-policy=automatic --data-file=- && unset MONGODB_URI
```

4. Check it from the API package: `MONGODB_URI="$(gcloud secrets versions access latest --secret=outfitter-mongodb-uri --project=outfitter-509211)" npm run dev` in `packages/api` should log a successful store connection.

## 6. Google Workspace SAML login for the Atlas org

Free at any tier; needs Organization Owner in Atlas and super-admin in the Workspace admin console.

0. Workspace first: the org-level Google SAML signing certificate lasts five years and this org
   dates from 2018, so it has expired. Admin console > **Security** > **Authentication** > **SSO with
   Google as SAML IdP** > **Manage certificates** > **Add certificate**. Do this before creating the
   app, otherwise the app shows the expired certificate.
1. Atlas: **Organization** > **Settings** > **Federated Authentication Settings** > **Manage
   Federation Settings** > **Identity Providers** > **Configure Identity Provider** > **SAML**, name
   it `Google Workspace`. The next screen shows Atlas's **Assertion Consumer Service URL**
   (`https://auth.mongodb.com/sso/saml2/<id>`) and **Audience URI**
   (`https://www.okta.com/saml2/service-provider/<id>`; Atlas's SAML broker runs on Okta, so this is
   expected). Copy both; if Atlas will not save the provider before the Google fields are filled,
   do step 2 to 3 first and come back. Both values are also visible later under the provider's
   details.
2. Workspace admin (https://admin.google.com): **Apps** > **Web and mobile apps** > **Add app** >
   **Add custom SAML app**. Name it `MongoDB Atlas`. On the Google Identity Provider details page
   copy the **SSO URL**, **Entity ID**, and download the **Certificate**.
3. Service provider details: paste Atlas's ACS URL and Audience URI; Name ID format
   `EMAIL`, Name ID = Basic Information > Primary email. Attribute mapping: `firstName` from
   First name, `lastName` from Last name, `memberOf` can be left unmapped.
4. Back in Atlas fill in the Google SSO URL, Issuer URI (Google's Entity ID), upload the
   certificate, Request binding `HTTP-POST`, Response signature algorithm SHA-256. Save.
5. **Domains** tab: add `mgmonteleone.com` and verify it with the TXT record Atlas gives you
   (Workspace DNS or your registrar). Then **Associate domain** with the identity provider.
6. Turn the app **ON for everyone** (or for your OU) in the Workspace app page.
7. Test in a private window: go to https://cloud.mongodb.com, enter `mgm@mgmonteleone.com`;
   it should bounce through Google and land in the org. Only after that succeeds, optionally enable
   **Bypass SAML Mode** = off and **Restrict Access to Organization** in Atlas.

Note the account you use day to day is `mgm@mgms.eu`; the org's Workspace domain is
`mgmonteleone.com`. If `mgms.eu` is a secondary domain of the same Workspace, add it in step 5 as
well; otherwise log in with the primary-domain identity and keep `mgm@mgms.eu` as a fallback
Atlas-password owner so you cannot lock yourself out.

## 7. Deferred: Marketplace billing

Skip for now (M0 costs nothing). When moving to Flex or M10: GCP Marketplace > MongoDB Atlas >
Subscribe, then in Atlas **Billing** > **Link to Google Cloud**. This is an annual commitment billed
monthly on actual use, and the org must have no open invoices.

## 8. What the deploy scripts expect after this

| Secret Manager name | Value |
|---|---|
| `outfitter-mongodb-uri` | the connection string from step 5 |
| `outfitter-github-pat` | fine-grained PAT (contents and pull requests read/write on the agent repos) |
| `outfitter-litellm-admin` | a LiteLLM key allowed to create per-guru virtual keys |
| `outfitter-local-tunnel-token` | `LOCAL_TUNNEL_TOKEN` from `~/localllm/.env` |

Then run `baseline.sh`, `link.sh`, `api.sh`, `agent-job.sh` in that order (see `README.md`).
