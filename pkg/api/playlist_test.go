package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	clientrest "k8s.io/client-go/rest"

	playlistv1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
	"github.com/grafana/grafana/pkg/apimachinery/errutil"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/registry/apps/playlist"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/services/user"
	"github.com/grafana/grafana/pkg/web"
)

// The deprecated /api/playlists handlers proxy to the resource API through a dynamic
// client, so these tests assert on the two things that are entirely the handlers'
// own responsibility: which requests are allowed to reach the API server, and the
// shape of the error body written back. Every legacy playlist error must be
// {"message":…,"traceID":…} -- see writeError and playlistUID.

// playlistTestResponse is one queued answer from the fake API server. Status and body
// travel together because the paged-list tests need a later page to fail with its own
// status while the earlier pages succeed.
type playlistTestResponse struct {
	statusCode int
	body       []byte
}

// playlistTestTransport stands in for the API server. It records the requests that
// reached it -- which is how the tests below prove a malformed uid is rejected before
// any request is built, and how the paged-list tests read back the limit and continue
// parameters the handler sent -- and answers each one with a canned response.
type playlistTestTransport struct {
	statusCode   int
	responseBody []byte
	// responses is an optional queue served one entry per request, in order, for the
	// tests that walk a paged list. While it is empty -- which is always the case for
	// the single-response tests -- every request is answered with statusCode and
	// responseBody instead.
	responses []playlistTestResponse
	requests  []*http.Request
}

func (t *playlistTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.requests = append(t.requests, req)
	statusCode, body := t.statusCode, t.responseBody
	if len(t.responses) > 0 {
		statusCode, body = t.responses[0].statusCode, t.responses[0].body
		t.responses = t.responses[1:]
	}
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	return &http.Response{
		StatusCode: statusCode,
		Header:     header,
		Body:       io.NopCloser(bytes.NewReader(body)),
		Request:    req,
	}, nil
}

type playlistTestConfigProvider struct {
	transport http.RoundTripper
}

func (p *playlistTestConfigProvider) GetDirectRestConfig(c *contextmodel.ReqContext) *clientrest.Config {
	return &clientrest.Config{Host: "http://localhost", Transport: p.transport}
}

func (p *playlistTestConfigProvider) DirectlyServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (p *playlistTestConfigProvider) IsReady() bool { return true }

func newPlaylistTestHandler(transport http.RoundTripper) *playlistK8sHandler {
	return &playlistK8sHandler{
		gvr:                  playlistv1.PlaylistKind().GroupVersionResource(),
		namespacer:           func(int64) string { return "default" },
		clientConfigProvider: &playlistTestConfigProvider{transport: transport},
	}
}

// newPlaylistTestContext builds the minimal ReqContext the handlers use: route
// parameters, a response recorder and a logger for JsonApiErr.
func newPlaylistTestContext(t *testing.T, method, target string, params map[string]string, body []byte) (*contextmodel.ReqContext, *httptest.ResponseRecorder) {
	t.Helper()

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Content-Type", "application/json")
	if params != nil {
		req = web.SetURLParams(req, params)
	}
	recorder := httptest.NewRecorder()
	return &contextmodel.ReqContext{
		Context: &web.Context{
			Req:  req,
			Resp: web.NewResponseWriter(method, recorder),
		},
		SignedInUser: &user.SignedInUser{OrgID: 1},
		IsSignedIn:   true,
		Logger:       log.New("playlist-test"),
	}, recorder
}

// requireLegacyErrorEnvelope asserts the body is exactly the legacy playlist error
// envelope: a message and a traceID, and nothing else.
func requireLegacyErrorEnvelope(t *testing.T, raw []byte) map[string]any {
	t.Helper()

	body := map[string]any{}
	require.NoError(t, json.Unmarshal(raw, &body), "response body must be JSON: %s", string(raw))
	assert.ElementsMatch(t, []string{"message", "traceID"}, playlistTestBodyKeys(body), "body: %s", string(raw))
	return body
}

// playlistTestBodyKeys is named for this file rather than generically: package api is
// large and shared, and a helper called something like mapKeys would collide with the
// next test file that needs one.
func playlistTestBodyKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// playlistTestStored is one playlist as the resource API holds it, reduced to the two
// fields the legacy list conversion reads: the object name (the legacy uid) and
// spec.title (the legacy name, which the ?query= filter matches on).
type playlistTestStored struct {
	uid  string
	name string
}

