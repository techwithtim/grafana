package dbutil

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"text/template"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana-app-sdk/logging"

	"github.com/grafana/grafana/pkg/storage/unified/sql/db"
	"github.com/grafana/grafana/pkg/storage/unified/sql/db/dbimpl"
	"github.com/grafana/grafana/pkg/storage/unified/sql/sqltemplate"
	sqltemplateMocks "github.com/grafana/grafana/pkg/storage/unified/sql/sqltemplate/mocks"
	"github.com/grafana/grafana/pkg/storage/unified/sql/test"
	"github.com/grafana/grafana/pkg/util/sqlite"
	"github.com/grafana/grafana/pkg/util/testutil"
)

var (
	validTestTmpl   = template.Must(template.New("test").Parse("nothing special"))
	invalidTestTmpl = template.New("no definition should fail to exec")
	errTest         = errors.New("because of reasons")
)

func TestSQLError(t *testing.T) {
	t.Parallel()

	const hiddenMessage = "obey, consume"

	var err error = SQLError{
		Err:          errTest,
		CallType:     "Exec",
		TemplateName: "some.sql",
		Query:        "SELECT name FROM movies WHERE quote LIKE ?",
		RawQuery:     "SELECT name FROM movies WHERE quote LIKE ?",
		ScanDest:     []any{new(string)},
		arguments:    []any{hiddenMessage},
	}

	require.Error(t, err)
	require.ErrorIs(t, err, errTest)
	require.NotContains(t, err.Error(), hiddenMessage)

	err = Debug(err)
	require.Error(t, err)
	require.Contains(t, err.Error(), hiddenMessage)

	err = Debug(errTest)
	require.Error(t, err)
	require.ErrorIs(t, err, errTest)
}

// readTemplateName, readQuery and readDriverErr reproduce the exact shape that
// leaked to API clients: the query template file name, the executed statement
// with its table and column names, and the driver error, as observed in a 500
// response body from both the resource and the legacy playlist surfaces.
const (
	readTemplateName = "resource_read.sql"
	readQuery        = `SELECT "guid", "namespace", "group", "resource", "name", "folder", "resource_version", "value"
    FROM "resource"
    WHERE 1 = 1 AND "namespace" = ? AND "group" = ? AND "resource" = ? AND "name" = ?;`
)

// TestSQLErrorOperatorDetailIsPreserved pins the operator-facing behaviour of
// SQLError that other code paths depend on: the Error() text (logged here and
// asserted on elsewhere in the tree) and the unwrapping that drives
// errors.Is-based classification, including the sql.ErrNoRows "not found"
// branch of the SQL backend and driver-specific retry detection.
func TestSQLErrorOperatorDetailIsPreserved(t *testing.T) {
	t.Parallel()

	driverErr := errors.New("SQL logic error: no such table: resource (1)")
	sqlErr := SQLError{
		Err:          driverErr,
		CallType:     "Query",
		TemplateName: readTemplateName,
		Query:        readQuery,
		RawQuery:     readQuery,
		ScanDest:     []any{new(string), new(string)},
		arguments:    []any{"default", "playlist.grafana.app"},
	}

	require.Equal(t, fmt.Sprintf("%s: Query with 2 input arguments and 2 "+
		"output destination arguments: %v; query: %s", readTemplateName,
		driverErr, readQuery), sqlErr.Error())

	// The production wrapping applied by db.NewWithTxFunc must not hide the
	// driver error from errors.Is.
	wrapped := fmt.Errorf("transactional operation: %w", error(sqlErr))
	require.ErrorIs(t, wrapped, driverErr)
	require.ErrorContains(t, wrapped, readTemplateName)
	require.ErrorContains(t, wrapped, readQuery)

	// The "object not found" branch of the SQL backend keys on this.
	noRows := fmt.Errorf("transactional operation: %w", error(SQLError{
		Err:          sql.ErrNoRows,
		CallType:     "Query",
		TemplateName: readTemplateName,
		Query:        readQuery,
	}))
	require.ErrorIs(t, noRows, sql.ErrNoRows)

	// Debug() remains the only renderer of the statement arguments.
	require.Contains(t, Debug(error(sqlErr)).Error(), "playlist.grafana.app")
	require.NotContains(t, sqlErr.Error(), "playlist.grafana.app")
}

