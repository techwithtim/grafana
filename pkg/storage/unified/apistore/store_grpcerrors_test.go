package apistore

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	grpccodes "google.golang.org/grpc/codes"
	grpcstatus "google.golang.org/grpc/status"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apiserver/pkg/storage"

	claims "github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/storage/unified/resource"
	"github.com/grafana/grafana/pkg/storage/unified/resourcepb"
)

// grpcErrorWithResult builds the error shape a newer unified storage server returns: a gRPC
// status carrying the detailed ErrorResult, with no response message.
func grpcErrorWithResult(code grpccodes.Code, res *resourcepb.ErrorResult) error {
	st := grpcstatus.New(code, res.Message)
	if withDetails, err := st.WithDetails(res); err == nil {
		st = withDetails
	}
	return st.Err()
}

func testStorage(t *testing.T, client resource.ResourceClient) *Storage {
	t.Helper()
	return &Storage{
		codec:     unstructured.UnstructuredJSONScheme,
		newFunc:   func() runtime.Object { return &unstructured.Unstructured{} },
		versioner: &storage.APIObjectVersioner{},
		store:     client,
		getKey: func(string) (*resourcepb.ResourceKey, error) {
			return &resourcepb.ResourceKey{Namespace: "default", Group: "example.grafana.app", Resource: "examples", Name: "test"}, nil
		},
	}
}

func testContext(t *testing.T) context.Context {
	requester := &identity.StaticRequester{Type: claims.TypeUser, UserID: 1, OrgRole: identity.RoleAdmin, IsGrafanaAdmin: true}
	return identity.WithRequester(t.Context(), requester)
}

func testObject(t *testing.T) []byte {
	t.Helper()
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.grafana.app/v1",
		"kind":       "Example",
		"metadata": map[string]any{
			"namespace": "default",
			"name":      "test",
			"uid":       "u1",
		},
	}}
	var raw bytes.Buffer
	require.NoError(t, unstructured.UnstructuredJSONScheme.Encode(obj, &raw))
	return raw.Bytes()
}

// notFoundReadClient reports NotFound the way the newer server does: as a gRPC error with no
// ReadResponse at all.
type notFoundReadClient struct {
	resource.ResourceClient
	readErr error
	created int
}

func (c *notFoundReadClient) Read(context.Context, *resourcepb.ReadRequest, ...grpc.CallOption) (*resourcepb.ReadResponse, error) {
	return nil, c.readErr
}

func (c *notFoundReadClient) Create(context.Context, *resourcepb.CreateRequest, ...grpc.CallOption) (*resourcepb.CreateResponse, error) {
	c.created++
	return &resourcepb.CreateResponse{ResourceVersion: 1}, nil
}

func TestGuaranteedUpdateNotFoundAsGRPCError(t *testing.T) {
	notFound := grpcErrorWithResult(grpccodes.NotFound, &resourcepb.ErrorResult{Code: http.StatusNotFound, Message: "not found"})

	tryUpdate := func(runtime.Object, storage.ResponseMeta) (runtime.Object, *uint64, error) {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "example.grafana.app/v1",
			"kind":       "Example",
			"metadata":   map[string]any{"namespace": "default", "name": "test"},
		}}, nil, nil
	}

	t.Run("ignoreNotFound upserts instead of dereferencing the missing response", func(t *testing.T) {
		client := &notFoundReadClient{readErr: notFound}
		s := testStorage(t, client)

		err := s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, true, nil, tryUpdate, nil)
		require.NoError(t, err)
		require.Equal(t, 1, client.created)
	})

	t.Run("without ignoreNotFound returns NotFound", func(t *testing.T) {
		client := &notFoundReadClient{readErr: notFound}
		s := testStorage(t, client)

		err := s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, nil, tryUpdate, nil)
		require.True(t, apierrors.IsNotFound(err), "expected NotFound, got: %v", err)
		require.Equal(t, 0, client.created)
	})
}

