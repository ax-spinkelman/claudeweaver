# ticket-board

An agent skill for a local feedback loop. You Shift-click your running app to
drop a sticky note. The note becomes a Markdown ticket in `tickets/`. Your
coding agent watches the board, picks up the ticket, and moves it to review.

- One Go program, standard library only. It serves a kanban board, a JSON API
  and the overlay script.
- Tickets are plain files with YAML frontmatter, committed to git.
- Loopback only, no auth. The API refuses non-local hosts and origins.

## Quick start

Install the skill into your project:

```sh
npx skills add <owner>/ticket-board
```

Or run it straight from a clone (Go 1.22 or later):

```sh
git clone <this repo> && cd ticket-board/skills/ticket-board
go build -o ticket-board .
mkdir -p ~/myapp/tickets
./ticket-board -addr :8090 -dir ~/myapp/tickets
```

Open http://localhost:8090. Then add this tag to your app's dev build only:

```html
<script src="http://localhost:8090/devnotes.js" async onerror="this.remove()"></script>
```

Shift-click any element, type a note, press Enter. It lands in the Inbox.

Ask your agent to "watch the ticket board". The skill tells it how to follow
the board's `EVENT` lines, set `doing` when it starts and `review` when it is
finished. Only you set `done`.

See [skills/ticket-board/SKILL.md](skills/ticket-board/SKILL.md) for flags,
the CLI, Vite and template examples, and the ticket format.

## Tests

```sh
cd skills/ticket-board && go vet ./... && go test -race -count=1 ./...
```

## License

MIT