// TestSQLErrorStatusIsGeneric asserts the client-facing envelope: a SQLError
// reports a generic internal error through the APIStatus contract, so the
// unified storage error mapping never renders Error() into a response body.
func TestSQLErrorStatusIsGeneric(t *testing.T) {
	t.Parallel()

	const hiddenArgument = "obey, consume"

	sqlErr := SQLError{
		Err:          errors.New("SQL logic error: no such table: resource (1)"),
		CallType:     "Query",
		TemplateName: readTemplateName,
		Query:        readQuery,
		RawQuery:     readQuery,
		ScanDest:     []any{new(string)},
		arguments:    []any{hiddenArgument},
	}

	status := sqlErr.Status()
	require.Equal(t, metav1.StatusFailure, status.Status)
	require.Equal(t, int32(http.StatusInternalServerError), status.Code)
	require.Equal(t, metav1.StatusReasonInternalError, status.Reason)
	require.Equal(t, db.StorageErrorMessage, status.Message)
	require.Nil(t, status.Details)

	// Nothing about the schema, the statement, the template file, the driver
	// or the arguments may appear in what the client is told.
	for _, forbidden := range []string{
		readTemplateName, ".sql", "query", "Query with", "SELECT", "INSERT",
		"FROM", "WHERE", "no such table", "SQL logic error", "guid",
		"namespace", "resource_version", "folder", hiddenArgument,
	} {
		require.NotContains(t, strings.ToLower(status.Message),
			strings.ToLower(forbidden),
			"client-facing message must not disclose %q", forbidden)
	}

	// The mapping resolves the status with errors.As, so it must be reachable
	// through the wrapping the SQL backend applies on the way out.
	var apistatus apierrors.APIStatus
	require.ErrorAs(t, fmt.Errorf("transactional operation: %w",
		error(sqlErr)), &apistatus)
	require.Equal(t, db.StorageErrorMessage, apistatus.Status().Message)
}

// capturedLogEntry is one message recorded by capturingLogger.
type capturedLogEntry struct {
	Level string
	Msg   string
	Args  map[string]any
}

// logSink collects the entries recorded by a capturingLogger and every logger
// derived from it with With, so a test holding the root logger sees everything
// that was logged through the chain.
type logSink struct {
	mu      sync.Mutex
	entries []capturedLogEntry
}

func (s *logSink) add(entry capturedLogEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append(s.entries, entry)
}

func (s *logSink) recorded() []capturedLogEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]capturedLogEntry{}, s.entries...)
}

// capturingLogger records what the package logs, so that the detail withheld
// from API clients can be asserted to reach the operator instead. It is
// injected through the context, so it observes only the operation under test
// even while other tests run in parallel.
type capturingLogger struct {
	sink *logSink
	args []any
}

func newCapturingLogger() *capturingLogger {
	return &capturingLogger{sink: &logSink{}}
}

func (l *capturingLogger) record(level, msg string) {
	args := make(map[string]any, len(l.args)/2)
	for i := 0; i+1 < len(l.args); i += 2 {
		key, ok := l.args[i].(string)
		if !ok {
			continue
		}
		args[key] = l.args[i+1]
	}
	l.sink.add(capturedLogEntry{Level: level, Msg: msg, Args: args})
}

func (l *capturingLogger) Debug(msg string, _ ...any) { l.record("debug", msg) }
func (l *capturingLogger) Info(msg string, _ ...any)  { l.record("info", msg) }
func (l *capturingLogger) Warn(msg string, _ ...any)  { l.record("warn", msg) }
func (l *capturingLogger) Error(msg string, _ ...any) { l.record("error", msg) }

func (l *capturingLogger) With(args ...any) logging.Logger {
	return &capturingLogger{
		sink: l.sink,
		args: append(append([]any{}, l.args...), args...),
	}
}

func (l *capturingLogger) WithContext(context.Context) logging.Logger { return l }

func (l *capturingLogger) recorded() []capturedLogEntry { return l.sink.recorded() }

