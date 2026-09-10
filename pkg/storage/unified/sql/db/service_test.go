package db_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/grafana/grafana-app-sdk/logging"

	"github.com/grafana/grafana/pkg/storage/unified/sql/db"
	"github.com/grafana/grafana/pkg/storage/unified/sql/db/mocks"
	"github.com/grafana/grafana/pkg/util/sqlite"
	"github.com/grafana/grafana/pkg/util/testutil"
)

var errTest = errors.New("you shall not pass")

// Copy-paste of the constants used in `service.go`, since we need to use a
// separate package to avoid circular dependencies so we cannot import them.
// Keep these ones and the ones in `service.go` in sync.
const (
	txOpStr     = "transactional operation"
	beginStr    = "begin"
	commitStr   = "commit"
	rollbackStr = "rollback"
)

func TestNewWithTxFunc(t *testing.T) {
	t.Parallel()

	execTest := func(t *testing.T, d db.DB, txErr error) error {
		ctx := testutil.NewDefaultTestContext(t)
		return db.NewWithTxFunc(d.BeginTx).WithTx(ctx, nil,
			func(context.Context, db.Tx) error {
				return txErr
			})
	}

	t.Run("happy path", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Commit().Return(nil)

		err := execTest(t, mDB, nil)
		require.NoError(t, err)
	})

	t.Run("failed begin", func(t *testing.T) {
		t.Parallel()
		mDB := mocks.NewDB(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(nil, errTest)

		err := execTest(t, mDB, nil)
		require.Error(t, err)
		require.ErrorContains(t, err, beginStr)
	})

	t.Run("fail tx", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Rollback().Return(nil)

		err := execTest(t, mDB, errTest)
		require.Error(t, err)
		require.ErrorContains(t, err, txOpStr)
	})

	t.Run("fail tx; fail rollback", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Rollback().Return(errTest)

		err := execTest(t, mDB, errTest)
		require.Error(t, err)
		require.ErrorContains(t, err, txOpStr)
		require.ErrorContains(t, err, rollbackStr)
	})

	t.Run("fail commit", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Commit().Return(errTest)

		err := execTest(t, mDB, nil)
		require.Error(t, err)
		require.ErrorContains(t, err, commitStr)
	})

	// A failure to begin or to commit is the driver's own, and its raw text can
	// carry deployment detail (lock state, and for the networked drivers the
	// DSN host, port and user name). Those two are therefore redacted for API
	// clients: the error keeps its full text for the log and for errors.Is,
	// and additionally reports a generic internal status.
	t.Run("failed begin is redacted for clients", func(t *testing.T) {
		t.Parallel()
		mDB := mocks.NewDB(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(nil, errTest)

		err := execTest(t, mDB, nil)
		require.Error(t, err)
		require.ErrorIs(t, err, errTest)
		require.ErrorContains(t, err, errTest.Error())

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, err, &apistatus)
		require.Equal(t, int32(http.StatusInternalServerError), apistatus.Status().Code)
		require.Equal(t, metav1.StatusReasonInternalError, apistatus.Status().Reason)
		require.Equal(t, db.StorageErrorMessage, apistatus.Status().Message)
		require.NotContains(t, apistatus.Status().Message, errTest.Error())
	})

	t.Run("fail commit is redacted for clients", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Commit().Return(errTest)

		err := execTest(t, mDB, nil)
		require.Error(t, err)
		require.ErrorIs(t, err, errTest)
		require.ErrorContains(t, err, errTest.Error())

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, err, &apistatus)
		require.Equal(t, db.StorageErrorMessage, apistatus.Status().Message)
	})

	// The transactional operation itself is not redacted here: the error comes
	// from caller code, which is where deliberate 404, 409 and 422 outcomes are
	// produced, and errors.As matches the outermost status provider — so
	// wrapping it would turn every one of them into a 500.
	t.Run("fail tx keeps the status of the wrapped error", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Rollback().Return(nil)

		conflict := apierrors.NewConflict(schema.GroupResource{
			Group:    "playlist.grafana.app",
			Resource: "playlists",
		}, "qa017-vars", errTest)

		err := execTest(t, mDB, conflict)
		require.Error(t, err)
		require.True(t, apierrors.IsConflict(err))
	})

	t.Run("fail tx; fail rollback keeps the status of the wrapped error", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)

		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Rollback().Return(errTest)

		notFound := apierrors.NewNotFound(schema.GroupResource{
			Group:    "playlist.grafana.app",
			Resource: "playlists",
		}, "qa017-vars")

		err := execTest(t, mDB, notFound)
		require.Error(t, err)
		require.True(t, apierrors.IsNotFound(err))
		require.ErrorContains(t, err, rollbackStr)
	})
}

