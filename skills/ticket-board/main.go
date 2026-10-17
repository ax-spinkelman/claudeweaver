// Command ticket-board serves a ticket board and the dev-mode sticky-note
// overlay, and doubles as a CLI. Ticket files in -dir are the source of truth.
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed board.html
var boardHTML string

//go:embed devnotes.js
var devnotesJS []byte

const maxScreenshot = 5 << 20

func main() {
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		if err := runCLI(os.Args[1:], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "ticket-board:", err)
			os.Exit(1)
		}
		return
	}
	addr := flag.String("addr", ":8090", "listen address; an empty host means loopback only")
	dir := flag.String("dir", "tickets", "tickets directory")
	areas := flag.String("areas", strings.Join(Areas, ","), "comma-separated list of allowed areas")
	unsafeAny := flag.Bool("unsafe-listen-any", false, "allow a non-loopback listen address (no auth!)")
	flag.Parse()
	setAreas(*areas)

	addrs, err := listenAddrs(*addr, *unsafeAny)
	if err != nil {
		log.Fatal(err)
	}
	h := newServer(NewStore(*dir), *unsafeAny, os.Stdout)
	errc := make(chan error, len(addrs))
	for i, a := range addrs {
		ln, err := net.Listen("tcp", a)
		if err != nil {
			if i > 0 { // the IPv6 loopback is a bonus, not a requirement
				continue
			}
			log.Fatal(err)
		}
		log.Printf("ticket board on http://%s (dir %s)", ln.Addr(), *dir)
		go func() { errc <- http.Serve(ln, h) }()
	}
	log.Fatal(<-errc)
}

// setAreas replaces Areas with a comma list; an empty list keeps the default.
func setAreas(list string) {
	var a []string
	for _, s := range strings.Split(list, ",") {
		if s = strings.TrimSpace(s); s != "" {
			a = append(a, s)
		}
	}
	if len(a) > 0 {
		Areas = a
	}
}

// listenAddrs maps -addr to the addresses to bind. An empty host or
// "localhost" binds both loopbacks; anything not loopback needs unsafeAny.
func listenAddrs(addr string, unsafeAny bool) ([]string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host == "" || host == "localhost" {
		return []string{net.JoinHostPort("127.0.0.1", port), net.JoinHostPort("::1", port)}, nil
	}
	if ip := net.ParseIP(host); (ip != nil && ip.IsLoopback()) || unsafeAny {
		return []string{addr}, nil
	}
	return nil, fmt.Errorf("refusing to listen on %q: the board has no auth; use a loopback address or pass -unsafe-listen-any", addr)
}

// allowedOrigin reports whether a browser origin may call the API.
func allowedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Path != "" || u.User != nil {
		return false
	}
	h := u.Hostname()
	return h == "localhost" || h == "127.0.0.1" || strings.HasSuffix(h, ".localhost") // portless names
}

// loopbackHost guards against DNS rebinding: the Host header must name us by
// a loopback name. Browsers resolve *.localhost to loopback themselves.
func loopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
}

type server struct {
	store  *Store
	board  *template.Template
	events io.Writer // one EVENT line per change made through the HTTP API
}

func (s *server) event(format string, args ...any) {
	fmt.Fprintf(s.events, "EVENT "+format+"\n", args...)
}

// changes lists the fields that differ, for the "updated" event line.
func changes(a, b Ticket) string {
	var out []string
	for _, f := range []struct{ k, a, b string }{{"status", a.Status, b.Status}, {"type", a.Type, b.Type},
		{"priority", a.Priority, b.Priority}, {"area", a.Area, b.Area}, {"title", a.Title, b.Title}} {
		if f.a != f.b {
			v := f.b
			if f.k == "title" {
				v = strconv.Quote(v)
			}
			out = append(out, f.k+"="+v)
		}
	}
	if a.Body != b.Body {
		out = append(out, "body=changed")
	}
	return strings.Join(out, " ")
}

