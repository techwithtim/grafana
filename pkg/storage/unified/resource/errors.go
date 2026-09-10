package resource

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	grpccodes "google.golang.org/grpc/codes"
	grpcstatus "google.golang.org/grpc/status"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation/field"

	claims "github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/apimachinery/utils"
	"github.com/grafana/grafana/pkg/storage/unified/resourcepb"
	"github.com/grafana/grafana/pkg/util/scheduler"
)

// Package-level errors.
var (
	ErrNotImplementedYet = errors.New("not implemented yet")

	ErrResourceAlreadyExists error = &apierrors.StatusError{
		ErrStatus: metav1.Status{
			Status:  metav1.StatusFailure,
			Reason:  metav1.StatusReasonAlreadyExists,
			Message: "the resource already exists",
			Code:    http.StatusConflict,
		},
	}
)

func NewBadRequestError(msg string) *resourcepb.ErrorResult {
	return &resourcepb.ErrorResult{
		Message: msg,
		Code:    http.StatusBadRequest,
		Reason:  string(metav1.StatusReasonBadRequest),
	}
}

// NewServiceUnavailableError reports that the server cannot answer yet, as
// opposed to the request being wrong.
func NewServiceUnavailableError(msg string) *resourcepb.ErrorResult {
	return &resourcepb.ErrorResult{
		Message: msg,
		Code:    http.StatusServiceUnavailable,
		Reason:  string(metav1.StatusReasonServiceUnavailable),
	}
}

func NewNotFoundError(key *resourcepb.ResourceKey) *resourcepb.ErrorResult {
	return &resourcepb.ErrorResult{
		Code:   http.StatusNotFound,
		Reason: string(metav1.StatusReasonNotFound),
		Details: &resourcepb.ErrorDetails{
			Group: key.Group,
			Kind:  key.Resource, // yup, resource as kind same is true in apierrors.NewNotFound()
			Name:  key.Name,
		},
	}
}

// NewInvalidNameError reports a metadata.name violation the way every other
// name violation is reported to an API client: 422 Invalid, naming the offending
// field in details.causes so the client can point at the request body.
//
// It takes a *resourcepb.ResourceKey rather than a utils.GrafanaMetaAccessor —
// unlike newInvalidFieldError and newRequiredFieldError — because request-key
// validation runs before the object body is decoded, so the key is the only
// description of the resource available at that point.
//
// The envelope is built through apierrors.NewInvalid so the message, the cause
// type and the details are byte-for-byte the shape the API server produces for
// the name violations it catches itself, instead of a second, near-identical
// shape only unified storage emits.
func NewInvalidNameError(key *resourcepb.ResourceKey, detail string) *resourcepb.ErrorResult {
	var group, resource, name string
	if key != nil {
		group, resource, name = key.Group, key.Resource, key.Name
	}
	// Kind is the resource here, which is what apierrors.NewNotFound does as
	// well (see NewNotFoundError above): the key names a resource, and the
	// kind it maps to is not known at this layer.
	return AsErrorResult(apierrors.NewInvalid(
		schema.GroupKind{Group: group, Kind: resource},
		name,
		field.ErrorList{field.Invalid(field.NewPath("metadata", "name"), name, detail)},
	))
}

// ErrorResultAsGRPCError converts an ErrorResult into a gRPC error that carries
// the result as a status detail, so its reason, HTTP code and details survive
// the transport. Returning status.Error(code, result.Message) instead discards
// all three: AsErrorResult on the receiving side then finds nothing structured
// and falls back to the transport text, which is how an invalid name reached
// clients as a reason-less 400 whose message read "rpc error: code = ...".
//
// The gRPC code is derived from the result's HTTP status. A status with no gRPC
// mapping keeps InvalidArgument, the code the request-validation call sites have
// always returned, so the wire contract does not change for them.
func ErrorResultAsGRPCError(result *resourcepb.ErrorResult) error {
	if result == nil {
		return nil
	}
	code := grpcCodeFromHTTPStatus(result.Code)
	if code == grpccodes.Unknown {
		code = grpccodes.InvalidArgument
	}
	st := grpcstatus.New(code, result.Message)
	if withDetails, err := st.WithDetails(result); err == nil {
		st = withDetails
	}
	return st.Err()
}

func NewResourceVersionExpiredError(rv int64) error {
	result := &resourcepb.ErrorResult{
		Message: fmt.Sprintf("too old resource version: %d", rv),
		Code:    http.StatusGone,
		Reason:  string(metav1.StatusReasonExpired),
	}
	st := grpcstatus.New(grpccodes.OutOfRange, result.Message)
	if withDetails, err := st.WithDetails(result); err == nil {
		st = withDetails
	}
	return st.Err()
}

