# Authentication & Access Policy

Wayback Reel (`https://h3manth.com/fun/wayback-to-video/`) is a public, unauthenticated archival utility and API.

- **Authentication**: None required (`NoAuth`). No API keys, OAuth tokens, or cookies are needed.
- **CORS**: All read endpoints emit `Access-Control-Allow-Origin: *`.
- **Rate Guidance**: Please limit automated `/api/snapshot` requests to `<= 3` concurrent requests per client so upstream Internet Archive (`web.archive.org`) replay servers remain healthy.