// playlistTestListPage renders one chunk of a namespace exactly as the resource API
// returns it: a PlaylistList whose metadata.continue is populated when further chunks
// follow and absent on the last one. kind and apiVersion are mandatory -- the
// unstructured decoder rejects a body without a kind -- and every item needs
// spec.title and spec.interval because UnstructuredToLegacyPlaylist reads both without
// a type check.
func playlistTestListPage(t *testing.T, continueToken string, stored ...playlistTestStored) []byte {
	t.Helper()

	items := make([]any, 0, len(stored))
	for _, s := range stored {
		items = append(items, map[string]any{
			"apiVersion": "playlist.grafana.app/v1",
			"kind":       "Playlist",
			"metadata":   map[string]any{"name": s.uid},
			"spec": map[string]any{
				"title":    s.name,
				"interval": "5m",
				"items":    []any{},
			},
		})
	}

	metadata := map[string]any{}
	if continueToken != "" {
		metadata["continue"] = continueToken
	}
	page, err := json.Marshal(map[string]any{
		"apiVersion": "playlist.grafana.app/v1",
		"kind":       "PlaylistList",
		"metadata":   metadata,
		"items":      items,
	})
	require.NoError(t, err)
	return page
}

// playlistTestLegacyListBody renders what web.Context.JSON writes for a legacy list
// response: a bare JSON array of playlists with nothing wrapped around it. It mirrors
// the encoder's rules rather than hardcoding one of them, because web.Env decides
// whether the output is indented (DEV, the default under test) or compact (PROD, how
// the server runs) and the byte-for-byte comparison must hold either way.
func playlistTestLegacyListBody(t *testing.T, playlists []playlist.Playlist) string {
	t.Helper()

	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	if web.Env != web.PROD {
		enc.SetIndent("", "  ")
	}
	require.NoError(t, enc.Encode(playlists))
	return buf.String()
}

// playlistTestListedUIDs decodes a legacy list body and returns the uids in the order
// they were written, which is the order the pages arrived in.
func playlistTestListedUIDs(t *testing.T, raw []byte) []string {
	t.Helper()

	listed := []playlist.Playlist{}
	require.NoError(t, json.Unmarshal(raw, &listed), "response body must be a JSON array: %s", string(raw))
	uids := make([]string, 0, len(listed))
	for _, p := range listed {
		uids = append(uids, p.UID)
	}
	return uids
}