// capturingLogger records what the package logs, so that the detail withheld
// from API clients can be asserted to reach the operator instead. It is
// injected through the context, so it observes only the operation under test
// even while other tests run in parallel.
type capturingLogger struct {
	mu       *sync.Mutex
	messages *[]string
	args     []any
}

func newCapturingLogger() *capturingLogger {
	return &capturingLogger{mu: &sync.Mutex{}, messages: &[]string{}}
}

func (l *capturingLogger) record(level, msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	*l.messages = append(*l.messages, fmt.Sprintf("%s %s %v", level, msg, l.args))
}

func (l *capturingLogger) Debug(msg string, _ ...any) { l.record("debug", msg) }
func (l *capturingLogger) Info(msg string, _ ...any)  { l.record("info", msg) }
func (l *capturingLogger) Warn(msg string, _ ...any)  { l.record("warn", msg) }
func (l *capturingLogger) Error(msg string, _ ...any) { l.record("error", msg) }

func (l *capturingLogger) With(args ...any) logging.Logger {
	return &capturingLogger{
		mu:       l.mu,
		messages: l.messages,
		args:     append(append([]any{}, l.args...), args...),
	}
}

func (l *capturingLogger) WithContext(context.Context) logging.Logger { return l }

func (l *capturingLogger) recorded() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, *l.messages...)
}

// TestWithTxLogsBoundaryFailures asserts the compensating control for the
// redaction: a begin or commit failure that a client no longer sees in full is
// logged at error level with the driver detail intact.
func TestWithTxLogsBoundaryFailures(t *testing.T) {
	t.Parallel()

	run := func(t *testing.T, mDB db.DB, txErr error) []string {
		logger := newCapturingLogger()
		ctx := logging.Context(testutil.NewDefaultTestContext(t), logger)
		err := db.NewWithTxFunc(mDB.BeginTx).WithTx(ctx, nil,
			func(context.Context, db.Tx) error {
				return txErr
			})
		require.Error(t, err)
		return logger.recorded()
	}

	t.Run("failed begin", func(t *testing.T) {
		t.Parallel()
		mDB := mocks.NewDB(t)
		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(nil, errTest)

		recorded := run(t, mDB, nil)
		require.Len(t, recorded, 1)
		require.Contains(t, recorded[0], "error")
		require.Contains(t, recorded[0], beginStr)
		require.Contains(t, recorded[0], errTest.Error())
	})

	t.Run("failed commit", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)
		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Commit().Return(errTest)

		recorded := run(t, mDB, nil)
		require.Len(t, recorded, 1)
		require.Contains(t, recorded[0], "error")
		require.Contains(t, recorded[0], commitStr)
		require.Contains(t, recorded[0], errTest.Error())
	})

	t.Run("failed rollback", func(t *testing.T) {
		t.Parallel()
		mDB, mTx := mocks.NewDB(t), mocks.NewTx(t)
		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).Return(mTx, nil)
		mTx.EXPECT().Rollback().Return(errTest)

		recorded := run(t, mDB, errors.New("the transactional operation failed"))
		require.Len(t, recorded, 1)
		require.Contains(t, recorded[0], "error")
		require.Contains(t, recorded[0], rollbackStr)
		require.Contains(t, recorded[0], errTest.Error())
	})

	t.Run("a cancelled request is not a storage fault", func(t *testing.T) {
		t.Parallel()
		mDB := mocks.NewDB(t)
		mDB.EXPECT().BeginTx(mock.Anything, mock.Anything).
			Return(nil, fmt.Errorf("begin: %w", context.Canceled))

		recorded := run(t, mDB, nil)
		require.Len(t, recorded, 1)
		require.Contains(t, recorded[0], "debug")
	})
}