func newServer(st *Store, unsafeAny bool, events io.Writer) http.Handler {
	s := &server{store: st, events: events, board: template.Must(template.New("board").Funcs(template.FuncMap{
		"age": func(ts string) string { return age(ts, st.Now()) },
	}).Parse(boardHTML))}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.page)
	mux.HandleFunc("GET /columns", s.page)
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, st.Version()) })
	mux.HandleFunc("GET /devnotes.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(devnotesJS)
	})
	mux.Handle("GET /assets/", http.StripPrefix("/assets/", http.FileServer(http.Dir(filepath.Join(st.Dir, "assets")))))
	mux.HandleFunc("GET /api/tickets", s.list)
	mux.HandleFunc("GET /api/tickets/{id}", s.withID(func(w http.ResponseWriter, r *http.Request, id int) {
		t, err := st.Get(id)
		reply(w, t, err)
	}))
	mux.HandleFunc("POST /api/tickets", func(w http.ResponseWriter, r *http.Request) {
		var n NewTicket
		if !decode(w, r, &n) {
			return
		}
		t, err := st.Create(n)
		if err == nil {
			s.event("created #%d %s %s %s %q", t.ID, t.Type, t.Area, t.Priority, t.Title)
			w.WriteHeader(http.StatusCreated)
		}
		reply(w, t, err)
	})
	mux.HandleFunc("PATCH /api/tickets/{id}", s.withID(func(w http.ResponseWriter, r *http.Request, id int) {
		var p Patch
		if !decode(w, r, &p) {
			return
		}
		old, err := st.Get(id)
		if err != nil {
			reply(w, nil, err)
			return
		}
		t, err := st.Update(id, p)
		if c := changes(old, t); err == nil && c != "" {
			s.event("updated #%d %s", id, c)
		}
		reply(w, t, err)
	}))
	mux.HandleFunc("POST /api/tickets/{id}/notes", s.withID(func(w http.ResponseWriter, r *http.Request, id int) {
		var n struct{ Text, By string }
		if !decode(w, r, &n) {
			return
		}
		t, err := st.AddNote(id, n.Text, n.By)
		if err == nil {
			s.event("note #%d %q", id, oneLine(n.Text, 120))
		}
		reply(w, t, err)
	}))
	mux.HandleFunc("POST /api/tickets/{id}/screenshot", s.withID(s.screenshot))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !unsafeAny && !loopbackHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" {
			if !allowedOrigin(o) {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *server) withID(fn func(http.ResponseWriter, *http.Request, int)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			http.Error(w, "bad ticket id", http.StatusBadRequest)
			return
		}
		fn(w, r, id)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		http.Error(w, "bad JSON: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func reply(w http.ResponseWriter, v any, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case err != nil:
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	all, err := s.store.List()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	out := []Ticket{}
	for _, t := range all {
		if match(t, q.Get("status"), q.Get("area"), q.Get("url")) {
			out = append(out, t)
		}
	}
	reply(w, out, nil)
}

// match applies the list filters. status takes a comma list; url matches the
// same page (origin, path and hash; the query string is ignored).
func match(t Ticket, status, area, u string) bool {
	if status != "" && !strings.Contains(","+status+",", ","+t.Status+",") {
		return false
	}
	if area != "" && t.Area != area {
		return false
	}
	return u == "" || (t.URL != "" && samePage(t.URL, u))
}

func samePage(a, b string) bool {
	ua, err1 := url.Parse(a)
	ub, err2 := url.Parse(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return ua.Host == ub.Host && strings.TrimSuffix(ua.Path, "/") == strings.TrimSuffix(ub.Path, "/") && ua.Fragment == ub.Fragment
}

func (s *server) screenshot(w http.ResponseWriter, r *http.Request, id int) {
	if _, err := s.store.Get(id); err != nil {
		reply(w, nil, err)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxScreenshot))
	if err != nil {
		http.Error(w, "screenshot too large (max 5 MB)", http.StatusRequestEntityTooLarge)
		return
	}
	t, rel, err := s.store.AddImage(id, data)
	if err == nil {
		s.event("screenshot #%d %s", id, rel)
	}
	reply(w, t, err)
}

// ---- board ----

type column struct {
	Status, Label string
	Tickets       []Ticket
}

var labels = map[string]string{"inbox": "Inbox", "todo": "To do", "doing": "Doing", "review": "Review", "done": "Done", "wontfix": "Won't fix"}

