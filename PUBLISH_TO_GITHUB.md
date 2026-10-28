# Publish this project to GitHub

The project source is ready to publish. Publishing directly requires an authenticated GitHub account with permission to create a repository.

## Option A — GitHub web UI

1. Create a new repository named `oxide-centralized-bot-monitor` on GitHub. Do not initialize it with a README, license, or `.gitignore` because this project already contains these files.
2. Extract the project ZIP and open a terminal in the extracted project folder.
3. Run the commands below, replacing `<your-username>` with your GitHub username.

## Option B — Git CLI

```bash
git init -b main
git add .
git commit -m "Build centralized Oxide bot monitoring and order tracking"
git remote add origin https://github.com/<your-username>/oxide-centralized-bot-monitor.git
git push -u origin main
```

Check `.gitignore` before committing. Do not commit `.env`, live credentials, or real deployment packages. The supplied simulator and seeded orders are synthetic.

## After publishing

- Open the repository's **Actions** tab and confirm the `test` workflow passes.
- To run the full API integration test, first start the Docker Compose stack, then set `TEST_BASE_URL=http://localhost:3000` when running `npm test`.
- The deployment endpoint currently **stages** ZIP packages and simulates a rollout by restarting simulator nodes; the supplied simulator has no real package-install API.
