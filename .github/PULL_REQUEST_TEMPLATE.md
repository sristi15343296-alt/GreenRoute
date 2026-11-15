## What changes

<!-- One or two sentences. What behaviour changes, and why. -->

## Why

<!-- The problem this solves. Link an issue if there is one. -->

## Checks run

- [ ] Backend: `python -m unittest discover -s tests` in `backend/`
- [ ] `node --check` on any changed `backend/static/js/*.js`
- [ ] If the driver app changed: `npx tsc --noEmit` and `npx jest` in `driver-app/`
- [ ] Manual check in the browser (say what you looked at, or say you did not)

## Safety

- [ ] No credential, database file, token or real location data is included
- [ ] No existing route, status or driver response shape was renamed without saying so
- [ ] A position is still never presented as live when its health says otherwise
- [ ] A straight line is still never presented as a road route
