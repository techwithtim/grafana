package resource

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/go-cmp/cmp"
	claims "github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/storage/unified/resourcepb"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/testing/protocmp"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
)

func TestErrResourceAlreadyExistsIsRecognisable(t *testing.T) {
	t.Parallel()

	require.True(t, apierrors.IsAlreadyExists(ErrResourceAlreadyExists), "ErrResourceAlreadyExists should be recognised as an AlreadyExists error")
}

func TestAsErrorResult_UnpackCorrectErrorDetails(t *testing.T) {
	st := status.New(codes.Aborted, "concurrent create")
	errDetails := resourcepb.ErrorResult{
		Message: "message",
		Reason:  "reason",
		Details: &resourcepb.ErrorDetails{
			Name:  "name",
			Group: "group",
			Kind:  "kind",
			Uid:   "uid",
			Causes: []*resourcepb.ErrorCause{
				{
					Reason: string(field.ErrorTypeNotFound),
					Field:  "field",
				},
			},
			RetryAfterSeconds: 12,
		},
		Code: http.StatusNotFound,
	}
	st, err := st.WithDetails(&errDetails)
	require.NoError(t, err)

	got := AsErrorResult(st.Err())

	// diff used as require.Equal has it's issues with Details.Causes
	diff := cmp.Diff(&errDetails, got, protocmp.Transform())
	require.Empty(t, diff)
}

func TestErrorFromResponse(t *testing.T) {
	t.Parallel()

	detailsErr := func(code int32, msg string) error {
		st, err := status.New(codes.Internal, "wrapper").WithDetails(&resourcepb.ErrorResult{Code: code, Message: msg})
		require.NoError(t, err)
		return st.Err()
	}

	respErr := &resourcepb.ErrorResult{
		Code:    http.StatusNotFound,
		Reason:  string(metav1.StatusReasonNotFound),
		Message: "from response",
	}

	t.Run("success returns nil", func(t *testing.T) {
		t.Parallel()
		require.NoError(t, ErrorFromResponse(nil, nil))
	})

	t.Run("transport error is returned unchanged", func(t *testing.T) {
		t.Parallel()
		transportErr := status.Error(codes.Unavailable, "boom")
		got := ErrorFromResponse(nil, transportErr)
		require.ErrorIs(t, got, transportErr)
		require.Equal(t, codes.Unavailable, status.Code(got))
	})

	t.Run("cancellation stays detectable", func(t *testing.T) {
		t.Parallel()
		got := ErrorFromResponse(nil, fmt.Errorf("reading blob: %w", context.Canceled))
		require.ErrorIs(t, got, context.Canceled)
	})

	t.Run("transport error takes precedence over response result", func(t *testing.T) {
		t.Parallel()
		transportErr := status.Error(codes.Unavailable, "boom")
		require.ErrorIs(t, ErrorFromResponse(respErr, transportErr), transportErr)
	})

	t.Run("response-embedded result becomes a typed api error", func(t *testing.T) {
		t.Parallel()
		got := ErrorFromResponse(respErr, nil)
		require.True(t, apierrors.IsNotFound(got))
		require.Equal(t, "from response", got.Error())
	})

	t.Run("structured view is recoverable from either representation", func(t *testing.T) {
		t.Parallel()
		fromResponse := AsErrorResult(ErrorFromResponse(respErr, nil))
		require.Equal(t, respErr.Code, fromResponse.Code)
		require.Equal(t, respErr.Reason, fromResponse.Reason)

		fromDetails := AsErrorResult(ErrorFromResponse(respErr, detailsErr(http.StatusNotFound, "from details")))
		require.Equal(t, "from details", fromDetails.Message)
	})
}