func TestRedact(t *testing.T) {
	t.Parallel()

	t.Run("nil stays nil", func(t *testing.T) {
		t.Parallel()
		require.NoError(t, db.Redact(nil))
	})

	t.Run("plain error gets the generic storage status", func(t *testing.T) {
		t.Parallel()

		err := db.Redact(fmt.Errorf("wrapped: %w", errTest))
		require.ErrorIs(t, err, errTest)
		require.Equal(t, "wrapped: "+errTest.Error(), err.Error())

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, err, &apistatus)
		require.Equal(t, db.InternalStorageStatus(), apistatus.Status())
	})

	t.Run("an error that already carries a status is left alone", func(t *testing.T) {
		t.Parallel()

		invalid := apierrors.NewBadRequest("name is invalid")
		err := db.Redact(fmt.Errorf("wrapped: %w", invalid))
		require.True(t, apierrors.IsBadRequest(err))

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, err, &apistatus)
		require.Equal(t, "name is invalid", apistatus.Status().Message)
	})

	t.Run("database contention keeps a retryable status", func(t *testing.T) {
		t.Parallel()

		err := db.Redact(fmt.Errorf("begin: %w", sqlite.ErrTestBusy))
		require.ErrorIs(t, err, sqlite.ErrTestBusy, "the driver error must stay reachable for retry logic")

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, err, &apistatus)
		require.Equal(t, db.StorageBusyStatus(), apistatus.Status())
	})
}

// TestStatusForError pins which envelope a database-layer error presents to a
// client. The distinction matters because redacting the driver text removes the
// only signal a caller previously had for telling contention — a request that
// will succeed on retry — apart from a server that is genuinely broken.
func TestStatusForError(t *testing.T) {
	t.Parallel()

	t.Run("contention is reported as retryable", func(t *testing.T) {
		t.Parallel()

		for _, err := range []error{
			sqlite.ErrTestBusy,
			sqlite.ErrTestLocked,
			fmt.Errorf("transactional operation: %w", sqlite.ErrTestBusy),
			// The interrupted form of the same condition: the driver replaced
			// SQLITE_BUSY with the context error, so the busy state is carried
			// by the marking the statement site applied instead.
			db.NewBusyError(context.DeadlineExceeded),
			fmt.Errorf("transactional operation: %w",
				db.NewBusyError(fmt.Errorf("exec: %w", context.DeadlineExceeded))),
			fmt.Errorf("transactional operation: %w; rollback: %w",
				db.NewBusyError(context.DeadlineExceeded), sql.ErrTxDone),
		} {
			status := db.StatusForError(err)
			require.Equal(t, metav1.StatusFailure, status.Status)
			require.Equal(t, int32(http.StatusInternalServerError), status.Code)
			require.Equal(t, metav1.StatusReasonServerTimeout, status.Reason)
			require.Equal(t, db.StorageBusyMessage, status.Message)
			require.NotNil(t, status.Details)
			require.Positive(t, status.Details.RetryAfterSeconds,
				"a retry hint is what makes the response retryable for clients")
			require.Equal(t, int32(1), status.Details.RetryAfterSeconds,
				"one second is the retry hint the API server renders as Retry-After")
		}
	})

	t.Run("any other failure is reported generically", func(t *testing.T) {
		t.Parallel()

		for _, err := range []error{
			errTest,
			fmt.Errorf("no such table: resource (1): %w", errTest),
			// A client that hung up, and a deadline that no statement site
			// attributed to the database write lock, are not contention: an
			// expired deadline on its own says nothing about why.
			context.Canceled,
			fmt.Errorf("exec: %w", context.Canceled),
			context.DeadlineExceeded,
			fmt.Errorf("exec: %w", context.DeadlineExceeded),
			sql.ErrNoRows,
			sqlite.ErrTestUniqueConstraintViolation,
		} {
			require.Equal(t, db.InternalStorageStatus(), db.StatusForError(err),
				"unexpected envelope for %v", err)
		}
	})

	t.Run("the retryable message discloses no more than the generic one", func(t *testing.T) {
		t.Parallel()

		for _, forbidden := range []string{
			".sql", "query", "select", "insert", "table", "column", "sqlite",
			"locked", "busy_timeout", "password", "host", "port",
		} {
			require.NotContains(t, strings.ToLower(db.StorageBusyMessage), forbidden,
				"contention message must not disclose %q", forbidden)
		}
	})
}

