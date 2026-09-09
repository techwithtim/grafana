package playlist

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apiserver/pkg/admission"

	appsdkapiserver "github.com/grafana/grafana-app-sdk/k8s/apiserver"
	playlistv1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
)

func TestLegacyUpdateCommandToUnstructured(t *testing.T) {
	cmd := UpdatePlaylistCommand{
		UID:      "playlist-uid",
		Name:     "Test",
		Interval: "20s",
		Items: []PlaylistItem{
			{
				Type:  "dashboard_by_uid",
				Value: "xCmMwXdVz",
				Variables: map[string][]string{
					"host":    {"a", "b"},
					"cluster": {"c"},
				},
			},
			{
				// The same dashboard uid on purpose: one parameterized dashboard rotates
				// through several hosts by appearing once per variable set.
				Type:      "dashboard_by_uid",
				Value:     "xCmMwXdVz",
				Variables: map[string][]string{"host": {"z"}},
			},
			{
				// An initialized but empty map is a different input state from a nil one,
				// and it has to reach the same output.
				Type:      "dashboard_by_uid",
				Value:     "AAbbCCdd",
				Variables: map[string][]string{},
			},
			{
				Type:  "dashboard_by_tag",
				Value: "graph-ng",
			},
		},
	}

	obj := LegacyUpdateCommandToUnstructured(cmd)

	spec, ok := obj.Object["spec"].(map[string]any)
	require.True(t, ok, "spec should be a map[string]any")
	items, ok := spec["items"].([]any)
	require.True(t, ok, "spec.items should be an []any, got %T", spec["items"])
	require.Len(t, items, 4, "every command item must produce exactly one entry, in order")

	entries := make([]map[string]any, len(items))
	for i, item := range items {
		entry, ok := item.(map[string]any)
		require.True(t, ok, "spec.items[%d] should be a map[string]any, got %T", i, item)
		entries[i] = entry
	}

	t.Run("output is safe for kubernetes runtime operations", func(t *testing.T) {
		// The nested types matter as much as the values. Everything that handles an
		// Unstructured -- the dynamic client, admission, the apiserver -- walks its content
		// with runtime.DeepCopyJSONValue, which panics on a container it does not recognize
		// ([]map[string]any is one), so a shape that fails here fails in production too.
		require.NotPanics(t, func() { _ = obj.DeepCopy() })

		copied, found, err := unstructured.NestedSlice(obj.Object, "spec", "items")
		require.NoError(t, err)
		require.True(t, found)
		require.Len(t, copied, 4)

		first, ok := copied[0].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, map[string]any{
			"host":    []any{"a", "b"},
			"cluster": []any{"c"},
		}, first["variables"], "a deep copy must carry the nested variable values through unchanged")
	})

	t.Run("item with several variables", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"host":    []any{"a", "b"},
			"cluster": []any{"c"},
		}, entries[0]["variables"])

		assert.Equal(t, "dashboard_by_uid", entries[0]["type"])
		assert.Equal(t, "xCmMwXdVz", entries[0]["value"])
		assert.Len(t, entries[0], 3, "item should carry exactly type, value and variables")
	})

	t.Run("repeated dashboard uid keeps its own variables", func(t *testing.T) {
		assert.Equal(t, "dashboard_by_uid", entries[1]["type"])
		assert.Equal(t, "xCmMwXdVz", entries[1]["value"])
		assert.Equal(t, entries[0]["value"], entries[1]["value"], "the fixture must list one uid twice")
		assert.Equal(t, map[string]any{"host": []any{"z"}}, entries[1]["variables"],
			"two entries for the same dashboard must keep their own variables, in order")
		assert.Len(t, entries[1], 3)
	})

	t.Run("item with an empty variables map", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"type":  "dashboard_by_uid",
			"value": "AAbbCCdd",
		}, entries[2], "an initialized but empty map must serialize exactly as a nil one does")
		assert.NotContains(t, entries[2], "variables", "an empty map must not add a variables key")
	})

	t.Run("item without variables", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"type":  "dashboard_by_tag",
			"value": "graph-ng",
		}, entries[3], "a variable-less item must serialize exactly as it did before this field existed")
		assert.NotContains(t, entries[3], "variables", "a nil map must not add a variables key")
	})
}