func TestNewInvalidNameError(t *testing.T) {
	t.Parallel()

	const detail = "name must consist of alphanumeric characters, '-', '_', ':' or '.'"
	key := &resourcepb.ResourceKey{
		Namespace: "default",
		Group:     "playlist.grafana.app",
		Resource:  "playlists",
		Name:      "bad name here",
	}

	res := NewInvalidNameError(key, detail)

	require.Equal(t, int32(http.StatusUnprocessableEntity), res.Code)
	require.Equal(t, string(metav1.StatusReasonInvalid), res.Reason)
	require.NotNil(t, res.Details)
	require.Equal(t, "playlist.grafana.app", res.Details.Group)
	require.Equal(t, "playlists", res.Details.Kind)
	require.Equal(t, "bad name here", res.Details.Name)
	require.Len(t, res.Details.Causes, 1)
	require.Equal(t, string(field.ErrorTypeInvalid), res.Details.Causes[0].Reason)
	require.Equal(t, "metadata.name", res.Details.Causes[0].Field)
	require.Contains(t, res.Details.Causes[0].Message, detail)
	require.Contains(t, res.Message, "metadata.name")
	require.NotContains(t, res.Message, "rpc error:")

	// What a client ultimately branches on: the envelope has to classify as
	// Invalid, the way the API server's own metadata.name rejections do.
	err := GetError(res)
	require.True(t, apierrors.IsInvalid(err), "expected Invalid, got: %v", err)
	require.False(t, apierrors.IsBadRequest(err), "an invalid name must not classify as a bad request")

	t.Run("a nil key still produces the field cause", func(t *testing.T) {
		t.Parallel()

		res := NewInvalidNameError(nil, "name may not be empty")
		require.Equal(t, int32(http.StatusUnprocessableEntity), res.Code)
		require.Equal(t, string(metav1.StatusReasonInvalid), res.Reason)
		require.Len(t, res.Details.Causes, 1)
		require.Equal(t, "metadata.name", res.Details.Causes[0].Field)
	})
}

func TestErrorResultAsGRPCError(t *testing.T) {
	t.Parallel()

	require.NoError(t, ErrorResultAsGRPCError(nil), "nil in, nil out: there is no error to report")

	t.Run("the result survives as a status detail", func(t *testing.T) {
		t.Parallel()

		invalid := NewInvalidNameError(&resourcepb.ResourceKey{
			Group: "playlist.grafana.app", Resource: "playlists", Name: "bad name here",
		}, "name is invalid")

		err := ErrorResultAsGRPCError(invalid)

		// 422 maps to InvalidArgument, which is the code these call sites
		// returned before they carried details; the wire contract is unchanged.
		require.Equal(t, codes.InvalidArgument, status.Code(err))
		require.Empty(t, cmp.Diff(invalid, AsErrorResult(err), protocmp.Transform()),
			"the round trip through gRPC must not lose reason, code or causes")
		require.NotContains(t, AsErrorResult(err).Message, "rpc error:")
	})

	t.Run("the grpc code follows the http status", func(t *testing.T) {
		t.Parallel()

		err := ErrorResultAsGRPCError(&resourcepb.ErrorResult{
			Code:    http.StatusNotFound,
			Reason:  string(metav1.StatusReasonNotFound),
			Message: "not found",
		})
		require.Equal(t, codes.NotFound, status.Code(err))
		require.True(t, apierrors.IsNotFound(GetError(AsErrorResult(err))))
	})

	t.Run("a status with no grpc mapping keeps InvalidArgument", func(t *testing.T) {
		t.Parallel()

		res := &resourcepb.ErrorResult{Code: http.StatusTeapot, Message: "unmapped"}
		err := ErrorResultAsGRPCError(res)
		require.Equal(t, codes.InvalidArgument, status.Code(err))
		require.Empty(t, cmp.Diff(res, AsErrorResult(err), protocmp.Transform()))
	})
}

