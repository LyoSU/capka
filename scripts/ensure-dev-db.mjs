// Preflight for `npm run dev`, wired in as the npm `predev` hook.
//
// `npm run dev` is the platform-only mode and needs a reachable Postgres;
// without one the app still boots and then serves a storm of ECONNREFUSED
// 500s — a failure that looks like a broken app rather than a missing
// database. This script turns that into either a running database or one
// clear sentence.
//
// Two very different callers share this hook, and the split below is the
// whole design:
//  - a developer on the HOST (default DATABASE_URL, localhost): Docker is
//    their own machine, so the dev Postgres container is started for them —
//    the same one `npm run docker:dev` uses, same volume, same password;
//  - the dev CONTAINER (docker:dev runs `npm run dev` too, DATABASE_URL
//    points at the `postgres` service): there is no docker CLI in there and
//    compose already orchestrates startup, so a non-local host only ever
//    WAITS briefly and then yields — exiting non-zero here would turn a slow
//    database start into a crash-looping platform container.
import net from "node:net";
import { spawnSync } from "node:child_process";

const url = new URL(process.env.DATABASE_URL || "postgresql://Capka:Capka@localhost:5432/Capka");
const host = url.hostname;
const port = Number(url.port || 5432);
const local = host === "localhost" || host === "127.0.0.1" || host === "::1";

const probe = () =>
  new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1000 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (await probe()) process.exit(0);

if (!local) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await probe()) process.exit(0);
  }
  console.warn(`[dev] Postgres at ${host}:${port} is not answering yet — starting anyway; the app will keep retrying.`);
  process.exit(0);
}

console.log(`[dev] Postgres is not running on ${host}:${port} — starting the dev database container…`);
const compose = ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.build.yml", "-f", "docker-compose.dev.yml"];
const up = spawnSync("docker", [...compose, "up", "-d", "postgres"], { stdio: "inherit" });
if (up.status !== 0) {
  console.error(
    "[dev] Could not start it via Docker. Start Docker Desktop/OrbStack and retry, run the full stack with `npm run docker:dev`, or point DATABASE_URL at a database you run yourself.",
  );
  process.exit(1);
}

// A published port accepts TCP before Postgres accepts logins, so the wait asks
// the server itself, not the socket.
for (let i = 0; i < 30; i++) {
  const ready = spawnSync("docker", [...compose, "exec", "-T", "postgres", "pg_isready", "-q", "-U", "Capka"], { stdio: "ignore" });
  if (ready.status === 0) {
    console.log("[dev] Postgres is up.");
    process.exit(0);
  }
  await sleep(1000);
}
console.error("[dev] The database container started but never became ready — check `docker compose logs postgres`.");
process.exit(1);
