package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

// The tests in this file drive one Firefox connection whose extension
// stand-in reads frames only when the test asks. It stops in the middle of a
// frame far larger than the socket buffers, so the daemon is still writing
// that frame while the test cancels commands. No step waits for a duration:
// each one waits for a frame or a reply, and a step that waits for the frame
// of a command fails if that command returns first.
type transport struct {
	t *testing.T
	s *Server
	c *websocket.Conn
}

type outcome struct {
	result json.RawMessage
	err    error
}

// largeArgs makes a request frame of about 16 MiB.
var largeArgs = `{"blob":"` + strings.Repeat("x", 16<<20) + `"}`

func newTransport(t *testing.T) *transport {
	s, server := newServer(t, config.Config{})
	c, code := dial(t, s, server, firefoxExtension)
	if c == nil {
		t.Fatalf("dial: HTTP %d", code)
	}
	c.SetReadLimit(64 << 20)
	if err := greet(c, Packet{Browser: Firefox}); err != nil {
		t.Fatal(err)
	}
	return &transport{t, s, c}
}

// run sends a command from another goroutine and delivers its outcome.
func (tr *transport) run(ctx context.Context, session, args string) <-chan outcome {
	done := make(chan outcome, 1)
	go func() {
		result, err := tr.s.Hub.CallBrowser(ctx, Firefox, Command{Action: "echo", Session: session, Args: json.RawMessage(args)})
		done <- outcome{result, err}
	}()
	return done
}

// returned fails the test: the command that watch belongs to returned before
// the frame the test waits for arrived.
func (tr *transport) returned(out outcome) {
	tr.t.Helper()
	tr.t.Fatalf("the command returned before its frame arrived: %s %v", out.result, out.err)
}

// read returns the next whole frame, which the command of watch sends. A nil
// watch waits for the frame alone.
func (tr *transport) read(watch <-chan outcome) Packet {
	tr.t.Helper()
	type frame struct {
		p   Packet
		err error
	}
	got := make(chan frame, 1)
	go func() {
		var f frame
		f.err = wsjson.Read(context.Background(), tr.c, &f.p)
		got <- f
	}()
	select {
	case f := <-got:
		if f.err != nil {
			tr.t.Fatal(f.err)
		}
		return f.p
	case out := <-watch:
		tr.returned(out)
		return Packet{}
	}
}

// start reads only the header of the next frame, which the command of watch
// sends; the rest stays unread until the returned function is called.
func (tr *transport) start(watch <-chan outcome) func() Packet {
	tr.t.Helper()
	type header struct {
		frame io.Reader
		err   error
	}
	got := make(chan header, 1)
	go func() {
		var h header
		_, h.frame, h.err = tr.c.Reader(context.Background())
		got <- h
	}()
	var frame io.Reader
	select {
	case h := <-got:
		if h.err != nil {
			tr.t.Fatal(h.err)
		}
		frame = h.frame
	case out := <-watch:
		tr.returned(out)
	}
	return func() Packet {
		tr.t.Helper()
		data, err := io.ReadAll(frame)
		if err != nil {
			tr.t.Fatalf("the connection closed while a frame was written: %v", err)
		}
		var p Packet
		if err = json.Unmarshal(data, &p); err != nil {
			tr.t.Fatal(err)
		}
		return p
	}
}

func (tr *transport) answer(id string) {
	tr.t.Helper()
	if err := wsjson.Write(context.Background(), tr.c, Packet{Type: "response", ID: id, Result: json.RawMessage(`{"ok":true}`)}); err != nil {
		tr.t.Fatal(err)
	}
}

// replied checks that each command got the stand-in's answer.
func (tr *transport) replied(commands map[string]<-chan outcome) {
	tr.t.Helper()
	for name, done := range commands {
		if out := <-done; out.err != nil || string(out.result) != `{"ok":true}` {
			tr.t.Fatalf("%s: %s %v", name, out.result, out.err)
		}
	}
	if !tr.s.Hub.ConnectedTo(Firefox) {
		tr.t.Fatal("firefox disconnected")
	}
}

func codeOf(err error) string {
	if err == nil {
		return ""
	}
	return fault(err).Code
}