// conflictClient fails the first update or delete with a conflict, then succeeds, so a test can
// assert the retry loop classified the conflict.
type conflictClient struct {
	resource.ResourceClient
	value    []byte
	conflict func() (*resourcepb.ErrorResult, error)
	updates  int
	deletes  int
}

func (c *conflictClient) Read(context.Context, *resourcepb.ReadRequest, ...grpc.CallOption) (*resourcepb.ReadResponse, error) {
	return &resourcepb.ReadResponse{Value: c.value, ResourceVersion: 1}, nil
}

func (c *conflictClient) Update(context.Context, *resourcepb.UpdateRequest, ...grpc.CallOption) (*resourcepb.UpdateResponse, error) {
	c.updates++
	if c.updates == 1 {
		res, err := c.conflict()
		return &resourcepb.UpdateResponse{Error: res}, err
	}
	return &resourcepb.UpdateResponse{ResourceVersion: 2}, nil
}

func (c *conflictClient) Delete(context.Context, *resourcepb.DeleteRequest, ...grpc.CallOption) (*resourcepb.DeleteResponse, error) {
	c.deletes++
	if c.deletes == 1 {
		res, err := c.conflict()
		return &resourcepb.DeleteResponse{Error: res}, err
	}
	return &resourcepb.DeleteResponse{ResourceVersion: 2}, nil
}

func TestRetriesConflictFromBothErrorShapes(t *testing.T) {
	conflicts := map[string]func() (*resourcepb.ErrorResult, error){
		"response error": func() (*resourcepb.ErrorResult, error) {
			return &resourcepb.ErrorResult{Code: http.StatusConflict, Message: "conflict"}, nil
		},
		"grpc status with details": func() (*resourcepb.ErrorResult, error) {
			return nil, grpcErrorWithResult(grpccodes.AlreadyExists, &resourcepb.ErrorResult{Code: http.StatusConflict, Message: "conflict"})
		},
	}

	for name, conflict := range conflicts {
		t.Run(name+"/GuaranteedUpdate", func(t *testing.T) {
			client := &conflictClient{value: testObject(t), conflict: conflict}
			s := testStorage(t, client)

			tryUpdate := func(in runtime.Object, _ storage.ResponseMeta) (runtime.Object, *uint64, error) {
				return in.(*unstructured.Unstructured).DeepCopy(), nil, nil
			}

			err := s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, &storage.Preconditions{}, tryUpdate, nil)
			require.NoError(t, err)
			require.Equal(t, 2, client.updates, "the conflict must be retried")
		})

		t.Run(name+"/Delete", func(t *testing.T) {
			client := &conflictClient{value: testObject(t), conflict: conflict}
			s := testStorage(t, client)

			err := s.Delete(testContext(t), "example/test", &unstructured.Unstructured{}, nil, nil, nil, storage.DeleteOptions{})
			require.NoError(t, err)
			require.Equal(t, 2, client.deletes, "the conflict must be retried")
		})
	}
}

// alwaysFailsClient returns the same failure on every attempt, so a test can drive the retry
// budget to exhaustion or assert a non-retryable error is returned immediately.
type alwaysFailsClient struct {
	resource.ResourceClient
	value   []byte
	err     error
	updates int
	deletes int
}

func (c *alwaysFailsClient) Read(context.Context, *resourcepb.ReadRequest, ...grpc.CallOption) (*resourcepb.ReadResponse, error) {
	return &resourcepb.ReadResponse{Value: c.value, ResourceVersion: 1}, nil
}

func (c *alwaysFailsClient) Update(context.Context, *resourcepb.UpdateRequest, ...grpc.CallOption) (*resourcepb.UpdateResponse, error) {
	c.updates++
	return nil, c.err
}

func (c *alwaysFailsClient) Delete(context.Context, *resourcepb.DeleteRequest, ...grpc.CallOption) (*resourcepb.DeleteResponse, error) {
	c.deletes++
	return nil, c.err
}