func TestLegacyUpdateCommandToUnstructuredHappyPathIsUnchanged(t *testing.T) {
	// The output is asserted as a whole here, so no later change to this conversion can
	// quietly alter the object the legacy endpoints write.
	obj := LegacyUpdateCommandToUnstructured(UpdatePlaylistCommand{
		UID:      "playlist-uid",
		Name:     "Test",
		Interval: "20s",
		Items: []PlaylistItem{
			{Type: "dashboard_by_uid", Value: "xCmMwXdVz", Variables: map[string][]string{"host": {"a", "b"}}},
			{Type: "dashboard_by_tag", Value: "graph-ng"},
		},
	})
	assert.Equal(t, map[string]any{
		"metadata": map[string]any{
			"name": "playlist-uid",
		},
		"spec": map[string]any{
			"title":    "Test",
			"interval": "20s",
			"items": []any{
				map[string]any{
					"type":      "dashboard_by_uid",
					"value":     "xCmMwXdVz",
					"variables": map[string]any{"host": []any{"a", "b"}},
				},
				map[string]any{
					"type":  "dashboard_by_tag",
					"value": "graph-ng",
				},
			},
		},
	}, obj.Object)
}

func TestUnstructuredToLegacyPlaylistDTO(t *testing.T) {
	// The conversion reads spec, spec.title and spec.interval through unguarded type
	// assertions, so a fixture missing any of them panics instead of failing.
	obj := unstructured.Unstructured{
		Object: map[string]any{
			"spec": map[string]any{
				"title":    "Test",
				"interval": "20s",
				"items": []any{
					map[string]any{
						"type":  "dashboard_by_uid",
						"value": "xCmMwXdVz",
						"variables": map[string]any{
							"host":    []any{"a", "b"},
							"cluster": []any{"c"},
						},
					},
					map[string]any{
						"type":      "dashboard_by_uid",
						"value":     "xCmMwXdVz",
						"variables": map[string]any{"host": []any{"z"}},
					},
					map[string]any{
						"type":      "dashboard_by_uid",
						"value":     "AAbbCCdd",
						"variables": map[string]any{},
					},
					map[string]any{
						"type":  "dashboard_by_tag",
						"value": "graph-ng",
					},
				},
			},
		},
	}

	dto := UnstructuredToLegacyPlaylistDTO(obj)

	require.NotNil(t, dto)
	require.Len(t, dto.Items, 4, "every stored item must decode, in order")

	t.Run("item with several variables", func(t *testing.T) {
		assert.Equal(t, map[string][]string{
			"host":    {"a", "b"},
			"cluster": {"c"},
		}, dto.Items[0].Variables)

		assert.Equal(t, "dashboard_by_uid", dto.Items[0].Type)
		assert.Equal(t, "xCmMwXdVz", dto.Items[0].Value)
	})

	t.Run("repeated dashboard uid keeps its own variables", func(t *testing.T) {
		assert.Equal(t, "dashboard_by_uid", dto.Items[1].Type)
		assert.Equal(t, "xCmMwXdVz", dto.Items[1].Value)
		assert.Equal(t, dto.Items[0].Value, dto.Items[1].Value, "the fixture must list one uid twice")
		assert.Equal(t, map[string][]string{"host": {"z"}}, dto.Items[1].Variables,
			"two entries for the same dashboard must decode to their own variables, in order")
	})

	t.Run("item with an explicit empty variables map", func(t *testing.T) {
		// An empty JSON object allocates a map, which is what keeps it distinguishable from
		// the absent field below: only an absent (or null) field decodes to nil.
		require.NotNil(t, dto.Items[2].Variables, "an explicit empty object must decode to an allocated map")
		assert.Empty(t, dto.Items[2].Variables)
		assert.Equal(t, "dashboard_by_uid", dto.Items[2].Type)
		assert.Equal(t, "AAbbCCdd", dto.Items[2].Value)
	})

	t.Run("item without variables", func(t *testing.T) {
		assert.Nil(t, dto.Items[3].Variables, "an item without variables must decode to a nil map")
		assert.Equal(t, "dashboard_by_tag", dto.Items[3].Type)
		assert.Equal(t, "graph-ng", dto.Items[3].Value)
	})
}