// TestLogSQLFailure asserts the compensating control for the redacted client
// message: the query template, the call type, the statement and the driver
// error still reach the server log, the statement arguments never do, and
// outcomes that are not storage faults are logged below error level.
func TestLogSQLFailure(t *testing.T) {
	t.Parallel()

	const hiddenArgument = "obey, consume"
	driverErr := errors.New("SQL logic error: no such table: resource (1)")

	newSQLError := func(wrapped error) SQLError {
		return SQLError{
			Err:          wrapped,
			CallType:     "Query",
			TemplateName: readTemplateName,
			Query:        readQuery,
			RawQuery:     readQuery,
			ScanDest:     []any{new(string), new(string)},
			arguments:    []any{hiddenArgument, "default"},
		}
	}

	t.Run("a storage fault is logged at error level with the full detail", func(t *testing.T) {
		t.Parallel()

		logger := newCapturingLogger()
		ctx := logging.Context(testutil.NewDefaultTestContext(t), logger)

		logSQLFailure(ctx, newSQLError(driverErr))

		entries := logger.recorded()
		require.Len(t, entries, 1)
		require.Equal(t, "error", entries[0].Level)
		require.Equal(t, sqlFailureLogMsg, entries[0].Msg)
		require.Equal(t, loggerName, entries[0].Args["logger"])
		require.Equal(t, readTemplateName, entries[0].Args["template"])
		require.Equal(t, "Query", entries[0].Args["callType"])
		require.Equal(t, readQuery, entries[0].Args["query"])
		require.Equal(t, driverErr.Error(), entries[0].Args["error"])
		require.Equal(t, 2, entries[0].Args["inputArguments"])
		require.Equal(t, 2, entries[0].Args["outputDestinations"])

		// Counts are logged, values never are.
		for key, value := range entries[0].Args {
			require.NotEqual(t, hiddenArgument, value,
				"argument values must not be logged (key %q)", key)
		}
	})

	t.Run("database contention is logged as neither a fault nor a disconnect", func(t *testing.T) {
		t.Parallel()

		logger := newCapturingLogger()
		ctx := logging.Context(testutil.NewDefaultTestContext(t), logger)

		// The interrupted form of contention: an expired deadline that the
		// statement site recognised as a lost race for the database. Without
		// the marker this is logged at debug level as a client disconnect,
		// which is what kept live contention out of the server log.
		wrapped := fmt.Errorf("exec: %w", context.DeadlineExceeded)
		logSQLFailure(ctx, newSQLError(db.NewBusyError(wrapped)))

		entries := logger.recorded()
		require.Len(t, entries, 1)
		require.Equal(t, "warn", entries[0].Level,
			"contention is not a storage fault, but the operator must still see it")
		require.Equal(t, sqlFailureLogMsg, entries[0].Msg)
		require.Equal(t, readTemplateName, entries[0].Args["template"])
		require.Equal(t, wrapped.Error(), entries[0].Args["error"],
			"marking a failure must not change the logged text")

		for key, value := range entries[0].Args {
			require.NotEqual(t, hiddenArgument, value,
				"argument values must not be logged (key %q)", key)
		}
	})

	for _, tc := range []struct {
		name    string
		wrapped error
	}{
		{name: "no rows is not a storage fault", wrapped: sql.ErrNoRows},
		{name: "a cancelled request is not a storage fault", wrapped: context.Canceled},
		{name: "an unattributed expired deadline is not a storage fault", wrapped: context.DeadlineExceeded},
		// A duplicate row is how the backend detects that an object already
		// exists (IsRowAlreadyExistsError), so it answers 409 and is not a
		// fault. Logging it at error level would report every duplicate name
		// and every lost create race as a server error.
		{name: "a duplicate row is not a storage fault", wrapped: sqlite.ErrTestUniqueConstraintViolation},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logger := newCapturingLogger()
			ctx := logging.Context(testutil.NewDefaultTestContext(t), logger)

			logSQLFailure(ctx, newSQLError(fmt.Errorf("wrapped: %w", tc.wrapped)))

			entries := logger.recorded()
			require.Len(t, entries, 1)
			require.Equal(t, "debug", entries[0].Level)
			require.Equal(t, readTemplateName, entries[0].Args["template"])
		})
	}
}

// TestExecLogsFailures proves the logging is wired into the operations
// themselves, so no failure reaches a client redacted and unlogged.
func TestExecLogsFailures(t *testing.T) {
	t.Parallel()

	logger := newCapturingLogger()
	ctx := logging.Context(testutil.NewDefaultTestContext(t), logger)
	req := sqltemplateMocks.NewSQLTemplate(t)
	rdb := test.NewDBProviderNopSQL(t)

	req.EXPECT().DialectName().Return("test").Maybe()
	req.EXPECT().GetColNames().Return(nil).Maybe()
	req.EXPECT().Validate().Return(nil).Once()
	req.EXPECT().GetArgs().Return(nil)
	rdb.SQLMock.ExpectExec("").WillReturnError(errTest)

	res, err := Exec(ctx, rdb.DB, validTestTmpl, req)
	require.Zero(t, res)
	require.ErrorAs(t, err, new(SQLError))

	entries := logger.recorded()
	require.Len(t, entries, 1)
	require.Equal(t, "error", entries[0].Level)
	require.Equal(t, sqlFailureLogMsg, entries[0].Msg)
	require.Equal(t, "Exec", entries[0].Args["callType"])
	require.Equal(t, "test", entries[0].Args["template"])
	require.Equal(t, errTest.Error(), entries[0].Args["error"])
}

