package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// TestIsInterruptedBusyWait pins the classifier for the form the busy condition
// takes when the driver interrupts the statement and returns the context error
// instead of SQLITE_BUSY. The negative cases are the ones that must never be
// reported as contention: a caller that hung up, an outcome that is not a
// context error at all, and a deadline that expired without the statement
// having waited long enough for the busy handler to be the explanation.
func TestIsInterruptedBusyWait(t *testing.T) {
	t.Parallel()

	longWait := MinBusyWait + time.Millisecond
	shortWait := MinBusyWait - time.Millisecond

	testCases := []struct {
		name   string
		err    error
		waited time.Duration
		want   bool
	}{
		{
			name:   "an interrupted wait is contention",
			err:    context.DeadlineExceeded,
			waited: longWait,
			want:   true,
		},
		{
			name:   "the wrapping the callers apply is traversed",
			err:    fmt.Errorf("exec: %w", context.DeadlineExceeded),
			waited: longWait,
			want:   true,
		},
		{
			name:   "a wait of exactly the minimum is contention",
			err:    context.DeadlineExceeded,
			waited: MinBusyWait,
			want:   true,
		},
		{
			name:   "a deadline without a wait is not contention",
			err:    context.DeadlineExceeded,
			waited: shortWait,
			want:   false,
		},
		{
			name:   "a statement that did not wait at all is not contention",
			err:    context.DeadlineExceeded,
			waited: 0,
			want:   false,
		},
		{
			name:   "a cancelled request is never contention",
			err:    context.Canceled,
			waited: longWait,
			want:   false,
		},
		{
			name:   "a cancellation joined with a deadline is never contention",
			err:    errors.Join(context.Canceled, context.DeadlineExceeded),
			waited: longWait,
			want:   false,
		},
		{
			name:   "no rows is not contention",
			err:    sql.ErrNoRows,
			waited: longWait,
			want:   false,
		},
		{
			name:   "a duplicate row is not contention",
			err:    ErrTestUniqueConstraintViolation,
			waited: longWait,
			want:   false,
		},
		{
			name:   "a generic failure is not contention",
			err:    errors.New("no such table: resource (1)"),
			waited: longWait,
			want:   false,
		},
		{
			// The driver's own busy state is recognised by IsBusyOrLocked; this
			// classifier answers only for the form that lost it.
			name:   "the driver's own busy state is not this form",
			err:    ErrTestBusy,
			waited: longWait,
			want:   false,
		},
		{
			name:   "no error is not contention",
			err:    nil,
			waited: longWait,
			want:   false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := IsInterruptedBusyWait(tc.err, tc.waited); got != tc.want {
				t.Errorf("IsInterruptedBusyWait(%v, %s) = %v, want %v", tc.err, tc.waited, got, tc.want)
			}
		})
	}
}

// TestInterruptedBusyWaitAgainstDriver is the reason the classifier cannot work
// from the driver error alone: it drives a real write against a database whose
// write lock is held by another connection and shows that the busy state is
// gone from the error by the time the caller sees it.
//
// It also pins the timing the classifier relies on: the driver does not abandon
// the busy handler when the context expires, so the statement returns having
// waited that handler out — well past MinBusyWait, and well past its own
// deadline — no matter how short the deadline was. That is the property
// MinBusyWait rests on.
func TestInterruptedBusyWaitAgainstDriver(t *testing.T) {
	t.Parallel()

	// The connection is built exactly as a Grafana deployment's is, through the
	// DSN conversion this package performs, so the busy timeout under test is
	// the one production runs with. It is read back from the connection rather
	// than assumed, so this test states what the driver does at whatever value
	// the conversion applies.
	dsn := "file:" + filepath.Join(t.TempDir(), "busy.db")

	writer, err := sql.Open("sqlite3", dsn)
	if err != nil {
		t.Fatalf("open SQLite database: %v", err)
	}
	t.Cleanup(func() {
		if err := writer.Close(); err != nil {
			t.Errorf("close SQLite database: %v", err)
		}
	})
	if _, err := writer.ExecContext(t.Context(), "CREATE TABLE resource (guid TEXT)"); err != nil {
		t.Fatalf("create table: %v", err)
	}

	var busyTimeoutMS int64
	if err := writer.QueryRowContext(t.Context(), "PRAGMA busy_timeout").Scan(&busyTimeoutMS); err != nil {
		t.Fatalf("read busy_timeout: %v", err)
	}
	busyTimeout := time.Duration(busyTimeoutMS) * time.Millisecond
	if busyTimeout <= MinBusyWait {
		t.Fatalf("the configured busy timeout %s does not exceed MinBusyWait %s, so a lock wait cannot be attributed", busyTimeout, MinBusyWait)
	}

	// A second connection holds the write lock for longer than the busy
	// timeout, which is what an external writer does in production.
	holder, err := sql.Open("sqlite3", dsn)
	if err != nil {
		t.Fatalf("open holding connection: %v", err)
	}
	t.Cleanup(func() {
		if err := holder.Close(); err != nil {
			t.Errorf("close holding connection: %v", err)
		}
	})
	holdCtx := t.Context()
	held, err := holder.Conn(holdCtx)
	if err != nil {
		t.Fatalf("acquire holding connection: %v", err)
	}
	if _, err := held.ExecContext(holdCtx, "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("begin immediate: %v", err)
	}
	defer func() {
		if _, err := held.ExecContext(holdCtx, "ROLLBACK"); err != nil {
			t.Errorf("release write lock: %v", err)
		}
		if err := held.Close(); err != nil {
			t.Errorf("close holding connection: %v", err)
		}
	}()

	// A deadline shorter than the busy timeout is what every caller with a
	// request budget below busy_timeout has, and it is what erases the busy
	// state: the driver substitutes the context error for the SQLite one.
	deadline := busyTimeout / 4
	ctx, cancel := context.WithTimeout(t.Context(), deadline)
	defer cancel()

	started := time.Now()
	_, err = writer.ExecContext(ctx, "INSERT INTO resource (guid) VALUES (?)", "guid")
	waited := time.Since(started)

	if err == nil {
		t.Fatal("the write must not succeed while another connection holds the write lock")
	}
	if IsBusyOrLocked(err) {
		t.Fatalf("the driver still reported its busy state, so the classifier under test is unnecessary: %v", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected the substituted context error, got %v", err)
	}
	if waited < MinBusyWait {
		t.Fatalf("the statement waited %s, less than the %s the classifier requires: the busy handler is expected to hold it for nearly the whole %s busy timeout", waited, MinBusyWait, busyTimeout)
	}
	if waited < deadline+MinBusyWait {
		t.Errorf("the statement returned %s after its %s deadline: the driver no longer holds an interrupted statement in the busy wait, which is what makes the wait attributable", waited-deadline, deadline)
	}
	if !IsInterruptedBusyWait(err, waited) {
		t.Fatalf("live contention was not classified: err=%v waited=%s", err, waited)
	}
}
