package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/infra/db/dbtest"
	"github.com/grafana/grafana/pkg/infra/localcache"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/sqlstore"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/grafana/grafana/pkg/util/testutil"
	"github.com/grafana/grafana/pkg/web"
)

func TestHealthAPI_Version(t *testing.T) {
	m, _ := setupHealthAPITestEnvironment(t, func(cfg *setting.Cfg) {
		cfg.BuildVersion = "7.4.0"
		cfg.BuildCommit = "59906ab1bf"
	})

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 200, rec.Code)
	expectedBody := `
		{
			"database": "ok",
			"version": "7.4.0",
			"commit": "59906ab1bf"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())
}

func TestHealthAPI_VersionEnterprise(t *testing.T) {
	m, _ := setupHealthAPITestEnvironment(t, func(cfg *setting.Cfg) {
		cfg.BuildVersion = "7.4.0"
		cfg.EnterpriseBuildCommit = "22206ab1be"
		cfg.BuildCommit = "59906ab1bf"
	})

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 200, rec.Code)
	expectedBody := `
		{
			"database": "ok",
			"enterpriseCommit": "22206ab1be",
			"version": "7.4.0",
			"commit": "59906ab1bf"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())
}

func TestHealthAPI_AnonymousHideVersion(t *testing.T) {
	m, hs := setupHealthAPITestEnvironment(t)
	hs.Cfg.Anonymous.HideVersion = true

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 200, rec.Code)
	expectedBody := `
		{
			"database": "ok"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())
}

func TestHealthAPI_DatabaseHealthy(t *testing.T) {
	const cacheKey = "db-healthy"

	m, hs := setupHealthAPITestEnvironment(t)
	hs.Cfg.Anonymous.HideVersion = true

	healthy, found := hs.CacheService.Get(cacheKey)
	require.False(t, found)
	require.Nil(t, healthy)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 200, rec.Code)
	expectedBody := `
		{
			"database": "ok"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())

	healthy, found = hs.CacheService.Get(cacheKey)
	require.True(t, found)
	require.True(t, healthy.(bool))
}

func TestHealthAPI_DatabaseUnhealthy(t *testing.T) {
	const cacheKey = "db-healthy"

	m, hs := setupHealthAPITestEnvironment(t)
	hs.Cfg.Anonymous.HideVersion = true
	hs.SQLStore.(*dbtest.FakeDB).ExpectedError = errors.New("bad")

	healthy, found := hs.CacheService.Get(cacheKey)
	require.False(t, found)
	require.Nil(t, healthy)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 503, rec.Code)
	expectedBody := `
		{
			"database": "failing"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())

	healthy, found = hs.CacheService.Get(cacheKey)
	require.True(t, found)
	require.False(t, healthy.(bool))
}

func TestHealthAPI_DatabaseHealthCached(t *testing.T) {
	const cacheKey = "db-healthy"

	m, hs := setupHealthAPITestEnvironment(t)
	hs.Cfg.Anonymous.HideVersion = true

	// Mock unhealthy database in cache.
	hs.CacheService.Set(cacheKey, false, 5*time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 503, rec.Code)
	expectedBody := `
		{
			"database": "failing"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())

	// Purge cache and redo request.
	hs.CacheService.Delete(cacheKey)
	rec = httptest.NewRecorder()
	m.ServeHTTP(rec, req)

	require.Equal(t, 200, rec.Code)
	expectedBody = `
		{
			"database": "ok"
		}
	`
	require.JSONEq(t, expectedBody, rec.Body.String())

	healthy, found := hs.CacheService.Get(cacheKey)
	require.True(t, found)
	require.True(t, healthy.(bool))
}

func setupHealthAPITestEnvironment(t *testing.T, cbs ...func(*setting.Cfg)) (*web.Mux, *HTTPServer) {
	t.Helper()

	return setupHealthAPITestEnvironmentWithStore(t, dbtest.NewFakeDB(), cbs...)
}

// setupHealthAPITestEnvironmentWithStore builds the same environment against a
// caller-supplied store, so the database probe can be exercised against a real database
// and against fakes that observe the context it is given.
func setupHealthAPITestEnvironmentWithStore(t *testing.T, store db.DB, cbs ...func(*setting.Cfg)) (*web.Mux, *HTTPServer) {
	t.Helper()

	m := web.New()
	cfg := setting.NewCfg()
	for _, cb := range cbs {
		cb(cfg)
	}
	hs := &HTTPServer{
		CacheService: localcache.New(5*time.Minute, 10*time.Minute),
		Cfg:          cfg,
		SQLStore:     store,
		// databaseHealthy logs a failed probe, and an unset logger is a nil interface.
		log: log.New("health-api-test"),
	}

	m.Get("/api/health", hs.apiHealthHandler)
	return m, hs
}

// probeHealthAPI issues one GET /api/health request through the mux with the given
// request context and returns the recorded response.
func probeHealthAPI(t *testing.T, m *web.Mux, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)
	return rec
}

