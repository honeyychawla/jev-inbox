# First run

## 1. Start the dashboard

Install the LTS installer for your computer from https://nodejs.org/en/download. Download the ZIP from Drive or GitHub and extract it completely before launching it. You do not run the app inside Drive.

- **Mac:** double-click `Start Jev Inbox.command`.
- **Windows:** double-click `Start Jev Inbox.cmd`.
- **Linux:** open a terminal in the folder and run `sh start.sh`.
- **Terminal on any OS:** run `npm start` in the folder containing `package.json`.

Open http://localhost:5184. Keep the terminal open. You can browse the fictional samples immediately. No package installation command is required.

## 2. Complete the three setup steps

Use **Make this inbox yours** at the top of the dashboard.

1. Create your own Google OAuth web client using [the Google setup guide](docs/google-setup.md). Save its client ID and secret in the dashboard.
2. Click **Connect Gmail**. Google handles your login and consent. Pick the mailbox you intend to manage.
3. Click **Add OpenRouter key**, paste a key from https://openrouter.ai/settings/keys, and choose **Save & test connection**. Testing uses a short fictional message and a small amount of your OpenRouter credits.

Use your own credentials. No shared account or previous user's setup is bundled.

## 3. Run your first batch

Switch from **Sample data** to **My inbox** if necessary. Start with 50 emails and Last 30 days, then click **Scan & run Jev**. The default query includes inbox mail only.

Watch Emails scanned, Emails classified, Failed, and the timers. Labels with an exclamation mark need review. Correct a category in the reading view; your correction is preserved on later automatic runs.

Use **Recheck saved labels** to classify already imported emails without another Gmail download. Use **Stop run** to stop after current requests finish. Replies are only sent after you explicitly review and confirm them.

## Common launch issues

| Message or symptom | What to do |
|---|---|
| `node` or `npm` is not recognized | Install Node.js LTS, then reopen the terminal or launcher. |
| Unsupported Node version / missing `node:sqlite` | Update Node.js to LTS. The minimum is 22.13. |
| Mac launcher does not open | In Terminal, change to the extracted project folder and run `npm start`. |
| Port 5184 is already in use | Check http://localhost:5184; another copy may already be running. Stop that copy before starting another. |
| Browser cannot connect | Keep the launcher terminal open and check it for an error. Use `localhost`, not a shared network address. |
| Blank inbox | Switch to My inbox, connect Gmail, and scan. Check whether your Gmail search matches any emails. |
| OpenRouter needs credits | Add credits to your own OpenRouter account and try the connection test again. |
| Labels show Unsorted | These messages have not been classified yet. Add an OpenRouter key, resume Jev if paused, and run it. |

If you deliberately use another port, set the `PORT` environment variable and register the matching Google callback URL shown in Settings. Start with the default port unless you need to change it.