// A bare gRPC status is what arrives when the rejection carried no attached
// ErrorResult. The envelope built from it must still classify — clients branch on
// reason — and must never expose gRPC transport syntax to an API client.
func TestAsErrorResultFromBareGRPCStatus(t *testing.T) {
	t.Parallel()

	const nameMsg = "name must consist of alphanumeric characters, '-', '_', ':' or '.'"

	tests := map[string]struct {
		err         error
		wantCode    int32
		wantReason  string
		wantMessage string
	}{
		"invalid argument": {
			err:         status.Error(codes.InvalidArgument, nameMsg),
			wantCode:    http.StatusBadRequest,
			wantReason:  string(metav1.StatusReasonBadRequest),
			wantMessage: nameMsg,
		},
		"wrapped invalid argument keeps the status message": {
			err:         fmt.Errorf("create failed: %w", status.Error(codes.InvalidArgument, nameMsg)),
			wantCode:    http.StatusBadRequest,
			wantReason:  string(metav1.StatusReasonBadRequest),
			wantMessage: nameMsg,
		},
		"permission denied": {
			err:         status.Error(codes.PermissionDenied, "not allowed"),
			wantCode:    http.StatusForbidden,
			wantReason:  string(metav1.StatusReasonForbidden),
			wantMessage: "not allowed",
		},
		"not found": {
			err:         status.Error(codes.NotFound, "missing"),
			wantCode:    http.StatusNotFound,
			wantReason:  string(metav1.StatusReasonNotFound),
			wantMessage: "missing",
		},
		"unavailable": {
			err:         status.Error(codes.Unavailable, "storage is down"),
			wantCode:    http.StatusServiceUnavailable,
			wantReason:  string(metav1.StatusReasonServiceUnavailable),
			wantMessage: "storage is down",
		},
		"an untyped error stays a labelled internal error": {
			err:         errors.New("boom"),
			wantCode:    http.StatusInternalServerError,
			wantReason:  string(metav1.StatusReasonInternalError),
			wantMessage: "boom",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got := AsErrorResult(tc.err)
			require.Equal(t, tc.wantCode, got.Code)
			require.Equal(t, tc.wantReason, got.Reason, "an envelope without a reason is unclassifiable")
			require.Equal(t, tc.wantMessage, got.Message)
			require.NotContains(t, got.Message, "rpc error:", "gRPC transport syntax must not reach a client")
		})
	}
}

// The typed-Kubernetes-error branch has to keep winning over the generic
// mapping: error text sanitised further down the stack is carried by a typed
// error, and both its message and its reason must pass through untouched.
func TestAsErrorResultKeepsTypedKubernetesErrors(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		err         error
		wantCode    int32
		wantReason  string
		wantMessage string
	}{
		"internal error": {
			err:         apierrors.NewInternalError(errors.New("storage failure")),
			wantCode:    http.StatusInternalServerError,
			wantReason:  string(metav1.StatusReasonInternalError),
			wantMessage: apierrors.NewInternalError(errors.New("storage failure")).Status().Message,
		},
		"wrapped bad request": {
			err:         fmt.Errorf("get continue token (%q): %w", "NOT_A_TOKEN", apierrors.NewBadRequest("invalid continue token")),
			wantCode:    http.StatusBadRequest,
			wantReason:  string(metav1.StatusReasonBadRequest),
			wantMessage: "invalid continue token",
		},
		"wrapped service unavailable": {
			err:         fmt.Errorf("transactional operation: %w", apierrors.NewServiceUnavailable("storage unavailable")),
			wantCode:    http.StatusServiceUnavailable,
			wantReason:  string(metav1.StatusReasonServiceUnavailable),
			wantMessage: "storage unavailable",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got := AsErrorResult(tc.err)
			require.Equal(t, tc.wantCode, got.Code)
			require.Equal(t, tc.wantReason, got.Reason)
			require.Equal(t, tc.wantMessage, got.Message, "the typed error's own message must survive the funnel")
		})
	}
}

// A cross-namespace request is a refusal, not a server fault. authlib reports it
// as a bare sentinel that reaches the funnel wrapped by the layers it crossed —
// the SQL transaction wrapper prefixes "transactional operation: " — and while it
// stayed untyped a cluster-scoped list answered 500.
func TestAsErrorResultNamespaceMismatch(t *testing.T) {
	t.Parallel()

	tests := map[string]error{
		"bare sentinel":                 claims.ErrNamespaceMismatch,
		"wrapped by the sql tx wrapper": fmt.Errorf("transactional operation: %w", claims.ErrNamespaceMismatch),
		"wrapped twice":                 fmt.Errorf("list failed: %w", fmt.Errorf("transactional operation: %w", claims.ErrNamespaceMismatch)),
	}

	for name, err := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got := AsErrorResult(err)
			require.Equal(t, int32(http.StatusForbidden), got.Code)
			require.Equal(t, string(metav1.StatusReasonForbidden), got.Reason)
			require.Equal(t, "namespace mismatch", got.Message, "no wrapping from the layers in between may reach the client")
			require.True(t, apierrors.IsForbidden(GetError(got)), "expected Forbidden, got: %v", GetError(got))
		})
	}

	t.Run("a typed error in the chain still wins", func(t *testing.T) {
		t.Parallel()

		// The SQL layer sanitises driver failures by returning a typed
		// Kubernetes error; that classification must not be overridden here.
		typed := apierrors.NewInternalError(errors.New("storage failure"))
		got := AsErrorResult(fmt.Errorf("transactional operation: %w: %w", typed, claims.ErrNamespaceMismatch))
		require.Equal(t, int32(http.StatusInternalServerError), got.Code)
		require.Equal(t, string(metav1.StatusReasonInternalError), got.Reason)
	})
}

