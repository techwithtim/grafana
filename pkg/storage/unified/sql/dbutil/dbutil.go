// Package dbutil provides utilities to perform common database operations and
// appropriate error handling.
package dbutil

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"text/template"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/lib/pq"
	"go.opentelemetry.io/otel/attribute"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana-app-sdk/logging"

	"github.com/grafana/grafana/pkg/storage/unified/sql/db"
	"github.com/grafana/grafana/pkg/storage/unified/sql/db/otel"
	"github.com/grafana/grafana/pkg/storage/unified/sql/sqltemplate"
	"github.com/grafana/grafana/pkg/util/sqlite"
)

const (
	otelAttrBaseKey         = "dbutil_"
	otelAttrTemplateNameKey = otelAttrBaseKey + "template"
	otelAttrDialectKey      = otelAttrBaseKey + "dialect"
)

const (
	// loggerName identifies this package in the server log, matching the name
	// used by the transaction boundary logging in the db package.
	loggerName = "unified-storage-sql"

	// sqlFailureLogMsg is a stable message so that a failed database operation
	// can be alerted on without parsing the driver error.
	sqlFailureLogMsg = "database operation failed"
)

func withOtelAttrs(ctx context.Context, tmplName, dialectName string) context.Context {
	return otel.SetAttributes(ctx,
		attribute.String(otelAttrTemplateNameKey, tmplName),
		attribute.String(otelAttrDialectKey, dialectName),
	)
}

// SQLError is an error returned by the database, which includes additionally
// debugging information about what was sent to the database.
type SQLError struct {
	Err          error
	CallType     string // either Query, QueryRow or Exec
	TemplateName string
	Query        string
	RawQuery     string
	ScanDest     []any

	// potentially regulated information is not exported and only directly
	// available for local testing and local debugging purposes, making sure it
	// is never marshaled to JSON or any other serialization.

	arguments []any
}

func (e SQLError) Unwrap() error {
	return e.Err
}

func (e SQLError) Error() string {
	return fmt.Sprintf("%s: %s with %d input arguments and %d output "+
		"destination arguments: %v; query: %s", e.TemplateName, e.CallType,
		len(e.arguments), len(e.ScanDest), e.Err, e.Query)
}

// Status implements k8s.io/apimachinery/pkg/api/errors.APIStatus so that the
// unified storage error mapping (resource.AsErrorResult) builds the client
// response from this generic envelope instead of falling back to Error(),
// whose text names the query template file, the executed statement and the
// tables and columns it touches. Everything Error() reports is operator-facing
// detail: it stays in the server log (see logSQLFailure) and never reaches an
// API client, on either the resource surface or the legacy REST surface.
//
// The receiver is a value because SQLError is returned by value, and the
// mapping resolves the status with errors.As, which therefore also finds it
// through the wrapping the SQL backend applies on the way out (for example
// fmt.Errorf("transactional operation: %w", err)).
//
// The envelope is chosen from the wrapped error: database contention keeps a
// retryable shape (see db.StatusForError, and classifyStatementError for the
// form of contention whose driver error is gone by the time it is wrapped),
// because withholding the driver text would otherwise leave a caller unable to
// tell a lost race for the database from a server that is actually broken.
func (e SQLError) Status() metav1.Status {
	return db.StatusForError(e.Err)
}

// Debug provides greater detail about the SQL error. It is defined on the same
// struct but on a test file so that the intention that its results should not
// be used in runtime code is very clear. The results could include PII or
// otherwise regulated information, hence this method is only available in
// tests, so that it can be used in local debugging only. Note that the error
// information may still be available through other means, like using the
// "reflect" package, so care must be taken not to ever expose these information
// in production.
func (e SQLError) Debug() string {
	scanDestStr := "(none)"
	if len(e.ScanDest) > 0 {
		format := "[%T" + strings.Repeat(", %T", len(e.ScanDest)-1) + "]"
		scanDestStr = fmt.Sprintf(format, e.ScanDest...)
	}

	return fmt.Sprintf("%s: %s: %v\n\tArguments (%d): %#v\n\tReturn Value "+
		"Types (%d): %s\n\tExecuted Query: %s\n\tRaw SQL Template Output: %s",
		e.TemplateName, e.CallType, e.Err, len(e.arguments), e.arguments,
		len(e.ScanDest), scanDestStr, e.Query, e.RawQuery)
}

// Debug is meant to provide greater debugging detail about certain errors. The
// returned error will either provide more detailed information or be the same
// original error, suitable only for local debugging. The details provided are
// not meant to be logged, since they could include PII or otherwise
// sensitive/confidential information. These information should only be used for
// local debugging with fake or otherwise non-regulated information.
func Debug(err error) error {
	var d interface{ Debug() string }
	if errors.As(err, &d) {
		return errors.New(d.Debug())
	}

	return err
}