// TestIntegrationHealthAPI_DatabaseStorageDenied is the regression test for a health
// endpoint that reported "database": "ok" throughout a storage outage in which every
// database-backed request failed. It runs against a real, migrated database and denies
// access to the table the probe reads, which is the state a constant-expression probe
// cannot see (step three asserts that "SELECT 1" still succeeds against the same broken
// store, so reverting the probe to it fails this test).
func TestIntegrationHealthAPI_DatabaseStorageDenied(t *testing.T) {
	testutil.SkipIntegrationTestInShortMode(t)

	const cacheKey = "db-healthy"

	store := db.NewTestStore(t)
	m, hs := setupHealthAPITestEnvironmentWithStore(t, store, func(cfg *setting.Cfg) {
		cfg.Anonymous.HideVersion = true
	})

	renameTable := func(from, to string) error {
		return store.WithDbSession(context.Background(), func(session *db.Session) error {
			// Identifiers are literals from this test, quoted for the active dialect.
			_, err := session.Exec(fmt.Sprintf("ALTER TABLE %s RENAME TO %s", store.Quote(from), store.Quote(to)))
			return err
		})
	}

	// A healthy, migrated database reports ok.
	rec := probeHealthAPI(t, m, context.Background())
	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{"database": "ok"}`, rec.Body.String())

	// Deny access to the storage the probe reads, through the very store the server holds.
	require.NoError(t, renameTable("migration_log", "migration_log_hidden"))
	tableHidden := true
	t.Cleanup(func() {
		if tableHidden {
			require.NoError(t, renameTable("migration_log_hidden", "migration_log"))
		}
	})

	// The root cause of the finding: a constant expression is answered by the engine
	// without reading storage, so it succeeds on a store that can serve nothing.
	require.NoError(t, store.WithDbSession(context.Background(), func(session *db.Session) error {
		_, err := session.Query("SELECT 1")
		return err
	}), `"SELECT 1" still succeeds against the denied store, so the probe must read a real table`)

	hs.CacheService.Delete(cacheKey)
	rec = probeHealthAPI(t, m, context.Background())
	require.Equal(t, 503, rec.Code)
	require.JSONEq(t, `{"database": "failing"}`, rec.Body.String())

	cached, found := hs.CacheService.Get(cacheKey)
	require.True(t, found)
	require.False(t, cached.(bool))

	// Restoring storage restores health without a restart.
	require.NoError(t, renameTable("migration_log_hidden", "migration_log"))
	tableHidden = false

	hs.CacheService.Delete(cacheKey)
	rec = probeHealthAPI(t, m, context.Background())
	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{"database": "ok"}`, rec.Body.String())

	cached, found = hs.CacheService.Get(cacheKey)
	require.True(t, found)
	require.True(t, cached.(bool))
}

// deadlineRecordingDB records the context the database probe hands to the store. It
// embeds *dbtest.FakeDB, whose WithDbSession returns ExpectedError without invoking the
// callback, so the recorded context is the probe's own with no database involved.
type deadlineRecordingDB struct {
	*dbtest.FakeDB

	mu          sync.Mutex
	calls       int
	deadline    time.Time
	hasDeadline bool
}

func (f *deadlineRecordingDB) WithDbSession(ctx context.Context, callback sqlstore.DBTransactionFunc) error {
	f.mu.Lock()
	f.calls++
	f.deadline, f.hasDeadline = ctx.Deadline()
	f.mu.Unlock()

	return f.FakeDB.WithDbSession(ctx, callback)
}

func TestHealthAPI_DatabaseProbeIsBounded(t *testing.T) {
	store := &deadlineRecordingDB{FakeDB: dbtest.NewFakeDB()}
	m, _ := setupHealthAPITestEnvironmentWithStore(t, store, func(cfg *setting.Cfg) {
		cfg.Anonymous.HideVersion = true
	})

	before := time.Now()
	rec := probeHealthAPI(t, m, context.Background())
	after := time.Now()

	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{"database": "ok"}`, rec.Body.String())

	store.mu.Lock()
	defer store.mu.Unlock()

	require.Equal(t, 1, store.calls)
	require.True(t, store.hasDeadline, "the database probe must run under a deadline")
	// The deadline was taken at some instant within the request, so it lies in
	// [before+budget, after+budget]: set, and no further out than the probe budget.
	require.WithinRange(t, store.deadline, before.Add(databaseHealthProbeBudget), after.Add(databaseHealthProbeBudget))
}

func TestHealthAPI_DatabaseProbeNotCachedWhenRequestCancelled(t *testing.T) {
	const cacheKey = "db-healthy"

	m, hs := setupHealthAPITestEnvironment(t, func(cfg *setting.Cfg) {
		cfg.Anonymous.HideVersion = true
	})
	hs.SQLStore.(*dbtest.FakeDB).ExpectedError = context.Canceled

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	rec := probeHealthAPI(t, m, ctx)

	require.Equal(t, 503, rec.Code)
	require.JSONEq(t, `{"database": "failing"}`, rec.Body.String())

	cached, found := hs.CacheService.Get(cacheKey)
	require.False(t, found, "a probe cut short by its caller must not pin a failure in the cache")
	require.Nil(t, cached)
}