// TestBusyError pins the marker that carries the busy condition from the
// statement site, which is the last place it is recognisable, up to the
// envelope: the driver replaces SQLITE_BUSY with the context error for any
// statement it interrupts, so nothing above the statement can tell a write that
// lost the race for the database from any other expired deadline.
func TestBusyError(t *testing.T) {
	t.Parallel()

	t.Run("nil stays nil", func(t *testing.T) {
		t.Parallel()
		require.NoError(t, db.NewBusyError(nil))
	})

	t.Run("the wrapped error is left intact", func(t *testing.T) {
		t.Parallel()

		wrapped := fmt.Errorf("exec: %w", context.DeadlineExceeded)
		err := db.NewBusyError(wrapped)

		require.Equal(t, wrapped.Error(), err.Error(),
			"marking a failure adds a classification, never text")
		require.ErrorIs(t, err, context.DeadlineExceeded,
			"the context error must stay reachable for the failure logging")
		require.NotErrorIs(t, err, context.Canceled)
	})

	t.Run("it carries the retryable envelope on its own", func(t *testing.T) {
		t.Parallel()

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, db.NewBusyError(context.DeadlineExceeded), &apistatus)
		require.Equal(t, db.StorageBusyStatus(), apistatus.Status())
	})

	t.Run("redaction keeps the retryable envelope", func(t *testing.T) {
		t.Parallel()

		err := db.Redact(fmt.Errorf("commit: %w", db.NewBusyError(context.DeadlineExceeded)))

		var apistatus apierrors.APIStatus
		require.ErrorAs(t, err, &apistatus)
		require.Equal(t, db.StorageBusyStatus(), apistatus.Status())
	})
}

// TestIsBusy pins the single predicate for a lost race for the database, so
// that retry logic and the client envelope cannot disagree about which
// failures are transient.
func TestIsBusy(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "the driver's busy state", err: sqlite.ErrTestBusy, want: true},
		{name: "the driver's locked state", err: sqlite.ErrTestLocked, want: true},
		{
			name: "the driver's busy state through wrapping",
			err:  fmt.Errorf("transactional operation: %w", sqlite.ErrTestBusy),
			want: true,
		},
		{name: "an interrupted busy wait", err: db.NewBusyError(context.DeadlineExceeded), want: true},
		{
			name: "an interrupted busy wait through wrapping",
			err:  fmt.Errorf("transactional operation: %w", db.NewBusyError(context.DeadlineExceeded)),
			want: true,
		},
		{name: "a cancelled request", err: context.Canceled, want: false},
		{name: "an unattributed expired deadline", err: context.DeadlineExceeded, want: false},
		{name: "no rows", err: sql.ErrNoRows, want: false},
		{name: "a duplicate row", err: sqlite.ErrTestUniqueConstraintViolation, want: false},
		{name: "a generic failure", err: errTest, want: false},
		{name: "no error", err: nil, want: false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			require.Equal(t, tc.want, db.IsBusy(tc.err))
		})
	}
}

func TestInternalStorageStatus(t *testing.T) {
	t.Parallel()

	status := db.InternalStorageStatus()
	require.Equal(t, metav1.StatusFailure, status.Status)
	require.Equal(t, int32(http.StatusInternalServerError), status.Code)
	require.Equal(t, metav1.StatusReasonInternalError, status.Reason)
	require.Equal(t, db.StorageErrorMessage, status.Message)
	require.Nil(t, status.Details)

	// The message exists to tell a client nothing beyond "storage failed".
	for _, forbidden := range []string{
		".sql", "query", "select", "insert", "table", "column", "locked",
		"password", "host", "port",
	} {
		require.NotContains(t, strings.ToLower(status.Message), forbidden,
			"generic storage message must not disclose %q", forbidden)
	}
}