// TestQueryRowsLogsFailures is the read-path counterpart of
// TestExecLogsFailures.
func TestQueryRowsLogsFailures(t *testing.T) {
	t.Parallel()

	logger := newCapturingLogger()
	ctx := logging.Context(testutil.NewDefaultTestContext(t), logger)
	req := sqltemplateMocks.NewSQLTemplate(t)
	rdb := test.NewDBProviderNopSQL(t)

	req.EXPECT().DialectName().Return("test").Maybe()
	req.EXPECT().GetColNames().Return(nil).Maybe()
	req.EXPECT().Validate().Return(nil).Once()
	req.EXPECT().GetArgs().Return(nil)
	req.EXPECT().GetScanDest().Return(nil).Maybe()
	rdb.SQLMock.ExpectQuery("").WillReturnError(errTest)

	rows, err := QueryRows(ctx, rdb.DB, validTestTmpl, req)
	require.Nil(t, rows)
	require.ErrorAs(t, err, new(SQLError))

	entries := logger.recorded()
	require.Len(t, entries, 1)
	require.Equal(t, "error", entries[0].Level)
	require.Equal(t, "Query", entries[0].Args["callType"])
	require.Equal(t, errTest.Error(), entries[0].Args["error"])
}

// expectRows is a testing helper to keep mocks in sync when adding rows to a
// mocked SQL result.
type expectRows[T any] struct {
	*sqlmock.Rows
	ExpectedResults []T

	req *sqltemplateMocks.WithResults[T]
}

func newReturnsRow[T any](dbmock sqlmock.Sqlmock, req *sqltemplateMocks.WithResults[T]) *expectRows[T] {
	return &expectRows[T]{
		Rows: dbmock.NewRows(nil),
		req:  req,
	}
}

// Add adds a new value that should be returned by the `Query` or `QueryRow`
// operation.
func (r *expectRows[T]) Add(value T, err error) *expectRows[T] {
	r.req.EXPECT().GetScanDest().Return(nil).Once()
	r.req.EXPECT().Results().Return(value, err).Once()
	r.AddRow()
	r.ExpectedResults = append(r.ExpectedResults, value)

	return r
}

func TestQuery(t *testing.T) {
	t.Parallel()

	t.Run("happy path - no rows returned", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil)
		req.EXPECT().GetScanDest().Return(nil).Maybe()
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rdb.SQLMock.NewRows(nil))

		// execute and assert
		res, err := Query(ctx, rdb.DB, validTestTmpl, req)
		require.NoError(t, err)
		require.Zero(t, res)
	})

	t.Run("happy path - multiple rows returned", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows.Add(1, nil)
		rows.Add(2, nil)
		rows.Add(3, nil)
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows.Rows)

		// execute and assert
		res, err := Query(ctx, rdb.DB, validTestTmpl, req)
		require.NoError(t, err)
		require.NotZero(t, res)
		require.Equal(t, rows.ExpectedResults, res)
	})

	t.Run("invalid request", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(errTest).Once()

		// execute and assert
		res, err := Query(ctx, rdb.DB, invalidTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "invalid request")
	})

	t.Run("error executing template", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().Validate().Return(nil).Once()

		// execute and assert
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		res, err := Query(ctx, rdb.DB, invalidTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "execute template")
	})

	t.Run("error executing query", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil)
		req.EXPECT().GetScanDest().Return(nil).Maybe()
		rdb.SQLMock.ExpectQuery("").WillReturnError(errTest)

		// execute and assert
		res, err := Query(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorAs(t, err, new(SQLError))
	})

	t.Run("error decoding row", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows.Add(0, errTest)
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows.Rows)

		// execute and assert
		res, err := Query(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "scan value")
	})

	t.Run("error iterating rows", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows.AddRow() // we don't expect GetScanDest or Results here
		rows.RowError(0, errTest)
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows.Rows)

		// execute and assert
		res, err := Query(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "closing rows")
	})

	t.Run("too many result sets", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows1 := newReturnsRow(rdb.SQLMock, req)
		rows2 := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows1.Add(1, nil)
		rows2.AddRow() // we don't expect GetScanDest or Results here
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows1.Rows, rows2.Rows)

		// execute and assert
		res, err := Query(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "too many result sets")
	})
}