// The resource API chunks a list response once it outgrows its size budget, so a
// namespace can only be listed completely by following metadata.continue. These tests
// cover that walk on the deprecated endpoint: it has no pagination of its own, so a
// dropped chunk used to be indistinguishable from an empty namespace.
func TestPlaylistSearch(t *testing.T) {
	pageSize := fmt.Sprintf("%d", playlistSearchPageSize)

	t.Run("follows continue tokens until the namespace is exhausted", func(t *testing.T) {
		transport := &playlistTestTransport{
			// The trailing single-response fallback is deliberately a page that would
			// extend the walk: if the handler asked for a fourth page the request count
			// below would catch it.
			statusCode:   http.StatusOK,
			responseBody: playlistTestListPage(t, "tok-unexpected", playlistTestStored{uid: "extra", name: "Extra"}),
			responses: []playlistTestResponse{
				{statusCode: http.StatusOK, body: playlistTestListPage(t, "tok-1",
					playlistTestStored{uid: "uid-a", name: "A"}, playlistTestStored{uid: "uid-b", name: "B"})},
				{statusCode: http.StatusOK, body: playlistTestListPage(t, "tok-2",
					playlistTestStored{uid: "uid-c", name: "C"}, playlistTestStored{uid: "uid-d", name: "D"})},
				{statusCode: http.StatusOK, body: playlistTestListPage(t, "",
					playlistTestStored{uid: "uid-e", name: "E"})},
			},
		}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		require.Len(t, transport.requests, 3, "one request per page, and no request after the token is empty")

		first := transport.requests[0].URL.Query()
		assert.Equal(t, pageSize, first.Get("limit"), "every page is requested with the page size")
		assert.Empty(t, first.Get("continue"), "the first page starts the walk with no token")

		second := transport.requests[1].URL.Query()
		assert.Equal(t, pageSize, second.Get("limit"))
		assert.Equal(t, "tok-1", second.Get("continue"), "page two must carry page one's token")

		third := transport.requests[2].URL.Query()
		assert.Equal(t, pageSize, third.Get("limit"))
		assert.Equal(t, "tok-2", third.Get("continue"), "page three must carry page two's token")

		assert.Equal(t, []string{"uid-a", "uid-b", "uid-c", "uid-d", "uid-e"},
			playlistTestListedUIDs(t, recorder.Body.Bytes()), "every page's playlists, in server order")
		assert.Empty(t, recorder.Header().Get("Warning"), "a completed walk is not a truncated list")
	})

	t.Run("stops at the page cap and says the list is incomplete", func(t *testing.T) {
		// A server that never runs out of tokens. More pages are queued than the cap
		// allows, so the request count proves the cap stopped the walk rather than the
		// queue running dry.
		responses := make([]playlistTestResponse, 0, playlistSearchMaxPages+5)
		for i := 0; i < playlistSearchMaxPages+5; i++ {
			responses = append(responses, playlistTestResponse{
				statusCode: http.StatusOK,
				body: playlistTestListPage(t, fmt.Sprintf("tok-%d", i),
					playlistTestStored{uid: fmt.Sprintf("uid-%d", i), name: fmt.Sprintf("Playlist %d", i)}),
			})
		}
		transport := &playlistTestTransport{statusCode: http.StatusOK, responses: responses}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Len(t, transport.requests, playlistSearchMaxPages, "the walk must stop at the cap")

		warning := recorder.Header().Get("Warning")
		assert.Equal(t, playlistSearchTruncatedWarning, warning)
		assert.True(t, strings.HasPrefix(warning, `299 - "`), "warn-code 299 and a quoted text: %s", warning)
		assert.True(t, strings.HasSuffix(warning, `"`), "warn-code 299 and a quoted text: %s", warning)

		// Truncation is signalled out of band only: the body stays the bare array every
		// caller of this endpoint already parses.
		body := recorder.Body.Bytes()
		assert.Equal(t, byte('['), bytes.TrimSpace(body)[0], "body: %s", string(body))
		assert.Len(t, playlistTestListedUIDs(t, body), playlistSearchMaxPages,
			"the playlists gathered before the cap are still returned")
	})

	t.Run("stops when the server keeps handing back the same token", func(t *testing.T) {
		// A non-advancing token would loop forever if the handler only checked for an
		// empty one. Far more pages are queued than the two the handler should need.
		responses := make([]playlistTestResponse, 0, 5)
		for i := 0; i < 5; i++ {
			responses = append(responses, playlistTestResponse{
				statusCode: http.StatusOK,
				body: playlistTestListPage(t, "stuck-token",
					playlistTestStored{uid: fmt.Sprintf("uid-%d", i), name: fmt.Sprintf("Playlist %d", i)}),
			})
		}
		transport := &playlistTestTransport{statusCode: http.StatusOK, responses: responses}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Len(t, transport.requests, 2,
			"the second page returns the token it was sent, which ends the walk")
		assert.Equal(t, "stuck-token", transport.requests[1].URL.Query().Get("continue"))
		assert.Equal(t, playlistSearchTruncatedWarning, recorder.Header().Get("Warning"),
			"the walk ended with a token outstanding, so the list is incomplete")
		assert.Equal(t, []string{"uid-0", "uid-1"}, playlistTestListedUIDs(t, recorder.Body.Bytes()))
	})

	t.Run("a single page is one request and the same body as before", func(t *testing.T) {
		transport := &playlistTestTransport{
			statusCode: http.StatusOK,
			responseBody: playlistTestListPage(t, "",
				playlistTestStored{uid: "uid-a", name: "A"}, playlistTestStored{uid: "uid-b", name: "B"}),
		}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Len(t, transport.requests, 1, "no continue token means no second request")
		assert.Empty(t, recorder.Header().Get("Warning"))
		// The wire contract of this deprecated endpoint is a bare JSON array of legacy
		// playlists; paging must not have added an envelope, a field or a reordering.
		expected := playlistTestLegacyListBody(t, []playlist.Playlist{
			{UID: "uid-a", Name: "A", Interval: "5m"},
			{UID: "uid-b", Name: "B", Interval: "5m"},
		})
		assert.Equal(t, expected, recorder.Body.String())
	})

	t.Run("an empty namespace is still an empty array", func(t *testing.T) {
		transport := &playlistTestTransport{statusCode: http.StatusOK, responseBody: playlistTestListPage(t, "")}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Len(t, transport.requests, 1)
		assert.Empty(t, recorder.Header().Get("Warning"))
		assert.Equal(t, playlistTestLegacyListBody(t, []playlist.Playlist{}), recorder.Body.String())
	})

	t.Run("the name filter applies to every page, not just the first", func(t *testing.T) {
		transport := &playlistTestTransport{
			statusCode: http.StatusOK,
			responses: []playlistTestResponse{
				{statusCode: http.StatusOK, body: playlistTestListPage(t, "tok-1",
					playlistTestStored{uid: "uid-a", name: "Alpha one"},
					playlistTestStored{uid: "uid-b", name: "Beta"})},
				{statusCode: http.StatusOK, body: playlistTestListPage(t, "",
					playlistTestStored{uid: "uid-c", name: "second ALPHA"},
					playlistTestStored{uid: "uid-d", name: "Gamma"})},
			},
		}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists?query=alpha", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		require.Len(t, transport.requests, 2, "the filter is applied client-side, so every page is still fetched")
		// The filter is case-insensitive and matches a substring, on both pages.
		assert.Equal(t, []string{"uid-a", "uid-c"}, playlistTestListedUIDs(t, recorder.Body.Bytes()))
		assert.Empty(t, recorder.Header().Get("Warning"))
	})

	t.Run("a list failure on a later page answers in the legacy envelope", func(t *testing.T) {
		// Paging turns one list call into several, so the error path has to hold for a
		// page other than the first: the caller must still get {message, traceID} and
		// never a partial 200 body.
		failure := []byte(`{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure",` +
			`"message":"etcdserver: request timed out","reason":"InternalError","code":500}`)
		transport := &playlistTestTransport{
			statusCode: http.StatusOK,
			responses: []playlistTestResponse{
				{statusCode: http.StatusOK, body: playlistTestListPage(t, "tok-1",
					playlistTestStored{uid: "uid-a", name: "A"})},
				{statusCode: http.StatusInternalServerError, body: failure},
			},
		}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists", nil, nil)

		handler.searchPlaylists(c)

		assert.Equal(t, http.StatusInternalServerError, recorder.Code)
		require.Len(t, transport.requests, 2)
		body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
		assert.Equal(t, "etcdserver: request timed out", body["message"])
		assert.Empty(t, recorder.Header().Get("Warning"), "a failed list is an error, not a truncated list")
	})
}

