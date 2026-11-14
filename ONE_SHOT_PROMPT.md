# One-shot prompt: set up this exact app

Copy the paragraph below into Codex or another coding assistant on the recipient's computer. It installs this repository's implementation, including its existing interface and classification rules.

```text
Set up Jev Inbox on my computer. If I have supplied its ZIP or extracted folder, use that local copy. Otherwise get the v1.0.0 release from https://github.com/honeyychawla/jev-inbox. Read README.md and FIRST_RUN.md, download or clone a clean copy into a new project folder, and check that a supported Node.js LTS version is installed. Keep everything hosted locally at http://localhost:5184; do not deploy a website or create a public tunnel. Use the existing app rather than rewriting it. Run its syntax checks and mocked tests, start it with the launcher for my operating system, and open the dashboard. Help me complete the first-run checklist using my own Google Cloud project and OAuth web client, my own Gmail account, and my own OpenRouter API key. The Google callback must be http://localhost:5184/auth/google/callback, unless I explicitly choose another port. Guide me through the included Google setup instructions; let me handle sign-in, Google consent, and any security confirmations. Have me enter secrets directly in the dashboard, never in this chat, source code, Git, or screenshots. Do not copy another person's data folder, credentials, emails, or configuration database. Let me explore the fictional samples first; when my connections are ready, help me run an initial batch of 50 inbox emails from the last 30 days. Explain Scan & run Jev versus Recheck saved labels, the Time (sec) column, and the scanned/classified counts. Do not send any emails or YouTube replies as part of setup. Finish with the local dashboard URL and the exact launcher I should use next time.
```

For a prompt to create a similar app from scratch, see [BUILD_PROMPT.md](BUILD_PROMPT.md).