func TestQueryRow(t *testing.T) {
	t.Parallel()

	t.Run("happy path", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows.Add(1, nil)
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows.Rows)

		// execute and assert
		res, err := QueryRow(ctx, rdb.DB, validTestTmpl, req)
		require.NoError(t, err)
		require.Equal(t, rows.ExpectedResults[0], res)
	})

	t.Run("no rows returned", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rdb.SQLMock.NewRows(nil))

		// execute and assert
		res, err := QueryRow(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})

	t.Run("error executing query", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil)
		req.EXPECT().GetScanDest().Return(nil).Maybe()
		rdb.SQLMock.ExpectQuery("").WillReturnError(errTest)

		// execute and assert
		res, err := QueryRow(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorAs(t, err, new(SQLError))
	})

	t.Run("too many rows returned", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows.Add(1, nil)
		rows.Add(2, nil)
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows.Rows)

		// execute and assert
		res, err := QueryRow(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "expecting a single row")
	})

	t.Run("too many result sets", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewWithResults[int64](t)
		rdb := test.NewDBProviderNopSQL(t)
		rows1 := newReturnsRow(rdb.SQLMock, req)
		rows2 := newReturnsRow(rdb.SQLMock, req)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rows1.Add(1, nil)
		rows2.AddRow() // we don't expect GetScanDest or Results here
		rdb.SQLMock.ExpectQuery("").WillReturnRows(rows1.Rows, rows2.Rows)

		// execute and assert
		res, err := QueryRow(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "too many result sets")
	})
}

// scannerFunc is an adapter for the `scanner` interface.
type scannerFunc func(dest ...any) error

func (f scannerFunc) Scan(dest ...any) error {
	return f(dest...)
}

