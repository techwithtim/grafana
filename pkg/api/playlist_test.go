package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/services/user"
	"github.com/grafana/grafana/pkg/web"
)

// The deprecated /api/playlists handlers proxy to the resource API through a dynamic
// client, so these tests assert on the two things that are entirely the handlers'
// own responsibility: which requests are allowed to reach the API server, and the
// shape of the error body written back. Every legacy playlist error must be
// {"message":…,"traceID":…} -- see writeError and playlistUID.

// playlistTestTransport stands in for the API server. It records how many requests
// reached it, which is how the tests below prove a malformed uid is rejected before
// any request is built, and returns one canned response.
type playlistTestTransport struct {
	statusCode   int
	responseBody []byte
	requests     []*http.Request
}

func (t *playlistTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.requests = append(t.requests, req)
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	return &http.Response{
		StatusCode: t.statusCode,
		Header:     header,
		Body:       io.NopCloser(bytes.NewReader(t.responseBody)),
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
