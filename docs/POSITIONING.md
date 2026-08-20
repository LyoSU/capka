# Positioning

The canonical wording for how Capka describes itself. Four surfaces carry it, and
they drift apart when each is edited on its own: `README.md`, `PRODUCT.md`, the app
metadata (`src/app/layout.tsx` + `public/manifest.json`), and the website (its own
repo, <https://capka.app/>). Change it here first, then push it to all four.

The website's reasoning is worked out at length in its repo, in
`docs/superpowers/specs/2026-08-15-capka-landing-positioning-design.md`. That
document is the origin of the three levels below; this file exists so the product
repo stops contradicting it.

## Three levels, and which surface each one owns

| Level | Wording | Lives in |
|---|---|---|
| Category | open-source, self-hosted AI coworker on your own server | `<title>`, metadata, README first line |
| Value | Give it the work, get the finished files | H1, README strapline |
| Difference | Every task gets its own computer | the technical section, not the top line |

Headline, product repo:

> Self-hosted AI coworker. Give it the work, get the finished files.

Short form, for `<title>`/`description`, the PWA manifest, and social cards — same
sentence, because a second variant is a fifth surface to keep in sync:

> Self-hosted AI coworker. Give it the work, get the finished files.

Website H1 (live): *Give Capka the work. Get the finished files.* — the same claim
with the product named, since the page has already introduced itself by then.

## No segment word in the top line

Not *team*, not *office*, not *enterprise*, not *personal*. This is a decision, not
an oversight, and it has been made twice: the website spec rejected `Your team's AI
coworker` because *team* in the first line cuts off the solo user, and the same
objection killed `for office work` here.

The funnel is one person's path, not three audiences: someone installs it alone,
uses it on their own work, then shows a colleague, and eventually an admin connects
a shared key for everybody. A headline that names one station on that path reads
wrong at the other two. So the top line names the category and the outcome, and the
reader places themselves.

The reason this holds is that the three pillars do not change with headcount:

1. **The result is a file.** Equally true for one freelancer and for two hundred
   people. Already how the agent is instructed to behave
   (`src/lib/agents/chat-agent.ts`: "If something can be produced, produce it").
2. **It runs on your server, isolated per task.** Solo: my data stays mine. Team:
   colleagues do not share one messy directory. Company: no files leave the
   infrastructure. One sandbox per chat or project, no host filesystem, Docker
   reached through `socket-proxy`, gVisor available for untrusted use.
3. **The work outlives the client.** Every turn is a durable queued job with a
   snapshot after each step (`src/lib/tasks/`), so a closed tab or a restart resumes
   instead of losing the reply. Solo: a closed laptop. Team: overnight. Company:
   scheduled automations with nobody present.

A position fractures when different segments need different pillars. These three
carry across all of them, which is why the segment word is the only part that has
to go.

`PRODUCT.md` is the exception, and deliberately: it is the internal design brief,
and it stays narrowly about non-technical office staff because that is what makes
UI decisions decidable ("would a lawyer understand this label?"). Narrow inside,
inclusive outside.

## What not to lead with

- **"Workspace", "sandbox", "file storage" as the headline.** Machinery. It says
  nothing about who this is for or what comes out, and it is now the shared
  vocabulary of every self-hosted agent product. Sandboxes belong in the section
  that answers "is this safe". On the website `workspace` is banned from prose
  outright; a real path like `/workspace/report.docx` is fine, because that is
  machine metadata, not a claim.
- **Counts of models, agents, and integrations.** Not a race worth entering: the
  buyer connects one shared key, they are not collecting providers.
- **"Personal AI platform."** Wrong on both words. It is shared, and the person
  using it should never see a platform.
- **Developer framing** (running CLI agents, local dev loops). See the
  anti-references in `PRODUCT.md`: it alienates the actual user.
- **Anything the product cannot do.** The website spec bans event triggers from the
  automations copy for exactly this reason: automations are scheduled work, and
  wording like "when a new file appears" advertises an engine that does not exist.
