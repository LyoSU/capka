# Product

## Register

product

## Users

Non-technical office staff inside a company — people whose job is not software.
They open Capka to get a work task done with AI (draft a document, analyze a
spreadsheet, answer a question against company files), not to configure models or
think about providers. A single **admin** sets up one shared provider key and the
available models once; everyone else just picks a chat and works. The admin is the
only technical persona, and only during setup and connection management.

Context of use: a normal workday, on a company laptop, often alongside other work.
Calm focus, short sessions, low tolerance for jargon or things that look broken.

## Product Purpose

Capka is a self-hosted, extensible AI work platform a company runs itself. It gives
non-technical staff a safe, shared way to use frontier AI on real work — chat with
file attachments, a per-project workspace, and the same assistant reachable from
Telegram — without each person needing their own API key or any setup knowledge.

Success looks like: a staff member finishes a real task on the first try without
asking IT what a "provider" or "model" is; an admin connects a key once and never
has to babysit it; nothing on screen reads as a developer tool.

## Brand Personality

Calm and trustworthy. Quiet, sure of itself, never loud. Three words: **calm,
trustworthy, unobtrusive.** The interface should lower the barrier to AI for someone
who is slightly wary of it — clarity matters more than flair, and honesty (including
friendly, role-aware error messages) matters more than polish-for-its-own-sake. It
speaks plainly: no jargon to the user, no blame, no shouting.

## Anti-references

- **Generic SaaS slop** — purple gradients, gradient text, card-grids everywhere,
  hero-metric templates, tiny uppercase tracked eyebrows over every section. The
  "an AI obviously made this" look.
- **Developer-tool aesthetic** — terminal/hacker vibes, extreme density, mono
  everywhere, exposed provider/model jargon. It alienates the non-technical user.
- **Corporate heaviness** — navy-and-gray enterprise boredom, overloaded forms,
  bureaucratic copy.

## Design Principles

1. **Clarity over cleverness.** Every screen should be obvious to someone who has
   never used a dev tool. If a label needs explaining, the label is wrong.
2. **Hide the machinery.** Providers, model ids, keys, sandboxes are an admin
   concern. The user sees a friendly picker and a chat, never plumbing.
3. **Calm confidence.** Restful surfaces, generous spacing, one quiet accent. The
   product should feel settled, not eager.
4. **Honest, role-aware feedback.** Errors and empty states tell the truth in human
   words, and tell the right person (user vs admin) what to do next — never a stack
   trace, never blame.
5. **Accessible by default.** Readable contrast and full keyboard/motion support are
   table stakes for a broad non-technical audience, not an afterthought.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**. Body text ≥ 4.5:1 contrast, large text ≥ 3:1, visible focus
states, full keyboard operability. Honor `prefers-reduced-motion` on every animation
(crossfade or instant fallback). Assume a wide, non-technical, mixed-ability audience.