func TestScanRow(t *testing.T) {
	t.Parallel()

	const value int64 = 1

	t.Run("happy path", func(t *testing.T) {
		t.Parallel()

		// test declarations
		req := sqltemplateMocks.NewWithResults[int64](t)
		sc := scannerFunc(func(dest ...any) error {
			return nil
		})

		// setup expectations
		req.EXPECT().GetScanDest().Return(nil).Once()
		req.EXPECT().Results().Return(value, nil).Once()

		// execute and assert
		res, err := scanRow(sc, req)
		require.NoError(t, err)
		require.Equal(t, value, res)
	})

	t.Run("scan error", func(t *testing.T) {
		t.Parallel()

		// test declarations
		req := sqltemplateMocks.NewWithResults[int64](t)
		sc := scannerFunc(func(dest ...any) error {
			return errTest
		})

		// setup expectations
		req.EXPECT().GetScanDest().Return(nil).Once()

		// execute and assert
		res, err := scanRow(sc, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorIs(t, err, errTest)
	})

	t.Run("results error", func(t *testing.T) {
		t.Parallel()

		// test declarations
		req := sqltemplateMocks.NewWithResults[int64](t)
		sc := scannerFunc(func(dest ...any) error {
			return nil
		})

		// setup expectations
		req.EXPECT().GetScanDest().Return(nil).Once()
		req.EXPECT().Results().Return(0, errTest).Once()

		// execute and assert
		res, err := scanRow(sc, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorIs(t, err, errTest)
	})
}

func TestExec(t *testing.T) {
	t.Parallel()

	t.Run("happy path", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewSQLTemplate(t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil).Once()
		rdb.SQLMock.ExpectExec("").WillReturnResult(sqlmock.NewResult(0, 0))

		// execute and assert
		res, err := Exec(ctx, rdb.DB, validTestTmpl, req)
		require.NoError(t, err)
		require.NotZero(t, res)
	})

	t.Run("invalid request", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewSQLTemplate(t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(errTest).Once()

		// execute and assert
		res, err := Exec(ctx, rdb.DB, invalidTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "invalid request")
	})

	t.Run("error executing template", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewSQLTemplate(t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()

		// execute and assert
		res, err := Exec(ctx, rdb.DB, invalidTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorContains(t, err, "execute template")
	})

	t.Run("error executing SQL", func(t *testing.T) {
		t.Parallel()

		// test declarations
		ctx := testutil.NewDefaultTestContext(t)
		req := sqltemplateMocks.NewSQLTemplate(t)
		rdb := test.NewDBProviderNopSQL(t)

		// setup expectations
		req.EXPECT().DialectName().Return("test").Maybe()
		req.EXPECT().GetColNames().Return(nil).Maybe()
		req.EXPECT().Validate().Return(nil).Once()
		req.EXPECT().GetArgs().Return(nil)
		rdb.SQLMock.ExpectExec("").WillReturnError(errTest)

		// execute and assert
		res, err := Exec(ctx, rdb.DB, validTestTmpl, req)
		require.Zero(t, res)
		require.Error(t, err)
		require.ErrorAs(t, err, new(SQLError))
	})
}

// TestClassifyStatementError pins the classification of a statement failure as
// database contention, which is the only place the condition is still
// recognisable: the SQLite driver returns the context error in place of
// SQLITE_BUSY for a statement it interrupts, so an expired deadline plus the
// time the statement waited is all that is left of a lost race for the
// database.
func TestClassifyStatementError(t *testing.T) {
	t.Parallel()

	const sqliteDialect = "sqlite"
	longWait := sqlite.MinBusyWait + time.Millisecond
	deadlineErr := fmt.Errorf("exec: %w", context.DeadlineExceeded)

	testCases := []struct {
		name    string
		err     error
		dialect string
		waited  time.Duration
		want    bool
	}{
		{
			name:    "an interrupted busy wait is contention",
			err:     deadlineErr,
			dialect: sqliteDialect,
			waited:  longWait,
			want:    true,
		},
		{
			// The engines that report contention as a driver error keep the
			// generic envelope, so their slow statements are never relabelled.
			name:    "the same failure on postgres is not contention",
			err:     deadlineErr,
			dialect: "postgres",
			waited:  longWait,
			want:    false,
		},
		{
			name:    "the same failure on mysql is not contention",
			err:     deadlineErr,
			dialect: "mysql",
			waited:  longWait,
			want:    false,
		},
		{
			name:    "a deadline that expired without a wait is not contention",
			err:     deadlineErr,
			dialect: sqliteDialect,
			waited:  0,
			want:    false,
		},
		{
			name:    "a cancelled request is not contention",
			err:     fmt.Errorf("exec: %w", context.Canceled),
			dialect: sqliteDialect,
			waited:  longWait,
			want:    false,
		},
		{
			name:    "no rows is not contention",
			err:     sql.ErrNoRows,
			dialect: sqliteDialect,
			waited:  longWait,
			want:    false,
		},
		{
			name:    "a duplicate row is not contention",
			err:     sqlite.ErrTestUniqueConstraintViolation,
			dialect: sqliteDialect,
			waited:  longWait,
			want:    false,
		},
		{
			name:    "a generic failure is not contention",
			err:     errTest,
			dialect: sqliteDialect,
			waited:  longWait,
			want:    false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := classifyStatementError(tc.err, tc.dialect, tc.waited)
			require.ErrorIs(t, got, tc.err,
				"classification must never replace the error it classifies")
			require.Equal(t, tc.want, db.IsBusy(got))
			require.Equal(t, tc.err.Error(), got.Error(),
				"classification must not change the operator-facing text")

			var status metav1.Status
			if tc.want {
				status = db.StorageBusyStatus()
			} else {
				status = db.InternalStorageStatus()
			}
			require.Equal(t, status, db.StatusForError(got))
		})
	}

	require.NoError(t, classifyStatementError(nil, sqliteDialect, longWait),
		"a successful statement stays successful")
}

// newTestContext returns a test context with the given budget. The default test
// context expires in one second, which is the minimum wait the classification
// requires, so the tests below cannot use it: they either need a budget that
// outlasts a simulated busy wait, or a specific budget shorter than a real one.
func newTestContext(t *testing.T, budget time.Duration) testutil.TestContext {
	t.Helper()
	return testutil.NewTestContext(t, time.Now().Add(budget))
}

// newLongTestContext returns a test context whose deadline outlasts the busy
// wait the tests below simulate.
func newLongTestContext(t *testing.T) testutil.TestContext {
	t.Helper()
	return newTestContext(t, sqlite.MinBusyWait+30*time.Second)
}

// TestExecClassifiesContention proves the classification is wired into the
// write path, which is where the finding was observed: a POST that lost the
// race for the SQLite write lock reached the client as a generic internal
// error, because the driver error it was classified from no longer said the
// database was busy.
//
// The mocked driver returns the same error modernc.org/sqlite substitutes, and
// the delay stands in for the busy wait that the real driver spends inside the
// statement.
func TestExecClassifiesContention(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name      string
		driverErr error
		wantBusy  bool
		wantLevel string
	}{
		{
			name:      "an interrupted busy wait becomes retryable",
			driverErr: context.DeadlineExceeded,
			wantBusy:  true,
			wantLevel: "warn",
		},
		{
			// A client that hung up is not contention, however long the
			// statement had been running.
			name:      "a cancelled request stays generic",
			driverErr: context.Canceled,
			wantBusy:  false,
			wantLevel: "debug",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logger := newCapturingLogger()
			// The request budget has to outlast the statement: the failure
			// under test is a statement that waited on the database lock, not
			// a request that ran out of time on its way to the driver.
			ctx := logging.Context(newLongTestContext(t), logger)
			req := sqltemplateMocks.NewSQLTemplate(t)
			rdb := test.NewDBProviderNopSQL(t)

			req.EXPECT().DialectName().Return("sqlite").Maybe()
			req.EXPECT().GetColNames().Return(nil).Maybe()
			req.EXPECT().Validate().Return(nil).Once()
			req.EXPECT().GetArgs().Return(nil)
			rdb.SQLMock.ExpectExec("").
				WillDelayFor(sqlite.MinBusyWait + 50*time.Millisecond).
				WillReturnError(tc.driverErr)

			res, err := Exec(ctx, rdb.DB, validTestTmpl, req)
			require.Zero(t, res)
			require.ErrorAs(t, err, new(SQLError))
			require.ErrorIs(t, err, tc.driverErr,
				"the driver error must stay reachable for retry logic and for logging")
			require.Equal(t, tc.wantBusy, db.IsBusy(err))

			var apistatus apierrors.APIStatus
			require.ErrorAs(t, err, &apistatus)
			if tc.wantBusy {
				require.Equal(t, db.StorageBusyStatus(), apistatus.Status())
				require.Equal(t, metav1.StatusReasonServerTimeout, apistatus.Status().Reason)
				require.NotNil(t, apistatus.Status().Details)
				require.Equal(t, int32(1), apistatus.Status().Details.RetryAfterSeconds)
			} else {
				require.Equal(t, db.InternalStorageStatus(), apistatus.Status())
			}

			entries := logger.recorded()
			require.Len(t, entries, 1)
			require.Equal(t, tc.wantLevel, entries[0].Level)
			require.Equal(t, "Exec", entries[0].Args["callType"])
		})
	}
}