// The envelope for the same condition, observed through the server: a
// cluster-scoped list (no namespace in the key) refuses a namespace-scoped
// identity with 403, and it stays a 200 with no items only while the store has
// nothing to check.
func TestClusterScopedListIsForbiddenNotServerError(t *testing.T) {
	const (
		group    = "playlist.grafana.app"
		resource = "playlists"
		ns       = "default"
	)

	clusterScopedList := func() *resourcepb.ListRequest {
		return &resourcepb.ListRequest{
			Options: &resourcepb.ListOptions{Key: &resourcepb.ResourceKey{
				Group: group, Resource: resource, // no namespace: cluster-scoped
			}},
		}
	}

	ac := NewAuthzLimitedClient(newNamespaceRecordingAccessClient(), AuthzOptions{Registry: prometheus.NewRegistry()})
	srv, ctx, seedCtx := newRecordingTestServer(t, ac, ns)

	empty, err := srv.List(ctx, clusterScopedList())
	require.NoError(t, err)
	require.Nil(t, empty.Error, "an empty store yields no candidate to check")
	require.Empty(t, empty.Items)

	seedPlaylist(t, srv, seedCtx, ns, "aaa")

	rsp, err := srv.List(ctx, clusterScopedList())
	require.NoError(t, err)
	require.NotNil(t, rsp.Error, "a namespace-scoped identity may not list across namespaces")
	require.Equal(t, int32(http.StatusForbidden), rsp.Error.Code)
	require.Equal(t, string(metav1.StatusReasonForbidden), rsp.Error.Reason)
	require.Equal(t, "namespace mismatch", rsp.Error.Message)
	require.NotContains(t, rsp.Error.Message, "transactional operation")
	require.True(t, apierrors.IsForbidden(GetError(rsp.Error)))
	require.Empty(t, rsp.Items, "a refused list returns no items")

	// A wildcard identity is entitled to read across namespaces and must be
	// unaffected: this fix classifies the refusal, it does not widen or narrow it.
	wildcard, err := srv.List(seedCtx, clusterScopedList())
	require.NoError(t, err)
	require.Nil(t, wildcard.Error)
	require.Len(t, wildcard.Items, 1)
}

func TestReasonFromHTTPStatus(t *testing.T) {
	t.Parallel()

	mapped := map[int32]metav1.StatusReason{
		http.StatusBadRequest:            metav1.StatusReasonBadRequest,
		http.StatusUnauthorized:          metav1.StatusReasonUnauthorized,
		http.StatusForbidden:             metav1.StatusReasonForbidden,
		http.StatusNotFound:              metav1.StatusReasonNotFound,
		http.StatusMethodNotAllowed:      metav1.StatusReasonMethodNotAllowed,
		http.StatusNotAcceptable:         metav1.StatusReasonNotAcceptable,
		http.StatusRequestTimeout:        metav1.StatusReasonTimeout,
		http.StatusConflict:              metav1.StatusReasonConflict,
		http.StatusGone:                  metav1.StatusReasonGone,
		http.StatusRequestEntityTooLarge: metav1.StatusReasonRequestEntityTooLarge,
		http.StatusUnsupportedMediaType:  metav1.StatusReasonUnsupportedMediaType,
		http.StatusUnprocessableEntity:   metav1.StatusReasonInvalid,
		http.StatusTooManyRequests:       metav1.StatusReasonTooManyRequests,
		http.StatusInternalServerError:   metav1.StatusReasonInternalError,
		http.StatusNotImplemented:        metav1.StatusReasonInternalError,
		http.StatusBadGateway:            metav1.StatusReasonInternalError,
		http.StatusServiceUnavailable:    metav1.StatusReasonServiceUnavailable,
		http.StatusGatewayTimeout:        metav1.StatusReasonTimeout,
	}
	for httpCode, want := range mapped {
		require.Equal(t, want, reasonFromHTTPStatus(httpCode), "http status %d", httpCode)
	}

	// An unclassifiable status reports the unknown reason, as apimachinery does.
	require.Equal(t, metav1.StatusReasonUnknown, reasonFromHTTPStatus(http.StatusTeapot))
	require.Equal(t, metav1.StatusReasonUnknown, reasonFromHTTPStatus(0))
}