func IsResourceVersionExpired(err error) bool {
	if err == nil {
		return false
	}
	if apierrors.IsResourceExpired(err) || apierrors.IsGone(err) {
		return true
	}
	if res := errorResultFromGRPCDetails(err); res != nil {
		return res.Code == http.StatusGone || res.Reason == string(metav1.StatusReasonExpired)
	}
	return false
}

// IsConflict reports whether err is a storage conflict, whether it arrived as a typed
// Kubernetes error or as a gRPC status whose ErrorResult apierrors cannot inspect.
func IsConflict(err error) bool {
	if apierrors.IsConflict(err) {
		return true
	}
	return apierrors.IsConflict(GetError(errorResultFromGRPCDetails(err)))
}

// ErrorFromResponse resolves the outcome of a unified storage call — which
// reports failure either through a transport error or through a response that
// embeds an ErrorResult — into a single error, so callers need one error
// branch. The transport error is returned untouched to keep its gRPC status,
// cancellation semantics and errors.Is/As chain intact; a response-embedded
// result is converted to a typed Kubernetes error. Callers that need an ErrorResult
// representation for status checks can convert the returned error with AsErrorResult.
// Attached or response-embedded details are preserved when available.
// Returns nil only when the call fully succeeded.
func ErrorFromResponse(respErr *resourcepb.ErrorResult, err error) error {
	if err != nil {
		return err
	}
	return GetError(respErr)
}

func errorResultFromGRPCDetails(err error) *resourcepb.ErrorResult {
	st, ok := grpcstatus.FromError(err)
	if !ok || st == nil {
		return nil
	}
	for _, detail := range st.Details() {
		if res, ok := detail.(*resourcepb.ErrorResult); ok {
			return res
		}
	}
	return nil
}

func NewTooManyRequestsError(msg string) *resourcepb.ErrorResult {
	return &resourcepb.ErrorResult{
		Message: msg,
		Code:    http.StatusTooManyRequests,
		Reason:  string(metav1.StatusReasonTooManyRequests),
	}
}

func NewConflictStatusError(group, resource, name, message string) *apierrors.StatusError {
	return apierrors.NewConflict(schema.GroupResource{
		Group:    group,
		Resource: resource,
	}, name, fmt.Errorf("%s", message))
}

func newInvalidFieldError(
	obj utils.GrafanaMetaAccessor,
	detail string,
	path string,
	morePath ...string,
) *resourcepb.ErrorResult {
	gvk := obj.GetGroupVersionKind()
	return &resourcepb.ErrorResult{
		Message: detail,
		Code:    http.StatusUnprocessableEntity,
		Reason:  string(metav1.StatusReasonInvalid),
		Details: &resourcepb.ErrorDetails{
			Name:  obj.GetName(),
			Group: gvk.Group,
			Kind:  gvk.Kind,
			Uid:   string(obj.GetUID()),
			Causes: []*resourcepb.ErrorCause{
				{
					Reason: string(field.ErrorTypeForbidden),
					Field:  field.NewPath(path, morePath...).String(),
				},
			},
		},
	}
}

func newRequiredFieldError(
	obj utils.GrafanaMetaAccessor,
	detail string,
	path string,
	morePath ...string,
) *resourcepb.ErrorResult {
	gvk := obj.GetGroupVersionKind()
	return &resourcepb.ErrorResult{
		Message: detail,
		Code:    http.StatusUnprocessableEntity,
		Reason:  string(metav1.StatusReasonInvalid),
		Details: &resourcepb.ErrorDetails{
			Name:  obj.GetName(),
			Group: gvk.Group,
			Kind:  gvk.Kind,
			Uid:   string(obj.GetUID()),
			Causes: []*resourcepb.ErrorCause{
				{
					Reason: string(field.ErrorTypeRequired),
					Field:  field.NewPath(path, morePath...).String(),
				},
			},
		},
	}
}

