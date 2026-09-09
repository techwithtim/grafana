// This is an external test package (`dbutil_test`) on purpose: it imports
// github.com/grafana/grafana/pkg/storage/unified/resource, which imports
// dbutil, so an internal test package here would be an import cycle. The
// external package lets the end-to-end contract that closes the storage error
// disclosure be asserted against the real error mapping rather than a copy of
// it.
package dbutil_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana/pkg/storage/unified/resource"
	"github.com/grafana/grafana/pkg/storage/unified/sql/db"
	"github.com/grafana/grafana/pkg/storage/unified/sql/dbutil"
	"github.com/grafana/grafana/pkg/util/sqlite"
)

// TestSQLErrorClientEnvelopeIsRedacted walks a SQLError through exactly the
// path a failing storage call takes on the way to an API client — the
// transactional wrapping applied by db.NewWithTxFunc, then
// resource.AsErrorResult, then resource.GetError, whose Status is what both the
// resource surface and the legacy REST surface serialize — and asserts that
// none of the internal detail survives the trip while the outcome is still a
// 500.
//
// The two cases are the shapes QA captured in real 500 response bodies: the
// read (Query) path with its full SELECT statement, and the write (Exec) path
// with its full INSERT statement.
func TestSQLErrorClientEnvelopeIsRedacted(t *testing.T) {
	t.Parallel()

	const readQuery = `SELECT "guid", "namespace", "group", "resource", "name", "folder", "resource_version", "value"
    FROM "resource"
    WHERE 1 = 1 AND "namespace" = ? AND "group" = ? AND "resource" = ? AND "name" = ?;`

	const insertQuery = `INSERT INTO "resource" ("guid", "group", "resource", "namespace", "name", "folder", "previous_resource_version", "value", "action") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`

	// Substrings that must never reach a client. They cover the query template
	// file name, the SQL verbs and clauses, the table and column identifiers
	// and the driver error text.
	forbidden := []string{
		".sql", "resource_read.sql", "resource_insert.sql",
		"query:", "select", "insert", "from", "where", "values",
		"guid", "resource_version", "previous_resource_version", "folder",
		"no such table", "sql logic error",
		"input arguments", "output destination arguments",
	}

	for _, tc := range []struct {
		name  string
		inner error
	}{
		{
			name: "read path",
			inner: dbutil.SQLError{
				Err:          errors.New("SQL logic error: no such table: resource (1)"),
				CallType:     "Query",
				TemplateName: "resource_read.sql",
				Query:        readQuery,
				RawQuery:     readQuery,
				ScanDest:     []any{new(string), new(string), new(string), new(string), new(string), new(string), new(int64), new([]byte)},
			},
		},
		{
			name: "write path",
			inner: dbutil.SQLError{
				Err:          errors.New("SQL logic error: no such table: resource (1)"),
				CallType:     "Exec",
				TemplateName: "resource_insert.sql",
				Query:        insertQuery,
				RawQuery:     insertQuery,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// The SQL backend surfaces the error through this wrapping, and
			// then converts it with AsErrorResult.
			wrapped := fmt.Errorf("transactional operation: %w", tc.inner)
			require.Contains(t, wrapped.Error(), ".sql",
				"the operator-facing error must keep its detail")

			res := resource.AsErrorResult(wrapped)
			require.NotNil(t, res)
			require.Equal(t, int32(http.StatusInternalServerError), res.Code)
			require.Equal(t, string(metav1.StatusReasonInternalError), res.Reason)
			require.Equal(t, db.StorageErrorMessage, res.Message)
			require.Nil(t, res.Details)

			// GetError builds the metav1.Status that is serialized to the
			// client on both API surfaces.
			clientErr := resource.GetError(res)
			require.Error(t, clientErr)
			require.True(t, apierrors.IsInternalError(clientErr))

			var apistatus apierrors.APIStatus
			require.ErrorAs(t, clientErr, &apistatus)
			status := apistatus.Status()
			require.Equal(t, int32(http.StatusInternalServerError), status.Code)
			require.Equal(t, db.StorageErrorMessage, status.Message)

			// Assert against the serialized envelope, which is what a client
			// actually receives, so a leak through any status field is caught.
			body, err := json.Marshal(status)
			require.NoError(t, err)
			t.Logf("client-facing response body: %s", body)
			lowered := strings.ToLower(string(body))
			for _, f := range forbidden {
				require.NotContains(t, lowered, f,
					"client response body must not disclose %q: %s", f, body)
			}
		})
	}
}