func TestPlaylistUIDValidation(t *testing.T) {
	// The uids client-go itself refuses to place in a request path, plus the empty
	// uid that reaches the handlers from a route such as /api/playlists//items.
	invalidUIDs := map[string]string{
		"empty":                  "",
		"traversal":              "../../../etc/passwd",
		"single slash":           "a/b",
		"percent":                "abc%2Fdef",
		"dot":                    ".",
		"dot dot":                "..",
		"traversal to valid uid": "../../ffxmuj2ekxqf4d",
	}

	// Each uid-bearing operation validates before it builds a request.
	operations := map[string]struct {
		method string
		target string
		run    func(*playlistK8sHandler, *contextmodel.ReqContext)
	}{
		"getPlaylist": {
			method: http.MethodGet,
			target: "/api/playlists/uid",
			run:    func(h *playlistK8sHandler, c *contextmodel.ReqContext) { h.getPlaylist(c) },
		},
		"getPlaylistItems": {
			method: http.MethodGet,
			target: "/api/playlists/uid/items",
			run:    func(h *playlistK8sHandler, c *contextmodel.ReqContext) { h.getPlaylistItems(c) },
		},
		"deletePlaylist": {
			method: http.MethodDelete,
			target: "/api/playlists/uid",
			run:    func(h *playlistK8sHandler, c *contextmodel.ReqContext) { h.deletePlaylist(c) },
		},
		"updatePlaylist": {
			method: http.MethodPut,
			target: "/api/playlists/uid",
			run:    func(h *playlistK8sHandler, c *contextmodel.ReqContext) { h.updatePlaylist(c) },
		},
	}

	for opName, op := range operations {
		for uidName, uid := range invalidUIDs {
			t.Run(fmt.Sprintf("%s rejects %s uid with 400 in the legacy envelope", opName, uidName), func(t *testing.T) {
				transport := &playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)}
				handler := newPlaylistTestHandler(transport)
				c, recorder := newPlaylistTestContext(t, op.method, op.target, map[string]string{":uid": uid}, nil)

				op.run(handler, c)

				assert.Equal(t, http.StatusBadRequest, recorder.Code)
				body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
				assert.Equal(t, "invalid playlist uid", body["message"])
				// Nothing user-controlled is reflected back; the uid stays in the log only.
				if uid != "" {
					assert.NotContains(t, recorder.Body.String(), uid)
				}
				assert.Empty(t, transport.requests, "no request may reach the API server for an invalid uid")
			})
		}
	}

	t.Run("a well formed but missing uid still returns the API server 404", func(t *testing.T) {
		// The literal metav1.Status the API server returns for a missing playlist; the
		// rest client only turns it into a *errors.StatusError when kind/apiVersion are
		// present, which is what writeError's StatusError branch relies on.
		notFound := []byte(`{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure",` +
			`"message":"playlists.playlist.grafana.app \"does-not-exist-001\" not found",` +
			`"reason":"NotFound",` +
			`"details":{"group":"playlist.grafana.app","kind":"playlists","name":"does-not-exist-001"},` +
			`"code":404}`)

		transport := &playlistTestTransport{statusCode: http.StatusNotFound, responseBody: notFound}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists/does-not-exist-001",
			map[string]string{":uid": "does-not-exist-001"}, nil)

		handler.getPlaylist(c)

		assert.Equal(t, http.StatusNotFound, recorder.Code)
		body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
		assert.Equal(t, `playlists.playlist.grafana.app "does-not-exist-001" not found`, body["message"])
		assert.Len(t, transport.requests, 1, "a valid uid must still reach the API server")
	})

	t.Run("a valid uid is proxied and returned", func(t *testing.T) {
		stored := []byte(`{"apiVersion":"playlist.grafana.app/v1","kind":"Playlist",` +
			`"metadata":{"name":"valid-uid-001"},` +
			`"spec":{"title":"QA","interval":"5m","items":[{"type":"dashboard_by_uid","value":"dash-a"}]}}`)
		transport := &playlistTestTransport{statusCode: http.StatusOK, responseBody: stored}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists/valid-uid-001",
			map[string]string{":uid": "valid-uid-001"}, nil)

		handler.getPlaylist(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		require.Len(t, transport.requests, 1)
		dto := map[string]any{}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &dto))
		assert.Equal(t, "valid-uid-001", dto["uid"])
		assert.Equal(t, "QA", dto["name"])
	})
}