// AsErrorResult converts golang errors to status result errors that can be returned to a client.
// Returns the first status details entity that matches the resourcepb.ErrorResult type, if given. If multiple entries
// are given in the status details array, only the first matching one is used; all others are discarded.
func AsErrorResult(err error) *resourcepb.ErrorResult {
	if err == nil {
		return nil
	}

	// Structured results attached to a gRPC error keep their reason/code across
	// the wire, so prefer them over the generic mapping below.
	if res := errorResultFromGRPCDetails(err); res != nil {
		return res
	}

	var apistatus apierrors.APIStatus
	if errors.As(err, &apistatus) {
		s := apistatus.Status()
		res := &resourcepb.ErrorResult{
			Message: s.Message,
			Reason:  string(s.Reason),
			Code:    s.Code,
		}
		if s.Details != nil {
			res.Details = &resourcepb.ErrorDetails{
				Group:             s.Details.Group,
				Kind:              s.Details.Kind,
				Name:              s.Details.Name,
				Uid:               string(s.Details.UID),
				RetryAfterSeconds: s.Details.RetryAfterSeconds,
			}
			for _, c := range s.Details.Causes {
				res.Details.Causes = append(res.Details.Causes, &resourcepb.ErrorCause{
					Reason:  string(c.Type),
					Message: c.Message,
					Field:   c.Field,
				})
			}
		}
		return res
	}

	// A cross-namespace request is reported by authlib as a bare sentinel, and it
	// reaches this funnel wrapped by whichever layers it crossed — for the SQL
	// backend the transaction wrapper prefixes "transactional operation: ".
	// Untyped it mapped to 500, which told the client the server had broken when
	// it had in fact refused the request: a cluster-scoped list carries an empty
	// namespace, which matches no non-wildcard identity, so the first candidate
	// item fails its access check. 403 Forbidden is the answer
	// requireUserNamespace already gives for the same condition, and the message
	// is rebuilt from the sentinel so no wrapping from the layers in between is
	// disclosed. Identities entitled to read across namespaces hold the wildcard
	// namespace, which claims.NamespaceMatches accepts, so they never reach here.
	if errors.Is(err, claims.ErrNamespaceMismatch) {
		return &resourcepb.ErrorResult{
			Message: claims.ErrNamespaceMismatch.Error(),
			Code:    http.StatusForbidden,
			Reason:  string(metav1.StatusReasonForbidden),
		}
	}

	// Residual cases: the error carries no structured result at all, so the
	// envelope is derived from what the error itself says. It must still be
	// complete — Kubernetes clients classify failures by reason (every
	// apierrors.IsXxx helper reads it), so an envelope without one leaves the
	// caller unable to tell a rejected request from a broken server.
	code := int32(http.StatusInternalServerError)
	message := err.Error()

	// A bare gRPC status is what a request rejected before any structured result
	// was attached arrives as. Its own message is used rather than err.Error(),
	// which prepends the "rpc error: code = ... desc = ..." transport syntax; the
	// unwrap keeps that syntax out even when the status was wrapped on the way up.
	var grpcErr interface{ GRPCStatus() *grpcstatus.Status }
	if errors.As(err, &grpcErr) {
		if st := grpcErr.GRPCStatus(); st != nil {
			code = int32(runtime.HTTPStatusFromCode(st.Code()))
			message = st.Message()
		}
	}

	return &resourcepb.ErrorResult{
		Message: message,
		Code:    code,
		Reason:  string(reasonFromHTTPStatus(code)),
	}
}

// reasonFromHTTPStatus names the metav1 reason that belongs with an HTTP status,
// for errors that reached AsErrorResult carrying a status but no reason of their
// own. The pairs mirror the ones apimachinery itself uses when it builds a
// Status from a bare response code (apierrors.NewGenericServerResponse), so an
// envelope this funnel produces classifies the same way one built by the API
// server would. Only the message differs: the error's own message is kept,
// because it is more specific than apimachinery's generic wording.
//
// An unmapped status yields StatusReasonUnknown (the empty reason), which is
// what apimachinery reports for a status it cannot classify.
func reasonFromHTTPStatus(code int32) metav1.StatusReason {
	switch code {
	case http.StatusBadRequest:
		return metav1.StatusReasonBadRequest
	case http.StatusUnauthorized:
		return metav1.StatusReasonUnauthorized
	case http.StatusForbidden:
		return metav1.StatusReasonForbidden
	case http.StatusNotFound:
		return metav1.StatusReasonNotFound
	case http.StatusMethodNotAllowed:
		return metav1.StatusReasonMethodNotAllowed
	case http.StatusNotAcceptable:
		return metav1.StatusReasonNotAcceptable
	case http.StatusRequestTimeout:
		return metav1.StatusReasonTimeout
	case http.StatusConflict:
		return metav1.StatusReasonConflict
	case http.StatusGone:
		return metav1.StatusReasonGone
	case http.StatusRequestEntityTooLarge:
		return metav1.StatusReasonRequestEntityTooLarge
	case http.StatusUnsupportedMediaType:
		return metav1.StatusReasonUnsupportedMediaType
	case http.StatusUnprocessableEntity:
		return metav1.StatusReasonInvalid
	case http.StatusTooManyRequests:
		return metav1.StatusReasonTooManyRequests
	case http.StatusNotImplemented, http.StatusBadGateway, http.StatusInternalServerError:
		return metav1.StatusReasonInternalError
	case http.StatusServiceUnavailable:
		return metav1.StatusReasonServiceUnavailable
	case http.StatusGatewayTimeout:
		return metav1.StatusReasonTimeout
	}
	return metav1.StatusReasonUnknown
}

