# v0.3.0 Smoke Test

Prerequisites:
- SEAL v0.3.0 installed (`npm install` in repo root and in `dashboard/`)
- The daemon (`npm start`) and dashboard (`cd dashboard && npm start`) both running
- A test repo at `~/projects/seal-test` (git-initialized)

## Steps

1. Open `http://localhost:3333` → click the **Workspaces** sidebar item.
2. Enter `~/projects` as the parent folder and click **Scan**.
3. Check the `seal-test` row and click **Watch selected**. Expected: row appears in the watched list with hook status "installed".
4. In the test repo:
   ```
   cd ~/projects/seal-test
   git checkout -b test/v0.3.0-smoke
   git commit --allow-empty -m "smoke test commit"
   ```
5. Click the **Events** sidebar item. Expected: within 5 seconds, two events appear:
   - `git.branch.created` (kind=`git.branch.created`, data.name=`test/v0.3.0-smoke`)
   - `git.commit` (kind=`git.commit`, data.message=`smoke test commit`)
6. Return to **Workspaces** and click **Remove** on the `seal-test` row. Expected: row disappears, and `cat ~/projects/seal-test/.git/hooks/post-commit` shows either the original content (if a backup existed) or the file is gone.

## Offline drain test

1. Stop the daemon (`Ctrl-C` in the seal terminal).
2. In `~/projects/seal-test`, run `git commit --allow-empty -m "offline commit"`. The hook will fail to POST and fall back to writing to `~/.config/seal/ipc/git/queue.jsonl`.
3. Verify the queue file contains one line: `cat ~/.config/seal/ipc/git/queue.jsonl`.
4. Restart the daemon (`npm start`). Expected: startup log shows drain completion, and the Events tab shows the `git.commit` for "offline commit".

## Retention test

1. Insert an old event manually:
   ```
   sqlite3 ~/.config/seal/tasks.db "INSERT INTO events (source, kind, timestamp, data) VALUES ('test', 'test.old', datetime('now', '-91 days'), '{}')"
   ```
2. Trigger retention by waiting for the daily cron OR restart the daemon and wait 60 seconds.
3. Verify: `sqlite3 ~/.config/seal/tasks.db "SELECT * FROM events WHERE kind='test.old'"` returns no rows.