// A command whose deadline passes while its request frame is being written
// fails alone; the connection and the other commands in flight on it stay.
func TestCancelDuringRequestWriteKeepsConnection(t *testing.T) {
	tr := newTransport(t)
	ctx := context.Background()
	// held is in flight, waiting for its reply.
	held := tr.run(ctx, "held", `{}`)
	first := tr.read(held)
	bigCtx, cancelBig := context.WithCancel(ctx)
	big := tr.run(bigCtx, "big", largeArgs)
	rest := tr.start(big)
	// waiting queues behind big's frame and gives up when it is cancelled,
	// without being sent.
	waitCtx, cancelWait := context.WithCancel(ctx)
	waiting := tr.run(waitCtx, "waiting", `{}`)
	cancelWait()
	if out := <-waiting; codeOf(out.err) != "outcome_unknown" {
		t.Fatalf("command cancelled while waiting to be written: %v", out.err)
	}
	cancelBig()
	sent := rest()
	if sent.Command == nil || sent.Command.Session != "big" {
		t.Fatalf("frame being written: %+v", sent)
	}
	// Once written, big returns outcome_unknown and the daemon cancels it.
	if out := <-big; codeOf(out.err) != "outcome_unknown" {
		t.Fatalf("command cancelled while its frame was written: %v", out.err)
	}
	if p := tr.read(nil); p.Type != "cancel" || p.ID != sent.ID {
		t.Fatalf("frame after the cancelled command: %+v", p)
	}
	// A command whose deadline has already passed is not sent.
	expired, expire := context.WithCancel(ctx)
	expire()
	if out := <-tr.run(expired, "expired", `{}`); codeOf(out.err) != "outcome_unknown" {
		t.Fatalf("expired command: %v", out.err)
	}
	// The connection still carries commands, and held gets its reply.
	next := tr.run(ctx, "next", `{}`)
	p := tr.read(next)
	if p.Command == nil || p.Command.Session != "next" {
		t.Fatalf("frame after the expired command: %+v", p)
	}
	tr.answer(p.ID)
	tr.answer(first.ID)
	tr.replied(map[string]<-chan outcome{"next": next, "held": held})
}

// The cancel frame of a command that ends while a large frame is being
// written goes out after that frame and before frames queued later. The
// command returns without waiting for it.
func TestCancelFrameWaitsBehindALargeFrame(t *testing.T) {
	tr := newTransport(t)
	ctx := context.Background()
	smallCtx, cancelSmall := context.WithCancel(ctx)
	small := tr.run(smallCtx, "small", `{}`)
	sent := tr.read(small)
	big := tr.run(ctx, "big", largeArgs)
	rest := tr.start(big)
	cancelSmall()
	if out := <-small; codeOf(out.err) != "outcome_unknown" {
		t.Fatalf("cancelled command: %v", out.err)
	}
	// next is queued after the cancel frame.
	next := tr.run(ctx, "next", `{}`)
	written := rest()
	if written.Command == nil || written.Command.Session != "big" {
		t.Fatalf("large frame: %+v", written)
	}
	if p := tr.read(nil); p.Type != "cancel" || p.ID != sent.ID {
		t.Fatalf("frame after the large frame: %s %s; want the cancel of %s", p.Type, p.ID, sent.ID)
	}
	p := tr.read(next)
	if p.Command == nil || p.Command.Session != "next" {
		t.Fatalf("frame after the cancel: %+v", p)
	}
	tr.answer(p.ID)
	tr.answer(written.ID)
	tr.replied(map[string]<-chan outcome{"next": next, "big": big})
}

// A frame waiting for its turn is dropped when the connection ends, and gives
// its place in the queue back.
func TestQueuedFrameStopsWhenConnectionEnds(t *testing.T) {
	l := &link{closed: make(chan struct{})}
	current := l.queue.enter()
	done := make(chan error, 1)
	go func() { done <- l.write(l.queue.enter(), nil, encode(Packet{Type: "cancel"})) }()
	close(l.closed)
	if err := <-done; !errors.Is(err, errClosed) {
		t.Fatalf("queued frame after the connection ended: %v", err)
	}
	l.queue.exit(current)
	select {
	case <-l.queue.enter():
	default:
		t.Fatal("the queue stayed busy")
	}
}
