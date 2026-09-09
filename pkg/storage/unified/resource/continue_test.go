package resource

import (
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana/pkg/storage/unified/resourcepb"
)

func TestContinueToken(t *testing.T) {
	t.Run("round-trip with namespace (cross-namespace query)", func(t *testing.T) {
		original := ContinueToken{
			Namespace:       "my-namespace",
			Name:            "my-resource",
			ResourceVersion: 200,
		}
		decoded, err := GetContinueToken(original.String())
		require.NoError(t, err)
		assert.Equal(t, original.Namespace, decoded.Namespace)
		assert.Equal(t, original.Name, decoded.Name)
		assert.Equal(t, original.ResourceVersion, decoded.ResourceVersion)
	})

	t.Run("round-trip without namespace (single-namespace query)", func(t *testing.T) {
		original := ContinueToken{
			Name:            "test-resource",
			ResourceVersion: 100,
		}
		decoded, err := GetContinueToken(original.String())
		require.NoError(t, err)
		assert.Equal(t, "", decoded.Namespace)
		assert.Equal(t, original.Name, decoded.Name)
		assert.Equal(t, original.ResourceVersion, decoded.ResourceVersion)
	})

	t.Run("history token (no name, uses ResourceVersion for pagination)", func(t *testing.T) {
		original := ContinueToken{
			ResourceVersion: 500,
			SortAscending:   true,
		}
		decoded, err := GetContinueToken(original.String())
		require.NoError(t, err)
		assert.Equal(t, "", decoded.Name)
		assert.Equal(t, int64(500), decoded.ResourceVersion)
		assert.True(t, decoded.SortAscending)
	})

	// A token is client-supplied, so an undecodable one is a bad request. It used
	// to come back as an untyped error, which the list path mapped to 500, and
	// the JSON failure mode leaked the encoding/json parser message.
	t.Run("rejects an undecodable token as a bad request", func(t *testing.T) {
		tokens := map[string]string{
			"invalid base64":         "not-valid-base64!",
			"valid base64, not json": "bm90LWpzb24=", // "not-json" in base64
			"valid base64, json for another type": base64.StdEncoding.EncodeToString(
				[]byte(`["not","an","object"]`)),
			"truncated json": base64.StdEncoding.EncodeToString([]byte(`{"v":`)),
			"empty token":    "",
		}

		for name, token := range tokens {
			t.Run(name, func(t *testing.T) {
				decoded, err := GetContinueToken(token)
				require.Nil(t, decoded)
				require.Error(t, err)
				require.True(t, apierrors.IsBadRequest(err), "expected BadRequest, got: %v", err)

				res := AsErrorResult(err)
				assert.Equal(t, int32(http.StatusBadRequest), res.Code)
				assert.Equal(t, string(metav1.StatusReasonBadRequest), res.Reason)
				assert.Equal(t, "invalid continue token", res.Message)

				// The parser's own text names Go types and byte offsets of an
				// internal structure; none of it may reach a client.
				for _, leak := range []string{"json", "character", "unmarshal", "ContinueToken", "base64", "rpc error:"} {
					assert.NotContains(t, res.Message, leak)
				}
			})
		}
	})
}

// A malformed continue token is a client error on every list path, so the server
// rejects it before any backend sees it: the answer must not depend on which
// backend is configured, and the previous behaviour (each backend's own decode
// failure surfacing as a 500) was the only 5xx a QA session produced.
func TestServerListRejectsMalformedContinueToken(t *testing.T) {
	const (
		group    = "playlist.grafana.app"
		resource = "playlists"
		ns       = "default"
	)

	listRequest := func(token string, limit int64) *resourcepb.ListRequest {
		return &resourcepb.ListRequest{
			Options: &resourcepb.ListOptions{Key: &resourcepb.ResourceKey{
				Group: group, Resource: resource, Namespace: ns,
			}},
			Limit:         limit,
			NextPageToken: token,
		}
	}

	ac := NewAuthzLimitedClient(newNamespaceRecordingAccessClient(), AuthzOptions{Registry: prometheus.NewRegistry()})
	srv, ctx, seedCtx := newRecordingTestServer(t, ac, ns)
	seedPlaylist(t, srv, seedCtx, ns, "aaa")
	seedPlaylist(t, srv, seedCtx, ns, "bbb")

	tokens := map[string]string{
		"not base64":           "NOT_A_TOKEN",
		"base64, but not json": base64.StdEncoding.EncodeToString([]byte("hello")),
		"truncated json":       base64.StdEncoding.EncodeToString([]byte(`{"v":`)),
	}

	for name, token := range tokens {
		t.Run(name, func(t *testing.T) {
			rsp, err := srv.List(ctx, listRequest(token, 10))
			require.NoError(t, err, "a rejected parameter is answered in the response envelope, not as a transport error")
			require.NotNil(t, rsp.Error, "the list must not succeed")

			assert.Equal(t, int32(http.StatusBadRequest), rsp.Error.Code)
			assert.Equal(t, string(metav1.StatusReasonBadRequest), rsp.Error.Reason)
			assert.Equal(t, "invalid continue token", rsp.Error.Message)
			assert.True(t, apierrors.IsBadRequest(GetError(rsp.Error)))
			// The backend wrap and the parser text both used to reach the client.
			for _, leak := range []string{"get continue token", "character", "json"} {
				assert.NotContains(t, rsp.Error.Message, leak)
			}
		})
	}

	// Rejecting malformed tokens must not cost paging: a token this server issued
	// still continues the list where the previous page stopped.
	t.Run("a token the server issued still pages", func(t *testing.T) {
		first, err := srv.List(ctx, listRequest("", 1))
		require.NoError(t, err)
		require.Nil(t, first.Error)
		require.Len(t, first.Items, 1)
		require.NotEmpty(t, first.NextPageToken, "a truncated page must offer a continue token")

		second, err := srv.List(ctx, listRequest(first.NextPageToken, 1))
		require.NoError(t, err)
		require.Nil(t, second.Error)
		require.Len(t, second.Items, 1)
		require.NotEqual(t, first.Items[0].Value, second.Items[0].Value, "the second page must continue, not restart")
	})

	// The search-backed list encodes a position differently, and that token is
	// decodable, so it must keep its own rejection rather than being swept into
	// the malformed-token answer.
	t.Run("a search-issued token is still refused on its own terms", func(t *testing.T) {
		token, err := NewSearchContinueToken([]string{"sort-value"}, 1)
		require.NoError(t, err)

		rsp, err := srv.List(ctx, listRequest(token, 10))
		require.NoError(t, err)
		require.NotNil(t, rsp.Error)
		assert.Equal(t, int32(http.StatusBadRequest), rsp.Error.Code)
		assert.Equal(t, "continue token was issued for a search-backed list", rsp.Error.Message)
	})
}