func TestLegacyUpdateCommandToUnstructuredForwardsInvalidItemsVerbatim(t *testing.T) {
	// The deprecated /api/playlists write path proxies through this conversion to the same
	// resource API the Kubernetes-style endpoints use, so the item contract is enforced in
	// exactly one place: the admission plugin in register.go. This pins the bridge's half of
	// that arrangement -- it neither repairs nor drops an item the validator will reject, so
	// the rejection cannot be defeated by writing through the legacy surface, and there is no
	// second, drifting gate to maintain here.
	obj := LegacyUpdateCommandToUnstructured(UpdatePlaylistCommand{
		UID:      "playlist-uid",
		Name:     "Test",
		Interval: "20s",
		Items: []PlaylistItem{
			{Type: "", Value: "xCmMwXdVz"},
			{Type: "dashboard_by_uid", Value: ""},
			{Type: "dashboard_by_unicorn", Value: "x"},
			{Type: "dashboard_by_uid", Value: "xCmMwXdVz", Variables: map[string][]string{"host": {""}}},
			{Type: "dashboard_by_uid", Value: "xCmMwXdVz", Variables: map[string][]string{"": {"a"}}},
		},
	})

	spec, ok := obj.Object["spec"].(map[string]any)
	require.True(t, ok, "spec should be a map[string]any")
	items, ok := spec["items"].([]any)
	require.True(t, ok, "spec.items should be an []any, got %T", spec["items"])
	require.Len(t, items, 5, "every command item must produce exactly one entry, in order")

	assert.Equal(t, map[string]any{"type": "", "value": "xCmMwXdVz"}, items[0],
		"a missing item type must reach the resource API as the empty string, not be defaulted")
	assert.Equal(t, map[string]any{"type": "dashboard_by_uid", "value": ""}, items[1],
		"a missing item value must reach the resource API as the empty string, not be defaulted")
	assert.Equal(t, map[string]any{"type": "dashboard_by_unicorn", "value": "x"}, items[2],
		"an out-of-enum item type must be forwarded verbatim, not coerced to a known type")
	assert.Equal(t, map[string]any{
		"type":      "dashboard_by_uid",
		"value":     "xCmMwXdVz",
		"variables": map[string]any{"host": []any{""}},
	}, items[3], "an empty variable value must be forwarded, not filtered out of the list")
	assert.Equal(t, map[string]any{
		"type":      "dashboard_by_uid",
		"value":     "xCmMwXdVz",
		"variables": map[string]any{"": []any{"a"}},
	}, items[4], "an empty variable name must be forwarded, not dropped from the map")
}

// recordingAdmission stands in for the App SDK's admission handler so the wrapper's
// delegation can be observed.
type recordingAdmission struct {
	handles       bool
	admitErr      error
	validateErr   error
	admitCalls    int
	validateCalls int
}

var (
	_ admission.Interface           = (*recordingAdmission)(nil)
	_ admission.MutationInterface   = (*recordingAdmission)(nil)
	_ admission.ValidationInterface = (*recordingAdmission)(nil)
)

func (r *recordingAdmission) Handles(admission.Operation) bool { return r.handles }

func (r *recordingAdmission) Admit(context.Context, admission.Attributes, admission.ObjectInterfaces) error {
	r.admitCalls++
	return r.admitErr
}

func (r *recordingAdmission) Validate(context.Context, admission.Attributes, admission.ObjectInterfaces) error {
	r.validateCalls++
	return r.validateErr
}

// stubAppInstaller supplies only the one method AdmissionPlugin() overrides. The embedded
// interface is nil, which is safe because no other method is reached by these tests.
type stubAppInstaller struct {
	appsdkapiserver.AppInstaller
	factory admission.Factory
}

func (s *stubAppInstaller) AdmissionPlugin() admission.Factory { return s.factory }

func playlistAdmissionAttributes(obj runtime.Object, operation admission.Operation) admission.Attributes {
	name := ""
	if accessor, err := meta.Accessor(obj); err == nil {
		name = accessor.GetName()
	}
	return admission.NewAttributesRecord(
		obj,
		nil,
		playlistv1.PlaylistKind().GroupVersionKind(),
		"default",
		name,
		schema.GroupVersionResource{Group: playlistv1.APIGroup, Version: "v1", Resource: "playlists"},
		"",
		operation,
		nil,
		false,
		nil,
	)
}

