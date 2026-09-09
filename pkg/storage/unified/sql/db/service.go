package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana-app-sdk/logging"

	"github.com/grafana/grafana/pkg/util/sqlite"
)

//go:generate mockery --with-expecter --name DB
//go:generate mockery --with-expecter --name Tx
//go:generate mockery --with-expecter --name Row
//go:generate mockery --with-expecter --name Rows
//go:generate mockery --with-expecter --exported --name result

// DBProvider provides access to a SQL Database.
type DBProvider interface {
	// Init initializes the SQL Database, running migrations if needed. It is
	// idempotent and thread-safe.
	Init(context.Context) (DB, error)
}

// DB is a thin abstraction on *sql.DB to allow mocking to provide better unit
// testing. We purposefully hide database operation methods that would use
// context.Background().
type DB interface {
	ContextExecer
	BeginTx(context.Context, *sql.TxOptions) (Tx, error)
	WithTx(context.Context, *sql.TxOptions, TxFunc) error
	PingContext(context.Context) error
	Stats() sql.DBStats
	DriverName() string
	SqlDB() *sql.DB
}

// TxFunc is a function that executes with access to a transaction. The context
// it receives is the same context used to create the transaction, and is
// provided so that a general prupose TxFunc is able to retrieve information
// from that context, and derive other contexts that may be used to run database
// operation methods accepting a context. A derived context can be used to
// request a specific database operation to take no more than a specific
// fraction of the remaining timeout of the transaction context, or to enrich
// the downstream observability layer with relevant information regarding the
// specific operation being carried out.
type TxFunc = func(context.Context, Tx) error

// Tx is a thin abstraction on *sql.Tx to allow mocking to provide better unit
// testing. We allow database operation methods that do not take a
// context.Context here since a Tx can only be obtained with DB.BeginTx, which
// already takes a context.Context.
type Tx interface {
	ContextExecer
	Commit() error
	Rollback() error
}

// ContextExecer is a set of database operation methods that take
// context.Context.
type ContextExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) Row
}

// Row is the set of methods from *sql.Row that we use.
type Row interface {
	Err() error
	Scan(dest ...any) error
}

// Rows is the set of methods from *sql.Rows that we use.
type Rows interface {
	Close() error
	Err() error
	Next() bool
	NextResultSet() bool
	Scan(dest ...any) error
}

// Result is the standard sql.Result interface, for convenience.
type Result = sql.Result

// result is needed for mockery, since it doesn't support type aliases.
//
//nolint:unused
type result interface {
	Result
}

// WithTxFunc is an adapter to be able to provide the DB.WithTx method as an
// embedded function.
type WithTxFunc func(context.Context, *sql.TxOptions, TxFunc) error

// WithTx implements the DB.WithTx method.
func (x WithTxFunc) WithTx(ctx context.Context, opts *sql.TxOptions, f TxFunc) error {
	return x(ctx, opts, f)
}

// BeginTxFunc is the signature of the DB.BeginTx method.
type BeginTxFunc = func(context.Context, *sql.TxOptions) (Tx, error)

// NewWithTxFunc provides implementations of DB an easy way to provide the
// DB.WithTx method.
// Example usage:
//
//	type myDB struct {
//		db.WithTxFunc // embedded so that `WithTx` is already provided
//		// other members...
//	}
//
//	func NewMyDB(/* options */) (db.DB, error) {
//		ret := new(myDB)
//		ret.WithTxFunc = db.NewWithTxFunc(ret.BeginTx)
//		// other initialization code ...
//		return ret, nil
//	}
func NewWithTxFunc(x BeginTxFunc) WithTxFunc {
	return WithTxFunc(
		func(ctx context.Context, opts *sql.TxOptions, f TxFunc) error {
			t, err := x(ctx, opts)
			if err != nil {
				// The transaction could not even be started, so this error
				// comes from the driver and never from caller code. Raw driver
				// text at this point can carry deployment detail (the DSN host
				// and port for the networked drivers, the authenticated user
				// name, lock state), so the client only learns that storage
				// failed while the operator gets the detail from the log.
				logTxFailure(ctx, beginStr, err)
				return Redact(fmt.Errorf(oneErrFmt, beginStr, err))
			}

			if err := f(ctx, t); err != nil {
				if rollbackErr := t.Rollback(); rollbackErr != nil {
					// Both errors are joined with %w, so errors.As reaches
					// either of them: whatever status the transactional
					// operation itself carries (a SQLError redaction, a
					// conflict, a not-found) still decides the client
					// envelope, which is why this is not redacted here.
					logTxFailure(ctx, rollbackStr, rollbackErr)
					return fmt.Errorf(twoErrFmt, txOpStr, err, rollbackStr,
						rollbackErr)
				}
				return fmt.Errorf(oneErrFmt, txOpStr, err)
			}

			if err = t.Commit(); err != nil {
				// As with begin, a commit failure is the driver's own, so it
				// is redacted for the client and logged for the operator.
				logTxFailure(ctx, commitStr, err)
				return Redact(fmt.Errorf(oneErrFmt, commitStr, err))
			}

			return nil
		},
	)
}

// StorageErrorMessage is the single client-facing message that unified storage
// presents for a failure originating in the SQL layer. It deliberately carries
// no schema, statement, query-template, driver or deployment detail: those
// reach the operator through the server log instead (see logTxFailure here and
// the failure logging in the dbutil package). Callers that need to tell such a
// failure apart from a client error can rely on the accompanying
// metav1.StatusReasonInternalError reason rather than on message text.
const StorageErrorMessage = "internal storage error"

// StorageBusyMessage is the client-facing message for a write that lost a race
// for the database rather than failing: the request was not served, but the
// same request will succeed once the lock clears. Like StorageErrorMessage it
// names neither the engine, the statement nor the schema.
const StorageBusyMessage = "storage is busy, please retry"

