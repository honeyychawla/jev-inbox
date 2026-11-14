# Connect your own Gmail

Google requires a one-time OAuth application setup for this local web app. You own the Google project, OAuth credentials, and mailbox. No credentials from another installation are needed.

Keep Jev Inbox running at http://localhost:5184 while you do these steps. In the dashboard, open **Settings → Connections → Google app setup**.

## 1. Create a Google Cloud project

Open [Google Cloud Console](https://console.cloud.google.com/projectcreate), sign in with your own Google account, and create a project such as **My Jev Inbox**. Select that project in the top project picker.

## 2. Enable the Gmail API

Open [Gmail API in the API Library](https://console.cloud.google.com/apis/library/gmail.googleapis.com) for that project and click **Enable**.

YouTube is optional. Enable [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) only if you want to connect a channel.

## 3. Configure Google Auth Platform

In **Google Auth Platform → Branding**, choose **Get started** if this is a new project. Enter an app name such as My Jev Inbox and your own support/contact email. Review Google's required terms yourself.

For a personal Gmail account, choose **External** audience and keep the app in **Testing**. In **Audience → Test users**, add the exact Google account you will connect. You do not need to publish the app for this personal test setup.

For a Workspace account, **Internal** is available only for projects owned by your Workspace organization and only permits users in that organization. Your organization may require administrator approval. Use the audience appropriate for your own project.

Under **Data Access**, add this scope:

```text
https://www.googleapis.com/auth/gmail.modify
```

The app needs it to read Gmail and send reviewed replies. It does not delete Gmail messages or apply Gmail labels. For optional YouTube support, also add:

```text
https://www.googleapis.com/auth/youtube.force-ssl
```

## 4. Create the OAuth client

Open **Google Auth Platform → Clients → Create client**.

- **Application type:** Web application. This app runs a local web server; choose this type for the existing implementation.
- **Name:** Jev Inbox Local.
- **Authorized redirect URIs:** paste this exact address, with no trailing slash:

```text
http://localhost:5184/auth/google/callback
```

Create the client. Copy the client ID and client secret into the dashboard's Google app setup fields, then click **Save Google setup**. Never paste them into GitHub, an issue, or a shared prompt. Keep any downloaded credential JSON private.

Google may show the secret only at creation time, so save it to the local dashboard while it is available. The app stores it encrypted locally.

## 5. Sign in from the dashboard

Click **Connect Gmail**. Choose the same account you added as a test user, review the permissions, and finish Google's consent flow. Confirm that the dashboard shows the intended account as connected.

Google can show an unverified-app notice for an external app in testing. Verify that it is your own project and account, and make that trust decision yourself. Do not bypass a browser certificate or connection-security error.

Next add your own OpenRouter key in Settings. Start with a 50-email batch.

## If something goes wrong

| Google message | Check |
|---|---|
| `redirect_uri_mismatch` | Client type is Web application; callback matches the dashboard exactly, including `http`, `localhost`, port, and path. |
| `access_denied` / not a test user | The chosen account is listed under Audience → Test users for the correct project. |
| Organization-only access | An Internal app cannot be used by an account outside its Workspace organization. Use an appropriate project/audience. |
| API disabled | Gmail API is enabled in the same project as the OAuth client. |
| Connection expired | Reconnect through Settings. Google can expire tokens or revoke access. |
| Reconnection needed after a week | External apps in Testing generally receive refresh tokens that expire after seven days for these Gmail scopes. Reconnect when prompted. |
| Admin policy blocks access | Ask your Workspace administrator to allow the app; changing the dashboard cannot override organization policy. |

Google documentation: [OAuth web-server setup](https://developers.google.com/identity/protocols/oauth2/web-server), [consent screen and test users](https://developers.google.com/workspace/guides/configure-oauth-consent), [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