// requireKubernetesError asserts the storage boundary converted the error to a Kubernetes status
// error rather than leaking the raw transport error.
func requireKubernetesError(t *testing.T, err error) {
	t.Helper()
	require.Error(t, err)
	var apistatus apierrors.APIStatus
	require.ErrorAs(t, err, &apistatus, "expected a Kubernetes status error, got %T: %v", err, err)
	_, isGRPC := grpcstatus.FromError(err)
	require.False(t, isGRPC, "raw gRPC status leaked out of the storage boundary: %v", err)
}

func TestNonRetryableGRPCErrorIsConverted(t *testing.T) {
	forbidden := grpcErrorWithResult(grpccodes.PermissionDenied, &resourcepb.ErrorResult{
		Code:    http.StatusForbidden,
		Reason:  string(metav1.StatusReasonForbidden),
		Message: "forbidden",
	})

	t.Run("GuaranteedUpdate", func(t *testing.T) {
		client := &alwaysFailsClient{value: testObject(t), err: forbidden}
		s := testStorage(t, client)

		tryUpdate := func(in runtime.Object, _ storage.ResponseMeta) (runtime.Object, *uint64, error) {
			return in.(*unstructured.Unstructured).DeepCopy(), nil, nil
		}

		err := s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, &storage.Preconditions{}, tryUpdate, nil)
		require.True(t, apierrors.IsForbidden(err), "expected Forbidden, got: %v", err)
		requireKubernetesError(t, err)
		require.Equal(t, 1, client.updates, "a non-retryable error must not be retried")
	})

	t.Run("Delete", func(t *testing.T) {
		client := &alwaysFailsClient{value: testObject(t), err: forbidden}
		s := testStorage(t, client)

		err := s.Delete(testContext(t), "example/test", &unstructured.Unstructured{}, nil, nil, nil, storage.DeleteOptions{})
		require.True(t, apierrors.IsForbidden(err), "expected Forbidden, got: %v", err)
		requireKubernetesError(t, err)
		require.Equal(t, 1, client.deletes, "a non-retryable error must not be retried")
	})
}