func TestPlaylistCreateUIDValidation(t *testing.T) {
	t.Run("a malformed body uid is rejected with 400 in the legacy envelope", func(t *testing.T) {
		transport := &playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodPost, "/api/playlists", nil,
			[]byte(`{"uid":"../../ffxmuj2ekxqf4d","name":"QA","interval":"5m","items":[]}`))

		handler.createPlaylist(c)

		assert.Equal(t, http.StatusBadRequest, recorder.Code)
		body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
		assert.Equal(t, "invalid playlist uid", body["message"])
		assert.Empty(t, transport.requests, "no request may reach the API server for an invalid uid")
	})

	// The relative path segments are only reachable through the body. A request path of
	// "." or ".." is resolved before the router matches, so GET /api/playlists/. is
	// served by the list route and :uid never holds either value; nothing normalises a
	// request body, so these are the cases that exercise validatePlaylistUID's
	// "."/".." rule over HTTP rather than leaving it merely present.
	for _, uid := range []string{".", ".."} {
		t.Run(fmt.Sprintf("a body uid of %q is rejected with 400 in the legacy envelope", uid), func(t *testing.T) {
			transport := &playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)}
			handler := newPlaylistTestHandler(transport)
			requestBody, err := json.Marshal(map[string]any{
				"uid":      uid,
				"name":     "QA",
				"interval": "5m",
				"items":    []any{},
			})
			require.NoError(t, err)
			c, recorder := newPlaylistTestContext(t, http.MethodPost, "/api/playlists", nil, requestBody)

			handler.createPlaylist(c)

			assert.Equal(t, http.StatusBadRequest, recorder.Code)
			body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
			assert.Equal(t, "invalid playlist uid", body["message"])
			// The rejected uid and the validator's own wording are logged, never echoed.
			assert.NotContains(t, recorder.Body.String(), uid+`"`)
			assert.NotContains(t, recorder.Body.String(), "may not be")
			assert.Empty(t, transport.requests, "no request may reach the API server for an invalid uid")
		})
	}

	t.Run("an empty body uid keeps working and is generated downstream", func(t *testing.T) {
		created := []byte(`{"apiVersion":"playlist.grafana.app/v1","kind":"Playlist",` +
			`"metadata":{"name":"generated-uid-001"},` +
			`"spec":{"title":"QA","interval":"5m","items":[]}}`)
		transport := &playlistTestTransport{statusCode: http.StatusOK, responseBody: created}
		handler := newPlaylistTestHandler(transport)
		c, recorder := newPlaylistTestContext(t, http.MethodPost, "/api/playlists", nil,
			[]byte(`{"name":"QA","interval":"5m","items":[]}`))

		handler.createPlaylist(c)

		assert.Equal(t, http.StatusOK, recorder.Code)
		require.Len(t, transport.requests, 1, "a create without a uid must still reach the API server")
		dto := map[string]any{}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &dto))
		assert.Equal(t, "generated-uid-001", dto["uid"])
	})
}