// IsUniqueViolation reports whether err is the database rejecting a row because
// it already exists, for every driver unified storage supports.
//
// Unified storage uses that rejection as control flow rather than as a failure:
// the SQL backend turns it into resource.ErrResourceAlreadyExists, which the API
// surfaces as 409 AlreadyExists (see IsRowAlreadyExistsError in the sql package,
// which delegates here). It lives in this package because the failure logging
// below has to recognise the same condition, and the sql package imports this
// one, so this is the lowest point both can share.
func IsUniqueViolation(err error) bool {
	if sqlite.IsUniqueConstraintViolation(err) {
		return true
	}

	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		// https://www.postgresql.org/docs/current/errcodes-appendix.html
		return pg.Code == "23505" // unique_violation
	}

	var pqerr *pq.Error
	if errors.As(err, &pqerr) {
		// https://www.postgresql.org/docs/current/errcodes-appendix.html
		return pqerr.Code == "23505" // unique_violation
	}

	var mysqlerr *mysql.MySQLError
	if errors.As(err, &mysqlerr) {
		// https://dev.mysql.com/doc/mysql-errors/8.0/en/server-error-reference.html
		return mysqlerr.Number == 1062 // ER_DUP_ENTRY
	}

	return false
}

// classifyStatementError marks a statement failure that is database contention
// the driver could no longer report as such, so that everything above the
// statement — the client envelope through SQLError.Status, the failure logging
// below, and any retry logic reading db.IsBusy — classifies it as the lost race
// for the database it is.
//
// This is the last point at which the condition is recognisable. The SQLite
// driver interrupts a statement whose context expired and returns the context
// error in place of SQLITE_BUSY, so above here nothing distinguishes a write
// that sat waiting for the database write lock from any other expired deadline;
// what does distinguish it is how long the statement spent inside the driver,
// which only this call site measures (see sqlite.IsInterruptedBusyWait).
//
// The classification is deliberately confined to the SQLite dialect. The
// networked engines report their own contention as a driver error and keep the
// generic envelope, as they always have, so an ordinary slow statement against
// them is never relabelled by the wait it happens to have taken.
func classifyStatementError(err error, dialectName string, waited time.Duration) error {
	if err == nil || dialectName != sqltemplate.SQLite.DialectName() {
		return err
	}
	if !sqlite.IsInterruptedBusyWait(err, waited) {
		return err
	}
	return db.NewBusyError(err)
}

// logSQLFailure records the operator-facing detail of a failed database
// operation: the query template, the kind of call, the driver error and the
// executed statement, plus the argument and scan destination counts. This is
// the only place that detail is emitted now that it is withheld from the
// client, so it is logged where the failure happens rather than where the
// response is built.
//
// Three classes of wrapped error are not storage faults and are logged below
// error level so they cannot drown real failures: sql.ErrNoRows, which is the
// ordinary "object not found" outcome; context cancellation or deadline expiry,
// which are client disconnects; and a unique-constraint violation, which is how
// the backend detects that an object already exists and answers 409 — logging
// that at error level would report every duplicate name, and every write that
// loses a create race, as a server fault.
//
// Database contention is the one class between those two: the request was not
// served, so it cannot be silent like a client disconnect, but nothing is broken
// either, so reporting it as a fault would be wrong. It is logged at warning
// level, and it is matched before the deadline case below because the
// interrupted form of contention arrives as an expired deadline that is not a
// client disconnect at all.
//
// Statement arguments are never logged. They are the potentially regulated
// information that SQLError keeps unexported, and only Debug() — a local
// debugging aid — renders them.
func logSQLFailure(ctx context.Context, e SQLError) {
	logger := logging.FromContext(ctx).With(
		"logger", loggerName,
		"template", e.TemplateName,
		"callType", e.CallType,
		"inputArguments", len(e.arguments),
		"outputDestinations", len(e.ScanDest),
		"query", e.Query,
		"error", fmt.Sprintf("%v", e.Err),
	)

	switch {
	case errors.Is(e.Err, sql.ErrNoRows),
		errors.Is(e.Err, context.Canceled),
		IsUniqueViolation(e.Err):
		logger.Debug(sqlFailureLogMsg)
	case db.IsBusy(e.Err):
		logger.Warn(sqlFailureLogMsg)
	case errors.Is(e.Err, context.DeadlineExceeded):
		logger.Debug(sqlFailureLogMsg)
	default:
		logger.Error(sqlFailureLogMsg)
	}
}