func TestGRPCCodeFromHTTPStatus(t *testing.T) {
	t.Parallel()

	mapped := map[int32]codes.Code{
		http.StatusOK:                           codes.OK,
		http.StatusBadRequest:                   codes.InvalidArgument,
		http.StatusUnauthorized:                 codes.Unauthenticated,
		http.StatusForbidden:                    codes.PermissionDenied,
		http.StatusNotFound:                     codes.NotFound,
		http.StatusRequestTimeout:               codes.DeadlineExceeded,
		http.StatusConflict:                     codes.AlreadyExists,
		http.StatusPreconditionFailed:           codes.FailedPrecondition,
		http.StatusRequestedRangeNotSatisfiable: codes.OutOfRange,
		http.StatusUnprocessableEntity:          codes.InvalidArgument,
		http.StatusTooManyRequests:              codes.ResourceExhausted,
		http.StatusInternalServerError:          codes.Internal,
		http.StatusNotImplemented:               codes.Unimplemented,
		http.StatusServiceUnavailable:           codes.Unavailable,
		http.StatusGatewayTimeout:               codes.DeadlineExceeded,
		499:                                     codes.Canceled, // nginx's client-closed-request, what gRPC gateways emit for Canceled
	}
	for httpCode, want := range mapped {
		require.Equal(t, want, grpcCodeFromHTTPStatus(httpCode), "http status %d", httpCode)
	}

	// Anything unmapped labels as Unknown: a signal to add a mapping rather
	// than a silent mislabel.
	unmapped := []int32{
		0,
		-1,
		http.StatusNoContent,
		http.StatusMovedPermanently,
		http.StatusTeapot,
		http.StatusGone,
		http.StatusBadGateway,
		599,
	}
	for _, httpCode := range unmapped {
		require.Equal(t, codes.Unknown, grpcCodeFromHTTPStatus(httpCode), "http status %d", httpCode)
	}
}

func TestIsConflict(t *testing.T) {
	t.Parallel()

	grpcConflict := status.New(codes.Aborted, "conflict")
	withDetails, err := grpcConflict.WithDetails(&resourcepb.ErrorResult{Code: http.StatusConflict, Message: "conflict"})
	require.NoError(t, err)

	withReasonOnly, err := status.New(codes.Aborted, "conflict").
		WithDetails(&resourcepb.ErrorResult{Reason: string(metav1.StatusReasonConflict), Message: "conflict"})
	require.NoError(t, err)

	withOtherDetails, err := status.New(codes.NotFound, "missing").
		WithDetails(&resourcepb.ErrorResult{Code: http.StatusNotFound, Reason: string(metav1.StatusReasonNotFound)})
	require.NoError(t, err)

	tests := map[string]struct {
		err      error
		expected bool
	}{
		"nil":                         {err: nil, expected: false},
		"typed conflict":              {err: apierrors.NewConflict(schema.GroupResource{Resource: "pods"}, "foo", nil), expected: true},
		"grpc status details":         {err: withDetails.Err(), expected: true},
		"grpc status reason only":     {err: withReasonOnly.Err(), expected: true},
		"grpc status no details":      {err: grpcConflict.Err(), expected: false},
		"grpc status other details":   {err: withOtherDetails.Err(), expected: false},
		"wrapped grpc status details": {err: fmt.Errorf("update failed: %w", withDetails.Err()), expected: true},
		"unrelated error":             {err: apierrors.NewBadRequest("nope"), expected: false},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			require.Equal(t, tc.expected, IsConflict(tc.err))
		})
	}
}
