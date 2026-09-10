package api

import (
	"context"
	"time"

	"github.com/grafana/grafana/pkg/infra/db"
)

const (
	// databaseHealthQuery reads a single row from a real table instead of evaluating the
	// constant expression "SELECT 1". A constant expression never touches storage — SQLite
	// compiles it with no transaction opcode — so on a pooled connection whose schema is
	// already loaded it is answered while the database is unreachable, and the probe reports
	// a healthy database throughout an outage in which every request path fails. Reading a
	// row forces the engine to open the database and take a read lock on every execution, so
	// a database that is present but denying access (exclusive lock, missing table, revoked
	// grant) fails the probe. migration_log is the migrator's own table
	// (pkg/services/sqlstore/migrator/migrator.go:122) and therefore exists in every migrated
	// Grafana database; the statement is valid on all dialects supported here (sqlite, mysql,
	// postgres). Only the returned error matters — an empty table is not a failure.
	databaseHealthQuery = "SELECT 1 FROM migration_log LIMIT 1"

	// databaseHealthProbeBudget bounds one probe, so that a database which accepts
	// connections but never answers them fails the probe instead of holding /api/health
	// open for as long as the caller is willing to wait. xorm executes the statement with
	// the session context (pkg/util/xorm/session_raw.go:61), so this deadline reaches the
	// query for every store that honours cancellation. A driver may still answer first
	// with an error of its own — SQLite waits out its busy timeout, 7.5s by default
	// (pkg/util/sqlite/sqlite_nocgo.go:68) — which is the wait a real request makes too,
	// so the probe fails on the same terms as the request path it is reporting on.
	databaseHealthProbeBudget = 5 * time.Second

	// databaseHealthCacheTTL is how long one probe result is served to further callers, so
	// that health traffic cannot amplify into database load. It also bounds how long a
	// recovered database keeps being reported as failing.
	databaseHealthCacheTTL = 5 * time.Second
)

// databaseHealthy reports whether the database is currently serving reads, caching the
// result for databaseHealthCacheTTL. It backs the "database" field of /api/health, so its
// answer is what health-driven orchestration acts on.
func (hs *HTTPServer) databaseHealthy(ctx context.Context) bool {
	const cacheKey = "db-healthy"

	if cached, found := hs.CacheService.Get(cacheKey); found {
		return cached.(bool)
	}

	probeCtx, cancel := context.WithTimeout(ctx, databaseHealthProbeBudget)
	defer cancel()

	err := hs.SQLStore.WithDbSession(probeCtx, func(session *db.Session) error {
		_, err := session.Query(databaseHealthQuery)
		return err
	})
	if err != nil {
		// A probe that failed because the caller went away says nothing about the database:
		// the request context is cancelled by a client that hung up or timed out, and the
		// query is aborted with it. Answer this request only — caching that verdict would
		// pin a false outage on every subsequent caller for the whole TTL — and stay quiet,
		// so that a client retrying /api/health with a short timeout cannot turn this
		// unauthenticated endpoint into a log flood.
		if ctx.Err() != nil {
			return false
		}

		hs.log.Warn("Database health probe failed", "query", databaseHealthQuery, "error", err)
	}
	healthy := err == nil

	hs.CacheService.Set(cacheKey, healthy, databaseHealthCacheTTL)
	return healthy
}
