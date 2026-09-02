/**
 * THE FOUR SHELVES a topic file can sit on, and the ONE module that owns the list.
 *
 * It has NO IMPORTS AT ALL, and that is the whole reason it exists as its own file. The
 * memory page is a client component and needs the tuple as a VALUE — to render the headings
 * in order and to make a fifth section a compile error rather than a heading reading
 * `settings.memory.section.thing`. Taking it from `memory-page.ts` did exactly what
 * importing a server module into a client bundle always does: that module imports the
 * database, so Turbopack pulled `pg` into the browser and the page died on
 * `Can't resolve 'dns'`. A TYPE from a server module is erased and costs nothing; a value
 * drags the module's whole import graph with it.
 *
 * FOUR COPIES OF THE LIST EXIST AND THREE OF THEM DERIVE FROM THIS ONE: `vault_notes.section`'s
 * column enum and its CHECK constraint (the database's answer), `memory_note_write`'s zod
 * enum (the provider's), and `NoteSection` on the two note writers. The column's literals
 * are written out in `schema.ts` rather than imported — that file is read by `drizzle-kit`
 * outside Next's module resolution, and a path alias in it is a generator that stops
 * working — but the sets are still pinned to each other by `tsc`: a `NoteSection` is passed
 * into the column's insert type, so a value here that the column does not accept fails to
 * compile.
 *
 * The ORDER is the order a person reads them in, and it is not alphabetical in either
 * locale: what the assistant knows about YOU comes before subjects, subjects before areas of
 * life, and people last because a person is looked up by name rather than skimmed.
 */
export const TOPIC_SECTIONS = ["you", "topic", "area", "person"] as const;

export type TopicSection = (typeof TOPIC_SECTIONS)[number];
