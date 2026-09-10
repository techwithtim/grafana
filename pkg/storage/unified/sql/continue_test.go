package sql

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana/pkg/storage/unified/resource"
)

// TestContinueTokenRoundTrip pins that a token this package issues decodes back
// to the same values, so the rejection of undecodable tokens below cannot be
// satisfied by rejecting everything.
func TestContinueTokenRoundTrip(t *testing.T) {
	original := ContinueToken{StartOffset: 42, ResourceVersion: 1234567890, SortAscending: true}

	decoded, err := GetContinueToken(original.String())
	require.NoError(t, err)
	require.Equal(t, original.StartOffset, decoded.StartOffset)
	require.Equal(t, original.ResourceVersion, decoded.ResourceVersion)
	require.Equal(t, original.SortAscending, decoded.SortAscending)
}

// TestGetContinueTokenRejectsUndecodableTokens covers the finding that a
// malformed `continue` parameter answered HTTP 500: the token is supplied by the
// client, so a token that does not decode is a bad request. It also pins that
// the parser's own message never reaches the caller — the encoding/json text
// names Go types and byte offsets of an internal structure.
func TestGetContinueTokenRejectsUndecodableTokens(t *testing.T) {
	for _, tc := range []struct {
		name  string
		token string
	}{
		{"not base64", "NOT_A_TOKEN"},
		{"base64 that is not json", "aGVsbG8="}, // "hello"
		{"base64 of a json scalar", "MTIz"},     // "123"
		{"truncated base64", "eyJvIjox"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, err := GetContinueToken(tc.token)
			require.Nil(t, token)
			require.Error(t, err)

			require.True(t, apierrors.IsBadRequest(err), "expected a bad request, got: %v", err)
			var apistatus apierrors.APIStatus
			require.ErrorAs(t, err, &apistatus)
			status := apistatus.Status()
			require.Equal(t, int32(http.StatusBadRequest), status.Code)
			require.Equal(t, metav1.StatusReasonBadRequest, status.Reason)
			require.Equal(t, "invalid continue token", status.Message)

			for _, forbidden := range []string{"json", "unmarshal", "character", "base64", "rpc error", "go struct"} {
				require.NotContains(t, strings.ToLower(status.Message), forbidden,
					"the client message must not disclose %q", forbidden)
			}
		})
	}
}

// TestContinueTokenErrorSurvivesListWrapping pins the contract the list paths in
// backend.go depend on: they wrap the decode failure with the offending token
// for diagnosis (`get continue token (%q): %w`), and the error mapping must
// still resolve that wrapped error to the typed 400 rather than to a 500 — while
// reporting the inner message, so the wrapping stays out of the response.
func TestContinueTokenErrorSurvivesListWrapping(t *testing.T) {
	_, err := GetContinueToken("NOT_A_TOKEN")
	require.Error(t, err)

	wrapped := fmt.Errorf("get continue token (%q): %w", "NOT_A_TOKEN", err)
	require.True(t, apierrors.IsBadRequest(wrapped))

	res := resource.AsErrorResult(wrapped)
	require.Equal(t, int32(http.StatusBadRequest), res.Code)
	require.Equal(t, string(metav1.StatusReasonBadRequest), res.Reason)
	require.Equal(t, "invalid continue token", res.Message)
	require.NotContains(t, res.Message, "get continue token")
}