// TestQueryRowsClassifiesContention is the read-path counterpart: a reader is
// held by the same lock when the database is not in WAL mode, so the read path
// classifies the interrupted wait too.
func TestQueryRowsClassifiesContention(t *testing.T) {
	t.Parallel()

	logger := newCapturingLogger()
	ctx := logging.Context(newLongTestContext(t), logger)
	req := sqltemplateMocks.NewSQLTemplate(t)
	rdb := test.NewDBProviderNopSQL(t)

	req.EXPECT().DialectName().Return("sqlite").Maybe()
	req.EXPECT().GetColNames().Return(nil).Maybe()
	req.EXPECT().Validate().Return(nil).Once()
	req.EXPECT().GetArgs().Return(nil)
	req.EXPECT().GetScanDest().Return(nil).Maybe()
	rdb.SQLMock.ExpectQuery("").
		WillDelayFor(sqlite.MinBusyWait + 50*time.Millisecond).
		WillReturnError(context.DeadlineExceeded)

	rows, err := QueryRows(ctx, rdb.DB, validTestTmpl, req)
	require.Nil(t, rows)
	require.ErrorAs(t, err, new(SQLError))
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.True(t, db.IsBusy(err))

	var apistatus apierrors.APIStatus
	require.ErrorAs(t, err, &apistatus)
	require.Equal(t, db.StorageBusyStatus(), apistatus.Status())

	entries := logger.recorded()
	require.Len(t, entries, 1)
	require.Equal(t, "warn", entries[0].Level)
	require.Equal(t, "Query", entries[0].Args["callType"])
}