// columns groups tickets by status; unknown statuses land in the inbox.
func columns(ts []Ticket) []column {
	cols := make([]column, len(Statuses))
	idx := map[string]int{}
	for i, s := range Statuses {
		cols[i] = column{Status: s, Label: labels[s]}
		idx[s] = i
	}
	for _, t := range ts {
		cols[idx[t.Status]].Tickets = append(cols[idx[t.Status]].Tickets, t)
	}
	return cols
}

func (s *server) page(w http.ResponseWriter, r *http.Request) {
	ts, err := s.store.List()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	data := map[string]any{"Columns": columns(ts), "Areas": Areas, "Types": Types, "Priorities": Priorities,
		"Statuses": Statuses, "Labels": labels, "Version": s.store.Version(), "Total": len(ts)}
	name := "board"
	if r.URL.Path == "/columns" {
		name = "columns"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.board.ExecuteTemplate(w, name, data); err != nil {
		log.Print(err)
	}
}

func age(ts string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ""
	}
	d := now.Sub(t)
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%dm", max(0, int(d.Minutes())))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// ---- CLI ----

const usage = `usage:
  ticket-board ls [--status todo] [--area web]
  ticket-board show <id>
  ticket-board new --title "..." [--type bug] [--area web] [--priority p2] [--status todo] [--body - | --body "text"]
  ticket-board mv <id> <status>
  ticket-board note <id> "text" [--by name]
  ticket-board [-addr :8090] [-dir tickets] [-areas web,server,docs,infra]     (serve the board)
All commands take --dir and --areas.`

func runCLI(args []string, stdin io.Reader, out io.Writer) error {
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	dir := fs.String("dir", "tickets", "tickets directory")
	areas := fs.String("areas", "", "comma-separated list of allowed areas")
	status := fs.String("status", "", "")
	area := fs.String("area", "", "")
	title := fs.String("title", "", "")
	typ := fs.String("type", "", "")
	prio := fs.String("priority", "", "")
	body := fs.String("body", "", `body text, or "-" to read stdin`)
	source := fs.String("source", "agent", "")
	by := fs.String("by", "", "")
	// Allow flags after positional args: "note 12 text --by x".
	var pos []string
	rest := args[1:]
	for {
		if err := fs.Parse(rest); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			break
		}
		pos = append(pos, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	setAreas(*areas)
	st := NewStore(*dir)
	needID := func(n int) (int, error) {
		if len(pos) != n {
			return 0, errors.New(usage)
		}
		id, err := strconv.Atoi(strings.TrimLeft(pos[0], "#"))
		if err != nil {
			return 0, fmt.Errorf("bad id %q", pos[0])
		}
		return id, nil
	}
	switch args[0] {
	case "ls":
		ts, err := st.List()
		if err != nil {
			return err
		}
		for _, t := range ts {
			if match(t, *status, *area, "") {
				fmt.Fprintf(out, "%4d  %-7s %-7s %-2s %-9s %s\n", t.ID, t.Status, t.Type, t.Priority, t.Area, t.Title)
			}
		}
	case "show":
		id, err := needID(1)
		if err != nil {
			return err
		}
		n, _, err := st.find(id)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(filepath.Join(st.Dir, n))
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n\n%s", filepath.Join(st.Dir, n), b)
	case "new":
		b := *body
		if b == "-" {
			raw, err := io.ReadAll(stdin)
			if err != nil {
				return err
			}
			b = string(raw)
		}
		t, err := st.Create(NewTicket{Title: *title, Type: *typ, Area: *area, Priority: *prio, Status: *status, Source: *source, Body: b})
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "created #%d %s\n", t.ID, filepath.Join(st.Dir, t.File))
	case "mv":
		id, err := needID(2)
		if err != nil {
			return err
		}
		t, err := st.Update(id, Patch{Status: &pos[1]})
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "#%d is now %s\n", t.ID, t.Status)
	case "note":
		id, err := needID(2)
		if err != nil {
			return err
		}
		if _, err := st.AddNote(id, pos[1], *by); err != nil {
			return err
		}
		fmt.Fprintf(out, "noted on #%d\n", id)
	default:
		return errors.New(usage)
	}
	return nil
}
