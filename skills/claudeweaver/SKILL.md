---
name: ticket-board
description: Local kanban board over Markdown ticket files, plus a dev-mode overlay where the human Shift-clicks the running app to drop a sticky note that becomes a ticket. Use when setting up the board in a project, when wiring the overlay into a dev server, or when watching the board to work tickets as the human files them.
---

# Ticket board

Tickets are Markdown files with YAML frontmatter in a `tickets/` folder, one
per ticket, committed to git. The board is one Go program (standard library
only) in this skill's folder. It serves a kanban page, a JSON API and the
overlay script `devnotes.js`. It listens on loopback only and has no auth.

`<skill-dir>` below means the folder this file is in.

## Run the board

Needs Go 1.22 or later. From the project root:

```sh
go build -C <skill-dir> -o "$PWD/.ticket-board" .   # add .ticket-board to .gitignore
mkdir -p tickets
./.ticket-board -addr :8090 -dir tickets 2>&1 | tee -a .ticket-board.log
```

Flags: `-addr` (default `:8090`, any free port works), `-dir` (default
`tickets`), `-areas` (default `web,server,docs,infra`, a comma list; the
first one is the default for new tickets). Open `http://localhost:<port>`.

The same binary is a CLI. All commands take `--dir` and `--areas`:

```sh
./.ticket-board ls --status todo
./.ticket-board show 1003
./.ticket-board new --title "..." --type bug --area web --body - < notes.md
./.ticket-board mv 1003 doing
./.ticket-board note 1003 "picked this up" --by agent
```

You can also edit ticket files directly. Writes keep unknown fields and the body.

## Add the overlay (dev only)

Load `http://localhost:<port>/devnotes.js` in dev builds only, never in
production. Optional `data-area="web"` sets the area of new notes.

Vite (`vite.config.ts`):

```ts
plugins: [{
  name: "devnotes",
  apply: "serve", // dev server only
  transformIndexHtml: () => [{ tag: "script", injectTo: "body",
    attrs: { src: "http://localhost:8090/devnotes.js", async: true, onerror: "this.remove()" } }],
}]
```

Plain HTML: add the tag by hand to a dev-only page, or strip it in the build.

```html
<script src="http://localhost:8090/devnotes.js" async onerror="this.remove()"></script>
```

Server template (Go `html/template` shown; do the same in any engine):

```html
{{if .Dev}}<script src="http://localhost:8090/devnotes.js" async onerror="this.remove()"></script>{{end}}
```

The page must be served from `http://localhost`, `http://127.0.0.1` or
`http://*.localhost`; the API refuses other origins.

In the page, the human Shift-clicks an element, types, and presses Enter. The
ticket lands in `inbox` with the URL, CSS selector, element text, viewport and
an optional screenshot (under `tickets/assets/`). Pins mark open notes; the
corner button hides them. Shift+D hides the whole overlay.

## Ticket format

File `tickets/<id>-<slug>.md`. Tool-made ids start at 1000.

```markdown
---
id: 1007
title: Save button overlaps footer
type: bug          # bug | feature | chore
status: inbox      # inbox | todo | doing | review | done | wontfix
priority: p2       # p1 | p2 | p3
area: web          # one of -areas
source: devnote    # devnote | human | agent
url: http://localhost:5173/settings   # devnote fields: url, selector, element_text, viewport, screenshot
---

What the human wrote.

## Notes

Append what you learn. Do not rewrite.
```

## Watch loop for agents

Every change made through the HTTP API prints one line to stdout, such as
`EVENT created #1012 bug web p2 "Title"` or `EVENT updated #1012 status=todo`.
CLI writes and file edits print nothing.

1. Start the board with output tee'd to a log, as above.
2. Watch the log in the background (for example with a Monitor tool), and
   re-arm the watch every 30 minutes:
   `tail -n 0 -F .ticket-board.log | grep --line-buffered -E 'EVENT|panic|fatal|address already in use|exit status'`
3. On each wake-up, and after any board restart, also list the folder for
   work, because events are lost while the board is down:
   `./.ticket-board ls --status inbox,todo`
4. For each ticket:
   - Set `status: doing` when you start. Add your name in `## Notes`.
   - Do the work. Commit as you go.
   - Set `status: review` when you finish, with a short note on what changed.
   - Never set `done` or `wontfix`. Only the human closes tickets.
5. If you find work you will not do now, file a ticket instead of a TODO comment.