// TestExecClassifiesLiveContention is the whole chain the finding described,
// against a real database: another connection holds the write lock, the write
// runs inside a transaction whose deadline is shorter than the busy timeout —
// which is the relationship the resource version manager's batch deadline has
// with it — and the failure is checked in the shape the API surfaces receive
// it, after the transaction wrapper has added the rollback that database/sql
// already performed.
//
// It is the test that would have caught the finding: every part is real, so it
// fails if the driver stops substituting the context error, if the dialect name
// changes, if the wrapping order changes, or if the classification is dropped
// anywhere between the statement and the envelope.
func TestExecClassifiesLiveContention(t *testing.T) {
	t.Parallel()

	dsn := "file:" + filepath.Join(t.TempDir(), "contention.db")
	sqlDB, err := sql.Open("sqlite3", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	setupCtx := testutil.NewDefaultTestContext(t)
	_, err = sqlDB.ExecContext(setupCtx, "CREATE TABLE resource (guid TEXT)")
	require.NoError(t, err)

	var busyTimeoutMS int64
	require.NoError(t, sqlDB.QueryRowContext(setupCtx, "PRAGMA busy_timeout").Scan(&busyTimeoutMS))
	busyTimeout := time.Duration(busyTimeoutMS) * time.Millisecond
	require.Greater(t, busyTimeout, sqlite.MinBusyWait,
		"the connection's busy timeout must exceed the minimum attributable wait")

	// The external writer whose transaction the request loses the race to.
	holderDB, err := sql.Open("sqlite3", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, holderDB.Close()) })
	holder, err := holderDB.Conn(setupCtx)
	require.NoError(t, err)
	_, err = holder.ExecContext(setupCtx, "BEGIN IMMEDIATE")
	require.NoError(t, err)
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		_, err := holder.ExecContext(context.Background(), "ROLLBACK")
		require.NoError(t, err)
		require.NoError(t, holder.Close())
	}
	defer release()

	logger := newCapturingLogger()
	// A transaction deadline shorter than the busy timeout is what erases the
	// driver's busy state, and it is the default relationship in the resource
	// version manager (a five second batch deadline against a 7.5 second busy
	// timeout).
	ctx := logging.Context(newTestContext(t, busyTimeout/4), logger)

	req := sqltemplateMocks.NewSQLTemplate(t)
	req.EXPECT().DialectName().Return(sqltemplate.SQLite.DialectName()).Maybe()
	req.EXPECT().GetColNames().Return(nil).Maybe()
	req.EXPECT().Validate().Return(nil).Once()
	req.EXPECT().GetArgs().Return([]any{"guid-1"}).Once()

	insertTmpl := template.Must(template.New("resource_insert.sql").
		Parse("INSERT INTO resource (guid) VALUES (?)"))

	rdb := dbimpl.NewDB(sqlDB, "sqlite3")
	err = rdb.WithTx(ctx, nil, func(ctx context.Context, tx db.Tx) error {
		_, err := Exec(ctx, tx, insertTmpl, req)
		return err
	})

	require.Error(t, err)
	require.ErrorIs(t, err, context.DeadlineExceeded,
		"the driver substitutes the context error for SQLITE_BUSY, which is the whole problem")
	require.False(t, sqlite.IsBusyOrLocked(err),
		"if the driver still reported its busy state there would be nothing to classify")
	require.True(t, db.IsBusy(err), "live contention must be recognised as such")

	// The envelope the API surfaces render, reached the way they reach it.
	var apistatus apierrors.APIStatus
	require.ErrorAs(t, err, &apistatus)
	status := apistatus.Status()
	require.Equal(t, metav1.StatusReasonServerTimeout, status.Reason)
	require.Equal(t, db.StorageBusyMessage, status.Message)
	require.Equal(t, int32(http.StatusInternalServerError), status.Code)
	require.NotNil(t, status.Details)
	require.Equal(t, int32(1), status.Details.RetryAfterSeconds)

	// The operator sees the detail the client does not.
	var contention []capturedLogEntry
	for _, entry := range logger.recorded() {
		if entry.Msg == sqlFailureLogMsg {
			contention = append(contention, entry)
		}
	}
	require.Len(t, contention, 1)
	require.Equal(t, "warn", contention[0].Level)
	require.Equal(t, "resource_insert.sql", contention[0].Args["template"])

	// Nothing was written: the transaction that lost the race left no row.
	release()
	var rows int
	require.NoError(t, sqlDB.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM resource").Scan(&rows))
	require.Zero(t, rows, "a write that lost the race must leave no partial row")
}

// TestIsUniqueViolation pins the classifier that both the "already exists"
// translation in the sql package and the failure logging here depend on.
func TestIsUniqueViolation(t *testing.T) {
	t.Parallel()

	require.True(t, IsUniqueViolation(sqlite.ErrTestUniqueConstraintViolation))
	require.True(t, IsUniqueViolation(fmt.Errorf("insert into resource: %w",
		sqlite.ErrTestUniqueConstraintViolation)),
		"the condition must be recognised through the wrapping the backend applies")
	require.False(t, IsUniqueViolation(errTest))
	require.False(t, IsUniqueViolation(sql.ErrNoRows))
	require.False(t, IsUniqueViolation(nil))
}