// storageBusyRetryAfterSeconds is the retry hint attached to a contention
// failure. One second is the smallest value metav1.StatusDetails can express,
// and it is what turns the response into a retryable one for clients: the API
// server renders a positive RetryAfterSeconds as the Retry-After header
// (apiserver/pkg/endpoints/handlers/responsewriters.ErrorNegotiated), and
// client-go retries a 5xx that carries one (rest.checkWait).
const storageBusyRetryAfterSeconds = 1

// InternalStorageStatus returns the generic, non-revealing metav1.Status that a
// SQL-layer failure presents to API clients. It is the one place where that
// envelope is defined, so the resource surface and the legacy REST surface —
// which both render whatever status the storage error carries — stay in sync.
func InternalStorageStatus() metav1.Status {
	return metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    http.StatusInternalServerError,
		Reason:  metav1.StatusReasonInternalError,
		Message: StorageErrorMessage,
	}
}

// StorageBusyStatus returns the envelope for a request that failed on database
// contention. It reports the condition the way Kubernetes reports a request the
// server could not serve right now — StatusReasonServerTimeout with a retry
// hint — so that a caller can tell a transient contention failure apart from a
// broken server without reading message text, which is exactly what the
// redaction of the driver error takes away.
func StorageBusyStatus() metav1.Status {
	return metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    http.StatusInternalServerError,
		Reason:  metav1.StatusReasonServerTimeout,
		Message: StorageBusyMessage,
		Details: &metav1.StatusDetails{
			RetryAfterSeconds: storageBusyRetryAfterSeconds,
		},
	}
}

// StatusForError picks the client-facing envelope for a database-layer error:
// the retryable contention envelope when the driver reports that the database
// was busy or locked, and the generic storage envelope otherwise.
//
// SQLite serializes writes, so a lock upgrade inside a deferred transaction can
// fail immediately even with busy_timeout set; the same condition used to be
// recognisable to callers only through the driver text that is now withheld
// from clients. Contention on the networked engines keeps the generic envelope,
// as it had no distinguishable client-facing shape before either.
func StatusForError(err error) metav1.Status {
	if sqlite.IsBusyOrLocked(err) {
		return StorageBusyStatus()
	}
	return InternalStorageStatus()
}

// apiStatusProvider is the structural equivalent of
// k8s.io/apimachinery/pkg/api/errors.APIStatus. It is redeclared here so that
// this package keeps depending on k8s.io/apimachinery/pkg/apis/meta/v1 only,
// and so that Redact can detect a status that an error already carries.
type apiStatusProvider interface {
	Status() metav1.Status
}

// redactedError hides the message of the error it wraps from API clients while
// leaving the error itself untouched for every other consumer: Error() still
// returns the full operator-facing text that the log and the tests expect, and
// Unwrap() keeps errors.Is/errors.As, driver-specific classification (for
// example pkg/util/sqlite.IsBusyOrLocked) and sql.ErrNoRows detection working.
// The Status method makes it satisfy k8s.io/apimachinery/pkg/api/errors
// APIStatus, which is what the unified storage error mapping prefers over the
// err.Error() fallback when building a client response.
type redactedError struct {
	err error
}

// Error returns the wrapped error verbatim. The redaction applies to the
// client-facing status only, never to logs or to error comparisons.
func (e redactedError) Error() string { return e.err.Error() }

// Unwrap exposes the wrapped error so that errors.Is and errors.As keep
// reaching the driver error underneath.
func (e redactedError) Unwrap() error { return e.err }

// Status implements the APIStatus contract with the storage envelope that fits
// the wrapped error: retryable when the database was busy, generic otherwise.
func (e redactedError) Status() metav1.Status { return StatusForError(e.err) }

// Redact returns err wrapped so that API clients receive the generic
// InternalStorageStatus envelope instead of the error's own text, while the
// error remains fully intact for logging and for errors.Is/errors.As.
//
// An error that already carries a status is returned unchanged: errors.As
// matches the outermost provider first, so wrapping one would replace a
// deliberate 404, 409 or 422 with a 500. For the same reason Redact must only
// be applied to errors that originate in the database layer itself, never to
// an error produced by caller code running inside a transaction.
func Redact(err error) error {
	if err == nil {
		return nil
	}
	var existing apiStatusProvider
	if errors.As(err, &existing) {
		return err
	}
	return redactedError{err: err}
}

// logTxFailure records the operator-facing detail of a failed transaction
// boundary operation. Client disconnects (context cancellation and deadline
// expiry) are expected outcomes rather than storage faults, so they are logged
// below error level to keep them from drowning real failures. No statement
// arguments are ever logged, since they may carry regulated information.
func logTxFailure(ctx context.Context, op string, err error) {
	logger := logging.FromContext(ctx).With(
		"logger", loggerName,
		"operation", op,
		"error", err.Error(),
	)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		logger.Debug(txFailureLogMsg)
		return
	}
	logger.Error(txFailureLogMsg)
}

// Constants that allow testing that the correct scenario was hit.
const (
	oneErrFmt = "%s: %w"
	twoErrFmt = oneErrFmt + "; " + oneErrFmt

	// keep the following ones in sync with the matching ones in
	// `service_test.go`.

	txOpStr     = "transactional operation"
	beginStr    = "begin"
	commitStr   = "commit"
	rollbackStr = "rollback"
)

const (
	// loggerName identifies this package in the server log, following the
	// naming already used by the unified storage SQL backend.
	loggerName = "unified-storage-sql"

	// txFailureLogMsg is a stable message so that a transaction boundary
	// failure can be alerted on without parsing the driver error.
	txFailureLogMsg = "transaction boundary operation failed"
)