func TestPlaylistWriteError(t *testing.T) {
	t.Run("a k8s StatusError keeps its status and message", func(t *testing.T) {
		handler := newPlaylistTestHandler(&playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)})
		c, recorder := newPlaylistTestContext(t, http.MethodPost, "/api/playlists", nil, nil)

		invalid := apierrors.NewInvalid(
			schema.GroupKind{Group: "playlist.grafana.app", Kind: "Playlist"},
			"uid-001",
			field.ErrorList{field.Required(field.NewPath("spec", "items").Index(0).Child("type"), "")},
		)
		handler.writeError(c, invalid)

		assert.Equal(t, http.StatusUnprocessableEntity, recorder.Code)
		body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
		assert.Equal(t, invalid.ErrStatus.Message, body["message"])
	})

	t.Run("an errutil error keeps its own public payload", func(t *testing.T) {
		handler := newPlaylistTestHandler(&playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)})
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists/uid-001", nil, nil)

		handler.writeError(c, errutil.BadRequest("playlist.test").Errorf("errutil failure"))

		assert.Equal(t, http.StatusBadRequest, recorder.Code)
		body := map[string]any{}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		assert.Equal(t, "playlist.test", body["messageId"])
	})

	t.Run("any other error is a 500 in the legacy envelope", func(t *testing.T) {
		handler := newPlaylistTestHandler(&playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)})
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists/uid-001", nil, nil)

		// This is the shape of client-go's own pre-flight failures and of transport errors.
		handler.writeError(c, errors.New("invalid resource name \"../../admin\": [may not contain '/']"))

		assert.Equal(t, http.StatusInternalServerError, recorder.Code)
		body := requireLegacyErrorEnvelope(t, recorder.Body.Bytes())
		assert.Equal(t, "playlist request failed", body["message"])
		assert.NotContains(t, recorder.Body.String(), "core.MalformedError")
	})

	t.Run("a wrapped errutil error is still recognised", func(t *testing.T) {
		handler := newPlaylistTestHandler(&playlistTestTransport{statusCode: http.StatusOK, responseBody: []byte(`{}`)})
		c, recorder := newPlaylistTestContext(t, http.MethodGet, "/api/playlists/uid-001", nil, nil)

		wrapped := fmt.Errorf("proxying playlist: %w", errutil.NotFound("playlist.test.notFound").Errorf("missing"))
		handler.writeError(c, wrapped)

		assert.Equal(t, http.StatusNotFound, recorder.Code)
		body := map[string]any{}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		assert.Equal(t, "playlist.test.notFound", body["messageId"])
	})
}

// The validator is the single rule both the path and the body uid are held to.
func TestValidatePlaylistUID(t *testing.T) {
	t.Run("rejects what the API server client would refuse", func(t *testing.T) {
		for _, uid := range []string{"", ".", "..", "a/b", "..%2Fb", "%", "../../etc/passwd"} {
			assert.Error(t, validatePlaylistUID(uid), "uid %q must be rejected", uid)
		}
	})

	t.Run("accepts the uids the playlist API generates and stores", func(t *testing.T) {
		for _, uid := range []string{"cfxmvcnjoqbcwe", "does-not-exist-001", "a", "a.b", "a-b_c.d", "ffxmuj2ekxqf4d"} {
			assert.NoError(t, validatePlaylistUID(uid), "uid %q must be accepted", uid)
		}
	})

	t.Run("reports the offending uid and reason for the server log", func(t *testing.T) {
		err := validatePlaylistUID("../../admin")
		require.Error(t, err)
		assert.Contains(t, err.Error(), `"../../admin"`)
		assert.Contains(t, err.Error(), "may not contain '/'")
	})
}