func TestAppInstallerAdmissionPlugin(t *testing.T) {
	t.Run("a nil delegate factory stays nil", func(t *testing.T) {
		installer := &AppInstaller{AppInstaller: &stubAppInstaller{factory: nil}}
		assert.Nil(t, installer.AdmissionPlugin(),
			"a manifest that declares no admission must not gain a handler from the wrapper")
	})

	t.Run("a delegate construction error is surfaced", func(t *testing.T) {
		sentinel := errors.New("boom")
		installer := &AppInstaller{AppInstaller: &stubAppInstaller{
			factory: func(io.Reader) (admission.Interface, error) { return nil, sentinel },
		}}
		factory := installer.AdmissionPlugin()
		require.NotNil(t, factory)
		plugin, err := factory(nil)
		assert.Nil(t, plugin)
		assert.ErrorIs(t, err, sentinel)
	})

	t.Run("the wrapper implements every admission interface the chain looks for", func(t *testing.T) {
		delegate := &recordingAdmission{handles: true}
		installer := &AppInstaller{AppInstaller: &stubAppInstaller{
			factory: func(io.Reader) (admission.Interface, error) { return delegate, nil },
		}}
		plugin, err := installer.AdmissionPlugin()(nil)
		require.NoError(t, err)

		// The chain type-asserts for these two separately and skips a handler that does not
		// implement the one it wants, so losing either would silently disable a hook.
		assert.Implements(t, (*admission.MutationInterface)(nil), plugin)
		assert.Implements(t, (*admission.ValidationInterface)(nil), plugin)

		assert.True(t, plugin.Handles(admission.Create), "Handles must follow the delegate")
		delegate.handles = false
		assert.False(t, plugin.Handles(admission.Create), "Handles must follow the delegate")
	})
}