// Exec uses `req` as input for a non-data returning query generated with
// `tmpl`, and executed in `x`.
func Exec(ctx context.Context, x db.ContextExecer, tmpl *template.Template, req sqltemplate.SQLTemplate) (db.Result, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("Exec: invalid request for template %q: %w",
			tmpl.Name(), err)
	}

	rawQuery, err := sqltemplate.Execute(tmpl, req)
	if err != nil {
		return nil, fmt.Errorf("execute template: %w", err)
	}
	query := sqltemplate.FormatSQL(rawQuery)

	args := req.GetArgs()
	dialectName := req.DialectName()
	ctx = withOtelAttrs(ctx, tmpl.Name(), dialectName)
	// The time the statement spends in the driver is what tells an interrupted
	// busy wait apart from any other expired deadline, so it is measured here,
	// where the statement runs, and classified before the error is wrapped.
	started := time.Now()
	res, err := x.ExecContext(ctx, query, args...)
	if err != nil {
		sqlErr := SQLError{
			Err:          classifyStatementError(err, dialectName, time.Since(started)),
			CallType:     "Exec",
			TemplateName: tmpl.Name(),
			arguments:    args,
			Query:        query,
			RawQuery:     rawQuery,
		}
		logSQLFailure(ctx, sqlErr)

		return nil, sqlErr
	}

	return res, nil
}

// Query uses `req` as input for a single-statement, set-returning query
// generated with `tmpl`, and executed in `x`.
func QueryRows(ctx context.Context, x db.ContextExecer, tmpl *template.Template, req sqltemplate.SQLTemplate) (db.Rows, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("Query: invalid request for template %q: %w",
			tmpl.Name(), err)
	}

	rawQuery, err := sqltemplate.Execute(tmpl, req)
	if err != nil {
		return nil, fmt.Errorf("execute template %q: %w", tmpl.Name(), err)
	}
	query := sqltemplate.FormatSQL(rawQuery)

	args := req.GetArgs()
	dialectName := req.DialectName()
	ctx = withOtelAttrs(ctx, tmpl.Name(), dialectName)
	// As in Exec: an interrupted busy wait is only recognisable from how long
	// the statement waited, so the read path measures it too. A reader is held
	// by the same lock when the database is not in WAL mode.
	started := time.Now()
	rows, err := x.QueryContext(ctx, query, args...)
	if err != nil {
		sqlErr := SQLError{
			Err:          classifyStatementError(err, dialectName, time.Since(started)),
			CallType:     "Query",
			TemplateName: tmpl.Name(),
			arguments:    args,
			ScanDest:     req.GetScanDest(),
			Query:        query,
			RawQuery:     rawQuery,
		}
		logSQLFailure(ctx, sqlErr)

		return nil, sqlErr
	}
	return rows, err
}

// Query uses `req` as input for a single-statement, set-returning query
// generated with `tmpl`, and executed in `x`. The `Results` method of `req`
// should return a deep copy since it will be used multiple times to decode each
// value. It returns an error if more than one result set is returned.
func Query[T any](ctx context.Context, x db.ContextExecer, tmpl *template.Template, req sqltemplate.WithResults[T]) ([]T, error) {
	rows, err := QueryRows(ctx, x, tmpl, req)
	if err != nil {
		return nil, err
	}

	defer func() {
		_ = rows.Close()
	}()

	var ret []T
	for rows.Next() {
		v, err := scanRow(rows, req)
		if err != nil {
			return nil, fmt.Errorf("scan value #%d: %w", len(ret)+1, err)
		}
		ret = append(ret, v)
	}

	discardedResultSets, err := DiscardRows(rows)
	if err != nil {
		return nil, fmt.Errorf("closing rows: %w", err)
	}
	if discardedResultSets > 1 {
		return nil, fmt.Errorf("too many result sets: %v", discardedResultSets)
	}

	return ret, nil
}

// QueryRow uses `req` as input and output for a single-statement, single-row
// returning query generated with `tmpl`, and executed in `x`. It returns
// sql.ErrNoRows if no rows are returned. It also returns an error if more than
// one row or result set is returned.
func QueryRow[T any](ctx context.Context, x db.ContextExecer, tmpl *template.Template, req sqltemplate.WithResults[T]) (T, error) {
	var zero T
	res, err := Query(ctx, x, tmpl, req)
	if err != nil {
		return zero, err
	}

	switch len(res) {
	case 0:
		return zero, sql.ErrNoRows
	case 1:
		return res[0], nil
	default:
		return zero, fmt.Errorf("expecting a single row, got %d", len(res))
	}
}

// DiscardRows discards all the ResultSets in the given db.Rows and returns
// the final rows error and the number of times NextResultSet was called. This
// is useful to check for errors in queries with multiple SQL statements where
// there is no interesting output, since some drivers may omit an error returned
// by a SQL statement found in a statement that is not the first one. Note that
// not all drivers support multi-statement calls, though.
func DiscardRows(rows db.Rows) (int, error) {
	discardedResultSets := 1
	for ; rows.NextResultSet(); discardedResultSets++ {
	}
	return discardedResultSets, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

// scanRow is used on db.Row and db.Rows, and is factored out here not to
// improving code reuse, but rather for ease of testing.
func scanRow[T any](sc scanner, req sqltemplate.WithResults[T]) (zero T, err error) {
	if err = sc.Scan(req.GetScanDest()...); err != nil {
		return zero, fmt.Errorf("row scan: %w", err)
	}

	res, err := req.Results()
	if err != nil {
		return zero, fmt.Errorf("row results: %w", err)
	}

	return res, nil
}