// TestSQLErrorContentionEnvelopeStaysRetryable walks a lost race for the
// database through the same mapping and asserts the client can still recognise
// it as transient without reading message text.
//
// This is the compensating half of the redaction. A caller used to detect
// contention by finding "database is locked" or "SQLITE_BUSY" in the message —
// pkg/tests/apis/helper.go and apps/provisioning/pkg/controller/status.go both
// do — and that text is now withheld. The reason and the retry hint carry the
// same information structurally: the API server renders a positive
// RetryAfterSeconds as the Retry-After header, and client-go retries a 5xx that
// carries one, so a contended write is retried by every client-go caller
// without any of them parsing a message.
func TestSQLErrorContentionEnvelopeStaysRetryable(t *testing.T) {
	t.Parallel()

	sqlErr := dbutil.SQLError{
		Err:          fmt.Errorf("write failed: %w", sqlite.ErrTestBusy),
		CallType:     "Exec",
		TemplateName: "resource_insert.sql",
		Query:        `INSERT INTO "resource" ("guid") VALUES (?);`,
	}
	wrapped := fmt.Errorf("transactional operation: %w", error(sqlErr))

	require.ErrorIs(t, wrapped, sqlite.ErrTestBusy,
		"retry logic below the API boundary keeps classifying the driver error")

	res := resource.AsErrorResult(wrapped)
	require.Equal(t, int32(http.StatusInternalServerError), res.Code)
	require.Equal(t, string(metav1.StatusReasonServerTimeout), res.Reason)
	require.Equal(t, db.StorageBusyMessage, res.Message)
	require.NotNil(t, res.Details)
	require.Positive(t, res.Details.RetryAfterSeconds)

	clientErr := resource.GetError(res)
	require.True(t, apierrors.IsServerTimeout(clientErr))
	delay, ok := apierrors.SuggestsClientDelay(clientErr)
	require.True(t, ok, "the client must be told it may retry")
	require.Positive(t, delay)

	body, err := json.Marshal(clientErr.(apierrors.APIStatus).Status())
	require.NoError(t, err)
	t.Logf("client-facing response body: %s", body)
	lowered := strings.ToLower(string(body))
	// "busy" is the condition the message deliberately names; what must not
	// appear is the engine, the statement, the schema or the template.
	for _, f := range []string{".sql", "resource_insert", "insert", "guid", "query:", "sqlite", "locked", "write failed"} {
		require.NotContains(t, lowered, f,
			"a contention response must disclose no more than a generic one: %q in %s", f, body)
	}
}

// TestTransactionBoundaryClientEnvelopeIsRedacted covers the begin and commit
// failures wrapped in db.NewWithTxFunc: those carry raw driver text (lock
// state, and for the networked drivers the DSN host, port and user name), so
// they are redacted for the client in the same way while the detail stays in
// the error for the log.
func TestTransactionBoundaryClientEnvelopeIsRedacted(t *testing.T) {
	t.Parallel()

	driverErr := errors.New(`pq: password authentication failed for user "grafana" (host=db.internal:5432)`)
	wrapped := db.Redact(fmt.Errorf("%s: %w", "begin", driverErr))

	require.ErrorIs(t, wrapped, driverErr)
	require.Contains(t, wrapped.Error(), "db.internal:5432",
		"the operator-facing error must keep its detail")

	res := resource.AsErrorResult(wrapped)
	require.Equal(t, int32(http.StatusInternalServerError), res.Code)
	require.Equal(t, string(metav1.StatusReasonInternalError), res.Reason)
	require.Equal(t, db.StorageErrorMessage, res.Message)

	body, err := json.Marshal(resource.GetError(res).(apierrors.APIStatus).Status())
	require.NoError(t, err)
	lowered := strings.ToLower(string(body))
	for _, f := range []string{"password", "grafana", "db.internal", "5432", "pq:"} {
		require.NotContains(t, lowered, f,
			"client response body must not disclose %q: %s", f, body)
	}
}
