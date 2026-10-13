// The online play server (server/worker.js on Cloudflare). The deploy workflow
// fills this in with the Worker's address for each channel (dev / stable).
// Empty means online play isn't available in this copy of the game; for local
// testing, ?server=http://localhost:8787 points the game at `wrangler dev`.
export const SERVER_URL = ''; // set at deploy time
