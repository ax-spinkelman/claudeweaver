# claudeweaver

Claudeweaver is like Dreamweaver, but with Claude. You point at your running app and say what is wrong. Your coding agent reads the note, does the work and shows you the result for review.

It is an agent skill with three parts:

- A ticket board. It is a kanban page for Markdown ticket files in your repo.
- An overlay for your app in dev mode. You Shift-click (or tap) any element to drop a sticky note. The note becomes a ticket.
- Instructions for the agent. They tell it how to watch the board, how to write tickets and when to move them.

![The board with tickets in Inbox, To do, Doing, Review and Done](docs/board.png)

![A sticky note on the page heading, with pins on three other elements](docs/overlay-note.png)

![The card for a pinned ticket that is in progress](docs/overlay-pins.png)

## Install

```sh
npx skills add statico/claudeweaver
```

Then ask your agent to "set up claudeweaver and watch the board". The skill tells the agent how to build the board, add the overlay to your dev server and follow new tickets.

You can also run it from a clone. You need Go 1.22 or later.

```sh
git clone https://github.com/statico/claudeweaver && cd claudeweaver/skills/claudeweaver
go build -o claudeweaver .
mkdir -p ~/myapp/tickets
./claudeweaver -addr :8090 -dir ~/myapp/tickets
```

Open http://localhost:8090. Then add this tag to the dev build of your app only:

```html
<script src="http://localhost:8090/devnotes.js" async onerror="this.remove()"></script>
```

## How it works

### Tickets are Markdown files

Each ticket is one file, for example `tickets/1007-save-button-overlaps-footer.md`. The file has YAML frontmatter (id, title, type, status, priority, area, source) and a Markdown body. You commit the tickets to git with your code. You, the agent and the board all edit the same files. A write by the board changes only the lines it needs and keeps everything else.

A ticket moves through these statuses: `inbox`, `todo`, `doing`, `review`, and then `done` or `wontfix`. The agent sets `doing` when it starts and `review` when it finishes. Only you set `done`.

### The board

The board is one Go program that uses only the standard library. It has no database. The ticket files are the data. The program serves the kanban page, a JSON API and the overlay script. The same binary is also a CLI (`ls`, `show`, `new`, `mv`, `note`).

On the board, N opens quick add, J and K move between cards, and keys 1 to 5 move a card to a column. You can paste a screenshot into quick add or into the ticket panel. The icon of the Doing column turns, so you can see that work is in progress.

### The overlay

The overlay is one script, `devnotes.js`. It runs in a shadow root, so it does not change the styles of your page.

- Shift-click any element, type the note and press Enter. The ticket stores the URL, a CSS selector, the element text and the viewport.
- On a phone or tablet, open the small tab on the right edge, choose "Drop a note" and tap the element.
- Pins mark the open tickets on the page. Each pin shows the status with a color and an icon. The icon of a `doing` ticket turns. If you set "reduce motion" in your system, the icon does not turn.
- Click a pin to read the ticket, change its status or add a note.
- Paste or drop an image into a note to attach it. You can also turn on screenshots in the menu.
- Shift+D hides the whole overlay.

To use the overlay on a phone, serve your app and the board with `tailscale serve`, and start the board with `-tailnet-host <name>.ts.net`. SKILL.md has the steps.

### The JSON API

| Method and path | What it does |
| --- | --- |
| `GET /api/tickets?status=todo,doing&area=web&url=...` | Lists tickets. All filters are optional. |
| `GET /api/tickets/{id}` | Gets one ticket. |
| `POST /api/tickets` | Creates a ticket from JSON. |
| `PATCH /api/tickets/{id}` | Changes fields, for example `{"status":"review"}`. |
| `POST /api/tickets/{id}/notes` | Adds a note, `{"text":"...","by":"name"}`. |
| `POST /api/tickets/{id}/screenshot` | Attaches a PNG, JPEG or WebP image (5 MB maximum). |

### The agent loop

Each write through the API prints one line to the output of the board, for example `EVENT created #1012 bug web p2 "Title"`. The agent writes this output to a log file and watches the log in the background. When a line comes in, the agent wakes up, reads the ticket, sets `doing`, does the work, writes a `## Resolution` section and sets `review`. Then you look at the result and close the ticket.

[skills/claudeweaver/SKILL.md](skills/claudeweaver/SKILL.md) has the full instructions for the agent: the flags, the CLI, the ticket format, how to write tickets and the watch loop.

## Security

Claudeweaver is a tool for development only. Do not run it on a server, and do not load the overlay in production.

- The board listens on loopback (`127.0.0.1` and `::1`) only. To listen on another address, you must set `-unsafe-listen-any`.
- There is no auth. Each program on your machine can read and change the tickets.
- The board refuses requests whose `Host` header is not a loopback name. This stops DNS rebinding.
- The API accepts browser requests only from `http://localhost`, `http://127.0.0.1` and `http://*.localhost` pages. With `-tailnet-host`, it also accepts that one Tailscale name over HTTPS.

## Tests

```sh
cd skills/claudeweaver && go vet ./... && go test -race -count=1 ./...
```

## License

MIT. See [LICENSE](LICENSE).