func GetError(res *resourcepb.ErrorResult) error {
	if res == nil {
		return nil
	}

	status := &apierrors.StatusError{ErrStatus: metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    res.Code,
		Reason:  metav1.StatusReason(res.Reason),
		Message: res.Message,
	}}
	if res.Details != nil {
		status.ErrStatus.Details = &metav1.StatusDetails{
			Group:             res.Details.Group,
			Kind:              res.Details.Kind,
			Name:              res.Details.Name,
			UID:               types.UID(res.Details.Uid),
			RetryAfterSeconds: res.Details.RetryAfterSeconds,
		}
		for _, c := range res.Details.Causes {
			status.ErrStatus.Details.Causes = append(status.ErrStatus.Details.Causes, metav1.StatusCause{
				Type:    metav1.CauseType(c.Reason),
				Message: c.Message,
				Field:   c.Field,
			})
		}
	}
	return status
}

func HandleQueueError[T any](err error, makeResp func(*resourcepb.ErrorResult) *T) (*T, error) {
	if errors.Is(err, scheduler.ErrTenantQueueFull) {
		return makeResp(NewTooManyRequestsError("tenant queue is full, please try again later")), nil
	}
	return makeResp(AsErrorResult(err)), nil
}

var (
	ErrNamespaceRequired                 = "namespace is required"
	ErrResourceVersionInvalid            = "resource version must be positive"
	ErrActionRequired                    = "action is required"
	ErrActionInvalid                     = "action is invalid: must be one of 'created', 'updated', or 'deleted'"
	ErrNameMustBeEmptyWhenNamespaceEmpty = "name must be empty when namespace is empty"
)

type ValidationError struct {
	Field string
	Value string
	Msg   string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s '%s' is invalid: %s", e.Field, e.Value, e.Msg)
}

func NewValidationError(field, value, msg string) error {
	return ValidationError{Field: field, Value: value, Msg: msg}
}

// grpcCodeFromHTTPStatus is lossy in a way runtime.HTTPStatusFromCode is not:
// several gRPC codes collapse onto the same HTTP status going out
// (AlreadyExists and Aborted both become 409, InvalidArgument /
// FailedPrecondition / OutOfRange all become 400), so coming back we pick the
// code that unified storage actually produces for that status.
// An unmapped code labels as Unknown — a signal to add a mapping, not a silent
// mislabel.
// This is just a helper to set the correct codes in metric labels
func grpcCodeFromHTTPStatus(httpCode int32) grpccodes.Code {
	switch httpCode {
	case http.StatusOK:
		return grpccodes.OK
	case http.StatusBadRequest:
		return grpccodes.InvalidArgument
	case http.StatusUnauthorized:
		return grpccodes.Unauthenticated
	case http.StatusForbidden:
		return grpccodes.PermissionDenied
	case http.StatusNotFound:
		return grpccodes.NotFound
	case http.StatusRequestTimeout:
		return grpccodes.DeadlineExceeded
	case http.StatusConflict:
		return grpccodes.AlreadyExists
	case http.StatusPreconditionFailed:
		return grpccodes.FailedPrecondition
	case http.StatusRequestedRangeNotSatisfiable:
		return grpccodes.OutOfRange
	case http.StatusUnprocessableEntity:
		return grpccodes.InvalidArgument
	case http.StatusTooManyRequests:
		return grpccodes.ResourceExhausted
	case http.StatusInternalServerError:
		return grpccodes.Internal
	case http.StatusNotImplemented:
		return grpccodes.Unimplemented
	case http.StatusServiceUnavailable:
		return grpccodes.Unavailable
	case http.StatusGatewayTimeout:
		return grpccodes.DeadlineExceeded
	case 499:
		return grpccodes.Canceled
	}

	return grpccodes.Unknown
}