func TestPlaylistAdmissionValidate(t *testing.T) {
	validPlaylist := func() *playlistv1.Playlist {
		obj := &playlistv1.Playlist{}
		obj.SetName("valid-playlist")
		obj.Spec = playlistv1.PlaylistSpec{
			Title:    "Test",
			Interval: "5m",
			Items: []playlistv1.PlaylistPlaylistItem{
				{
					Type:      playlistv1.PlaylistPlaylistItemTypeDashboardByUid,
					Value:     "xCmMwXdVz",
					Variables: map[string][]string{"host": {"a", "b"}},
				},
			},
		}
		return obj
	}

	t.Run("a valid playlist reaches the delegate", func(t *testing.T) {
		sentinel := errors.New("delegate decided")
		delegate := &recordingAdmission{handles: true, validateErr: sentinel}
		plugin := &playlistAdmission{delegate: delegate}

		err := plugin.Validate(context.Background(),
			playlistAdmissionAttributes(validPlaylist(), admission.Create), nil)

		assert.ErrorIs(t, err, sentinel, "the delegate's verdict must be returned unchanged")
		assert.Equal(t, 1, delegate.validateCalls)
	})

	t.Run("an invalid playlist is rejected as Invalid before the delegate runs", func(t *testing.T) {
		delegate := &recordingAdmission{handles: true}
		plugin := &playlistAdmission{delegate: delegate}

		obj := validPlaylist()
		obj.SetName("invalid-playlist")
		obj.Spec.Items = []playlistv1.PlaylistPlaylistItem{
			{Value: "xCmMwXdVz"},
			{Type: playlistv1.PlaylistPlaylistItemTypeDashboardByUid},
			{Type: "dashboard_by_unicorn", Value: "x"},
			{
				Type:      playlistv1.PlaylistPlaylistItemTypeDashboardByUid,
				Value:     "xCmMwXdVz",
				Variables: map[string][]string{"host": nil, "cluster": {""}, "": {"a"}},
			},
		}

		err := plugin.Validate(context.Background(),
			playlistAdmissionAttributes(obj, admission.Create), nil)

		require.Error(t, err)
		assert.Equal(t, 0, delegate.validateCalls, "a rejected object must not reach the delegate")

		// Invalid is what renders as HTTP 422 with per-field causes. The SDK's own admission
		// path could only produce 403 with the causes flattened into a message, which is why
		// this wrapper exists.
		var status *apierrors.StatusError
		require.ErrorAs(t, err, &status)
		require.True(t, apierrors.IsInvalid(err), "got reason %q", status.ErrStatus.Reason)
		assert.EqualValues(t, http.StatusUnprocessableEntity, status.ErrStatus.Code)
		require.NotNil(t, status.ErrStatus.Details)
		assert.Equal(t, "invalid-playlist", status.ErrStatus.Details.Name)
		assert.Equal(t, "playlist.grafana.app", status.ErrStatus.Details.Group)
		assert.Equal(t, "Playlist", status.ErrStatus.Details.Kind)

		fields := make([]string, 0, len(status.ErrStatus.Details.Causes))
		for _, cause := range status.ErrStatus.Details.Causes {
			fields = append(fields, cause.Field)
		}
		assert.ElementsMatch(t, []string{
			"spec.items[0].type",
			"spec.items[1].value",
			"spec.items[2].type",
			`spec.items[3].variables[]`,
			`spec.items[3].variables[cluster][0]`,
			`spec.items[3].variables[host]`,
		}, fields, "every violation must arrive with its own precise field path")
	})

	t.Run("another group's resource is passed straight through", func(t *testing.T) {
		delegate := &recordingAdmission{handles: true}
		plugin := &playlistAdmission{delegate: delegate}

		other := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "example.grafana.app/v1",
			"kind":       "Example",
		}}

		require.NoError(t, plugin.Validate(context.Background(),
			playlistAdmissionAttributes(other, admission.Create), nil))
		assert.Equal(t, 1, delegate.validateCalls,
			"the chain is shared, so a non-playlist object must be a no-op for the wrapper")
	})

	t.Run("an operation without an object is passed straight through", func(t *testing.T) {
		delegate := &recordingAdmission{handles: true}
		plugin := &playlistAdmission{delegate: delegate}

		require.NoError(t, plugin.Validate(context.Background(),
			playlistAdmissionAttributes(nil, admission.Delete), nil))
		assert.Equal(t, 1, delegate.validateCalls, "a DELETE carries no object and must not panic")
	})

	t.Run("without a delegate the wrapper still enforces the contract", func(t *testing.T) {
		plugin := &playlistAdmission{}

		require.NoError(t, plugin.Validate(context.Background(),
			playlistAdmissionAttributes(validPlaylist(), admission.Create), nil))
		require.NoError(t, plugin.Admit(context.Background(),
			playlistAdmissionAttributes(validPlaylist(), admission.Create), nil))
		assert.True(t, plugin.Handles(admission.Create))
		assert.True(t, plugin.Handles(admission.Update))
		assert.False(t, plugin.Handles(admission.Delete))

		obj := validPlaylist()
		obj.Spec.Items = []playlistv1.PlaylistPlaylistItem{{Type: "dashboard_by_unicorn", Value: "x"}}
		assert.True(t, apierrors.IsInvalid(plugin.Validate(context.Background(),
			playlistAdmissionAttributes(obj, admission.Create), nil)))
	})
}

func TestPlaylistAdmissionAdmit(t *testing.T) {
	// The app's mutation hook runs through the delegate, so the wrapper must forward Admit
	// unconditionally -- it performs no mutation of its own, and nothing about a write is
	// silently normalized or repaired.
	sentinel := errors.New("delegate mutated")
	delegate := &recordingAdmission{handles: true, admitErr: sentinel}
	plugin := &playlistAdmission{delegate: delegate}

	obj := &playlistv1.Playlist{}
	obj.SetName("invalid-playlist")
	obj.Spec.Items = []playlistv1.PlaylistPlaylistItem{{Type: "dashboard_by_unicorn"}}

	err := plugin.Admit(context.Background(), playlistAdmissionAttributes(obj, admission.Create), nil)

	assert.ErrorIs(t, err, sentinel)
	assert.Equal(t, 1, delegate.admitCalls, "the app's mutation hook must keep running")
}