// A name violation reaches the client boundary in one of two shapes, depending on
// how much structure the server attached, and neither may reach an API client as
// gRPC transport syntax or as an envelope without a reason.
func TestInvalidNameFromBothErrorShapes(t *testing.T) {
	const nameMsg = "name must consist of alphanumeric characters, '-', '_', ':' or '.'"

	// The shape a server that discards the structured result produces: a bare
	// status whose message is the validation text and nothing else.
	bare := grpcstatus.Error(grpccodes.InvalidArgument, nameMsg)

	// The shape a server that keeps the structured result produces: the 422
	// invalid-name envelope, carried as a status detail.
	structured := grpcErrorWithResult(grpccodes.InvalidArgument, resource.NewInvalidNameError(
		&resourcepb.ResourceKey{
			Namespace: "default", Group: "example.grafana.app", Resource: "examples", Name: "bad name here",
		}, nameMsg))

	tryUpdate := func(in runtime.Object, _ storage.ResponseMeta) (runtime.Object, *uint64, error) {
		return in.(*unstructured.Unstructured).DeepCopy(), nil, nil
	}

	t.Run("a bare status is converted, not passed through", func(t *testing.T) {
		for name, call := range map[string]func(*Storage) error{
			"GuaranteedUpdate": func(s *Storage) error {
				return s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, &storage.Preconditions{}, tryUpdate, nil)
			},
			"Delete": func(s *Storage) error {
				return s.Delete(testContext(t), "example/test", &unstructured.Unstructured{}, nil, nil, nil, storage.DeleteOptions{})
			},
		} {
			t.Run(name, func(t *testing.T) {
				client := &alwaysFailsClient{value: testObject(t), err: bare}
				err := call(testStorage(t, client))

				requireKubernetesError(t, err)
				var apistatus apierrors.APIStatus
				require.ErrorAs(t, err, &apistatus)
				st := apistatus.Status()
				require.NotEmpty(t, st.Reason, "the envelope must carry a reason a client can branch on")
				require.Equal(t, nameMsg, st.Message)
				require.NotContains(t, st.Message, "rpc error:", "gRPC transport syntax must not reach a client")
				require.Equal(t, int32(http.StatusBadRequest), st.Code)
			})
		}
	})

	t.Run("an attached invalid-name result keeps its field cause", func(t *testing.T) {
		for name, call := range map[string]func(*Storage) error{
			"GuaranteedUpdate": func(s *Storage) error {
				return s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, &storage.Preconditions{}, tryUpdate, nil)
			},
			"Delete": func(s *Storage) error {
				return s.Delete(testContext(t), "example/test", &unstructured.Unstructured{}, nil, nil, nil, storage.DeleteOptions{})
			},
		} {
			t.Run(name, func(t *testing.T) {
				client := &alwaysFailsClient{value: testObject(t), err: structured}
				err := call(testStorage(t, client))

				requireKubernetesError(t, err)
				require.True(t, apierrors.IsInvalid(err), "expected Invalid, got: %v", err)
				var apistatus apierrors.APIStatus
				require.ErrorAs(t, err, &apistatus)
				st := apistatus.Status()
				require.Equal(t, int32(http.StatusUnprocessableEntity), st.Code)
				require.Equal(t, metav1.StatusReasonInvalid, st.Reason)
				require.NotNil(t, st.Details)
				require.Len(t, st.Details.Causes, 1)
				require.Equal(t, "metadata.name", st.Details.Causes[0].Field)
				require.NotContains(t, st.Message, "rpc error:")
			})
		}
	})

	t.Run("a rejected name is never retried", func(t *testing.T) {
		for name, err := range map[string]error{"bare status": bare, "attached result": structured} {
			t.Run(name, func(t *testing.T) {
				client := &alwaysFailsClient{value: testObject(t), err: err}
				s := testStorage(t, client)

				require.Error(t, s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, &storage.Preconditions{}, tryUpdate, nil))
				require.Equal(t, 1, client.updates, "an invalid name cannot become valid by retrying")

				require.Error(t, s.Delete(testContext(t), "example/test", &unstructured.Unstructured{}, nil, nil, nil, storage.DeleteOptions{}))
				require.Equal(t, 1, client.deletes, "an invalid name cannot become valid by retrying")
			})
		}
	})
}

func TestExhaustedConflictRetriesReturnKubernetesError(t *testing.T) {
	conflict := grpcErrorWithResult(grpccodes.AlreadyExists, &resourcepb.ErrorResult{
		Code:    http.StatusConflict,
		Reason:  string(metav1.StatusReasonConflict),
		Message: "conflict",
	})

	t.Run("GuaranteedUpdate", func(t *testing.T) {
		client := &alwaysFailsClient{value: testObject(t), err: conflict}
		s := testStorage(t, client)

		tryUpdate := func(in runtime.Object, _ storage.ResponseMeta) (runtime.Object, *uint64, error) {
			return in.(*unstructured.Unstructured).DeepCopy(), nil, nil
		}

		err := s.GuaranteedUpdate(testContext(t), "example/test", &unstructured.Unstructured{}, false, &storage.Preconditions{}, tryUpdate, nil)
		require.True(t, apierrors.IsConflict(err), "expected Conflict, got: %v", err)
		requireKubernetesError(t, err)
		require.Greater(t, client.updates, 1, "the conflict must be retried before giving up")
	})

	t.Run("Delete", func(t *testing.T) {
		client := &alwaysFailsClient{value: testObject(t), err: conflict}
		s := testStorage(t, client)

		err := s.Delete(testContext(t), "example/test", &unstructured.Unstructured{}, nil, nil, nil, storage.DeleteOptions{})
		require.True(t, apierrors.IsConflict(err), "expected Conflict, got: %v", err)
		requireKubernetesError(t, err)
		require.Greater(t, client.deletes, 1, "the conflict must be retried before giving up")
	})
}
