package resource

import (
	"encoding/base64"
	"encoding/json"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// ContinueToken represents a pagination token for list operations.
type ContinueToken struct {
	// Namespace is the namespace to continue from. Only set for cross-namespace list queries.
	Namespace string `json:"ns,omitempty"`
	// Name is the name to continue from. Required for list resources, empty for list history.
	Name string `json:"n,omitempty"`
	// ResourceVersion is the resource version for pagination.
	// For list resources: the RV the list was performed at.
	// For list history: the last seen RV for pagination.
	ResourceVersion int64 `json:"v"`
	// SortAscending indicates the sort order (used by list history).
	SortAscending bool `json:"s,omitempty"`
	// SearchAfter is a []string of sort values for search pagination.
	SearchAfter []string `json:"sa,omitempty"`
	// SearchBefore is a []string of sort values for search pagination.
	SearchBefore []string `json:"sb,omitempty"`
}

func (c ContinueToken) String() string {
	b, _ := json.Marshal(c)
	return base64.StdEncoding.EncodeToString(b)
}

// errInvalidContinueToken is returned for every undecodable token. The token is
// client-supplied, so a token that does not parse is a bad request, not a server
// fault: returning an untyped error here made the list endpoint answer 500.
//
// It is deliberately opaque. The base64 and JSON failure modes are not
// distinguished and the parser's own message is never included, because the
// encoding/json text names Go types and byte offsets of an internal structure
// the client neither controls nor should learn about. Callers that wrap this
// error keep the offending token in the wrap (see the list paths in
// sql/backend.go), and AsErrorResult reports this error's own message rather
// than the wrap, so the token stays in the Go error chain for diagnosis without
// becoming part of the client-facing envelope.
func errInvalidContinueToken() error {
	return apierrors.NewBadRequest("invalid continue token")
}

func GetContinueToken(token string) (*ContinueToken, error) {
	continueVal, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		return nil, errInvalidContinueToken()
	}

	t := &ContinueToken{}
	if err := json.Unmarshal(continueVal, t); err != nil {
		return nil, errInvalidContinueToken()
	}

	return t, nil
}

// NewSearchContinueToken encodes SearchAfter values into a continue token string.
func NewSearchContinueToken(searchAfter []string, rv int64) (string, error) {
	return ContinueToken{SearchAfter: searchAfter, ResourceVersion: rv}.String(), nil
}
